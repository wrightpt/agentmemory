import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { memoryToObservation } from "../state/memory-utils.js";
import { captureRetrievalAttribution } from "../state/provenance.js";
import { normalizeRepositoryIdentity } from "./project-relationships.js";
import type {
  Action,
  ActionEdge,
  CompressedObservation,
  Memory,
  MemoryProvider,
  RoutineRun,
  Session,
} from "../types.js";
import { recordAudit } from "./audit.js";
import {
  getSearchIndex,
  scheduleIndexSave,
  vectorIndexAddGuarded,
} from "./search.js";
import { logger } from "../logger.js";

const FLOW_COMPRESS_SYSTEM = `You are a workflow summarizer. Given a completed action chain, produce a concise summary capturing:
1. The overall goal and outcome
2. Key steps taken and their results
3. Any notable decisions or discoveries
4. Lessons learned

Output as XML:
<summary>
<goal>What was the workflow trying to achieve</goal>
<outcome>What happened</outcome>
<steps>Numbered list of key steps</steps>
<discoveries>Any new insights or discoveries</discoveries>
<lesson>What to remember for next time</lesson>
</summary>`;

interface FlowSource {
  observation: CompressedObservation;
  session: Session;
}

const MAX_FLOW_SOURCE_RESOLUTION_IDS = 256;
const MAX_FLOW_SOURCE_LOOKUPS = 4_096;

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function actionProject(action: Action): string | undefined {
  return nonEmpty(action.projectId) ?? nonEmpty(action.project);
}

function actionProjectNames(action: Action): Set<string> {
  return new Set(
    [action.projectId, action.project, ...(action.projectAliases ?? [])]
      .map(nonEmpty)
      .filter((value): value is string => value !== undefined),
  );
}

function consensus<T>(values: Array<T | undefined>): T | undefined {
  if (values.length === 0 || values.some((value) => value === undefined)) {
    return undefined;
  }
  const first = values[0] as T;
  return values.every((value) => value === first) ? first : undefined;
}

async function resolveFlowSources(
  kv: StateKV,
  actions: Action[],
): Promise<{
  sourceObservationIds: string[];
  sources: FlowSource[];
  complete: boolean;
}> {
  const sourceObservationIds = [
    ...new Set(actions.flatMap((action) => action.sourceObservationIds ?? [])),
  ].sort();
  if (sourceObservationIds.length === 0) {
    return { sourceObservationIds, sources: [], complete: false };
  }
  if (sourceObservationIds.length > MAX_FLOW_SOURCE_RESOLUTION_IDS) {
    // Preserve every source ID on the Memory, but do not perform an unbounded
    // sessions × observations lookup merely to derive a single-repo snapshot.
    return { sourceObservationIds, sources: [], complete: false };
  }

  const sessions = (await kv.list<Session>(KV.sessions)).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  if (
    sessions.length >
    Math.floor(MAX_FLOW_SOURCE_LOOKUPS / sourceObservationIds.length)
  ) {
    // Session IDs are not globally indexed by observation ID in the legacy
    // store. Bound the fallback scan so a large workstation cannot turn one
    // flow compression into sessions x observations unbounded KV traffic.
    return { sourceObservationIds, sources: [], complete: false };
  }
  const matches = new Map<string, FlowSource[]>();
  for (const session of sessions) {
    for (let offset = 0; offset < sourceObservationIds.length; offset += 32) {
      const batch = sourceObservationIds.slice(offset, offset + 32);
      const observations = await Promise.all(
        batch.map((observationId) =>
          kv
            .get<CompressedObservation>(
              KV.observations(session.id),
              observationId,
            )
            .catch(() => null),
        ),
      );
      observations.forEach((observation, index) => {
        if (!observation || !("title" in observation)) return;
        const observationId = batch[index];
        const existing = matches.get(observationId) ?? [];
        existing.push({ observation, session });
        matches.set(observationId, existing);
      });
    }
  }

  const sources: FlowSource[] = [];
  for (const observationId of sourceObservationIds) {
    const candidates = matches.get(observationId) ?? [];
    if (candidates.length === 1) sources.push(candidates[0]);
  }
  return {
    sourceObservationIds,
    sources,
    complete: sources.length === sourceObservationIds.length,
  };
}

function flowSourceIdentity(source: FlowSource): string | undefined {
  const canonicalRepoId = sourceCanonicalRepoId(source);
  if (canonicalRepoId) return `repo:${canonicalRepoId}`;
  const project = sourceProject(source);
  return project ? `legacy-project:${project}` : undefined;
}

function sourceAttributedString(
  source: FlowSource,
  observationValue: string | undefined,
  sessionValue: string | undefined,
): string | undefined {
  return nonEmpty(
    source.observation.attribution === undefined
      ? sessionValue
      : observationValue,
  );
}

function sourceCanonicalRepoId(source: FlowSource): string | undefined {
  const raw = sourceAttributedString(
    source,
    source.observation.attribution?.canonicalRepoId,
    source.session.canonicalRepoId,
  );
  return raw ? nonEmpty(normalizeRepositoryIdentity(raw)) : undefined;
}

function sourceProject(source: FlowSource): string | undefined {
  return sourceAttributedString(
    source,
    source.observation.attribution?.project,
    source.session.project,
  );
}

function flowSourceConsensus(
  sources: FlowSource[],
  read: (source: FlowSource) => string | undefined,
): string | undefined {
  return consensus(sources.map((source) => nonEmpty(read(source))));
}

type FlowMemoryContext = Pick<
  Memory,
  "project" | "sessionIds" | "sourceObservationIds" | "agentId" | "attribution"
>;

type FlowMemoryContextResult =
  | { success: true; context: FlowMemoryContext }
  | { success: false; error: string };

function resolveActionProjectScope(
  actions: Action[],
  explicitProject: string | undefined,
):
  | { success: true; project?: string; compatibleNames: Set<string> }
  | { success: false; error: string } {
  const requestedProject = nonEmpty(explicitProject);
  const evidencedActions = actions
    .map((action) => ({ action, names: actionProjectNames(action) }))
    .filter(({ names }) => names.size > 0);
  const projectIds = new Set(
    actions
      .map((action) => nonEmpty(action.projectId))
      .filter((value): value is string => value !== undefined),
  );
  if (projectIds.size > 1) {
    return {
      success: false,
      error: "flow actions have conflicting project identities",
    };
  }

  let commonNames: Set<string> | undefined;
  for (const { names } of evidencedActions) {
    commonNames = commonNames
      ? new Set([...commonNames].filter((name) => names.has(name)))
      : new Set(names);
  }
  if (evidencedActions.length > 1 && commonNames?.size === 0) {
    return {
      success: false,
      error: "flow actions have conflicting project identities",
    };
  }
  if (
    requestedProject &&
    evidencedActions.some(({ names }) => !names.has(requestedProject))
  ) {
    return {
      success: false,
      error: `requested project ${requestedProject} conflicts with flow actions`,
    };
  }

  const unanimousPrimary = consensus(actions.map(actionProject));
  const project =
    requestedProject ??
    [...projectIds][0] ??
    unanimousPrimary ??
    (commonNames?.size ? [...commonNames].sort()[0] : undefined);
  const compatibleNames = new Set(commonNames ?? []);
  if (project) compatibleNames.add(project);
  return { success: true, project, compatibleNames };
}

async function flowMemoryContext(
  kv: StateKV,
  actions: Action[],
  explicitProject: string | undefined,
): Promise<FlowMemoryContextResult> {
  const actionScope = resolveActionProjectScope(actions, explicitProject);
  if (!actionScope.success) return actionScope;

  const sourceResult = await resolveFlowSources(kv, actions);
  const sourceIdentities = sourceResult.sources.map(flowSourceIdentity);
  const knownSourceIdentities = sourceIdentities.filter(
    (identity): identity is string => identity !== undefined,
  );
  if (
    sourceResult.complete &&
    knownSourceIdentities.length > 0 &&
    knownSourceIdentities.length !== sourceIdentities.length
  ) {
    return {
      success: false,
      error: "flow sources have ambiguous repository identity",
    };
  }
  if (sourceResult.complete && new Set(knownSourceIdentities).size > 1) {
    return {
      success: false,
      error: "flow sources have conflicting repository identities",
    };
  }
  const sources = sourceResult.complete ? sourceResult.sources : [];
  const sourceProjects = new Set(
    sources
      .map(sourceProject)
      .filter((value): value is string => value !== undefined),
  );
  if (
    actionScope.project &&
    [...sourceProjects].some(
      (sourceProjectId) => !actionScope.compatibleNames.has(sourceProjectId),
    )
  ) {
    return {
      success: false,
      error: "flow source project conflicts with flow actions",
    };
  }
  const project =
    actionScope.project ??
    (sourceProjects.size === 1 ? [...sourceProjects][0] : undefined);
  const sessionIds = [
    ...new Set(sources.map((source) => source.session.id)),
  ].sort();
  const aliases = new Set<string>();
  for (const action of actions) {
    const legacyProject = nonEmpty(action.project);
    if (legacyProject && legacyProject !== project) aliases.add(legacyProject);
    for (const alias of action.projectAliases ?? []) {
      if (alias.trim()) aliases.add(alias.trim());
    }
  }
  for (const source of sources) {
    const legacyProject = sourceProject(source);
    if (legacyProject && legacyProject !== project) aliases.add(legacyProject);
    const sourceAliases =
      source.observation.attribution === undefined
        ? source.session.projectAliases
        : source.observation.attribution.projectAliases;
    for (const alias of sourceAliases ?? []) {
      if (alias.trim()) aliases.add(alias.trim());
    }
  }
  if (project) aliases.delete(project);

  const consensusSourceProject = flowSourceConsensus(sources, sourceProject);
  const actionAgentId = consensus(
    actions.map((action) => nonEmpty(action.createdBy)),
  );
  const sourceAgentId = flowSourceConsensus(sources, (source) =>
    sourceAttributedString(
      source,
      source.observation.agentId,
      source.session.agentId,
    ),
  );
  const agentId = sourceAgentId ?? actionAgentId;
  const attribution = captureRetrievalAttribution({
    project: project ?? consensusSourceProject,
    projectAliases: aliases.size > 0 ? [...aliases].sort() : undefined,
    canonicalRepoId: flowSourceConsensus(sources, sourceCanonicalRepoId),
    repoRemote: flowSourceConsensus(sources, (source) =>
      sourceAttributedString(
        source,
        source.observation.attribution?.repoRemote,
        source.session.repoRemote,
      ),
    ),
    repoRoot:
      flowSourceConsensus(sources, (source) =>
        sourceAttributedString(
          source,
          source.observation.attribution?.repoRoot,
          source.session.repoRoot,
        ),
      ) ?? consensus(actions.map((action) => nonEmpty(action.repoRoot))),
    worktree:
      flowSourceConsensus(sources, (source) =>
        sourceAttributedString(
          source,
          source.observation.attribution?.worktree,
          source.session.worktree,
        ),
      ) ?? consensus(actions.map((action) => nonEmpty(action.worktree))),
    branch:
      flowSourceConsensus(sources, (source) =>
        sourceAttributedString(
          source,
          source.observation.attribution?.branch,
          source.session.branch,
        ),
      ) ?? consensus(actions.map((action) => nonEmpty(action.branch))),
    commitSha: flowSourceConsensus(sources, (source) =>
      sourceAttributedString(
        source,
        source.observation.attribution?.commitSha,
        source.session.commitSha,
      ),
    ),
    terminalSession: flowSourceConsensus(sources, (source) =>
      sourceAttributedString(
        source,
        source.observation.attribution?.terminalSession,
        source.session.terminalSession,
      ),
    ),
    parentSession: flowSourceConsensus(sources, (source) =>
      sourceAttributedString(
        source,
        source.observation.attribution?.parentSession,
        source.session.parentSession,
      ),
    ),
    missionId: flowSourceConsensus(sources, (source) =>
      sourceAttributedString(
        source,
        source.observation.attribution?.missionId,
        source.session.missionId,
      ),
    ),
    missionTitle: flowSourceConsensus(sources, (source) =>
      sourceAttributedString(
        source,
        source.observation.attribution?.missionTitle,
        source.session.missionTitle,
      ),
    ),
    missionRole: flowSourceConsensus(sources, (source) =>
      sourceAttributedString(
        source,
        source.observation.attribution?.missionRole,
        source.session.missionRole,
      ),
    ),
  });

  return {
    success: true,
    context: {
      ...(project ? { project } : {}),
      sessionIds,
      sourceObservationIds: sourceResult.sourceObservationIds,
      ...(agentId ? { agentId } : {}),
      ...(attribution ? { attribution } : {}),
    },
  };
}

async function indexFlowMemory(memory: Memory): Promise<void> {
  try {
    getSearchIndex().add(memoryToObservation(memory));
    scheduleIndexSave();
  } catch (error) {
    logger.warn("Failed to index compressed workflow memory into BM25", {
      memId: memory.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await vectorIndexAddGuarded(
    memory.id,
    memory.sessionIds[0] ?? "memory",
    `${memory.title} ${memory.content}`,
    { kind: "memory", logId: memory.id },
  );
}

export function registerFlowCompressFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::flow-compress",
    async (data: {
      runId?: string;
      actionIds?: string[];
      project?: string;
    }) => {
      let actionsToCompress: Action[] = [];

      if (data.runId) {
        const run = await kv.get<RoutineRun>(KV.routineRuns, data.runId);
        if (!run) {
          return { success: false, error: "run not found" };
        }
        for (const id of run.actionIds) {
          const action = await kv.get<Action>(KV.actions, id);
          if (action) actionsToCompress.push(action);
        }
      } else if (data.actionIds && data.actionIds.length > 0) {
        for (const id of data.actionIds) {
          const action = await kv.get<Action>(KV.actions, id);
          if (action) actionsToCompress.push(action);
        }
      } else if (data.project) {
        const allActions = await kv.list<Action>(KV.actions);
        actionsToCompress = allActions.filter(
          (a) => a.project === data.project && a.status === "done",
        );
      } else {
        return {
          success: false,
          error: "runId, actionIds, or project is required",
        };
      }

      const doneActions = actionsToCompress.filter((a) => a.status === "done");
      if (doneActions.length === 0) {
        return {
          success: true,
          message: "No completed actions to compress",
          compressed: 0,
        };
      }

      const memoryContext = await flowMemoryContext(
        kv,
        doneActions,
        data.project,
      );
      if (!memoryContext.success) {
        return { success: false, error: memoryContext.error, compressed: 0 };
      }

      const allEdges = await kv.list<ActionEdge>(KV.actionEdges);
      const relevantIds = new Set(doneActions.map((a) => a.id));
      const relevantEdges = allEdges.filter(
        (e) =>
          relevantIds.has(e.sourceActionId) ||
          relevantIds.has(e.targetActionId),
      );

      const prompt = buildFlowPrompt(doneActions, relevantEdges);

      try {
        const response = await provider.summarize(FLOW_COMPRESS_SYSTEM, prompt);
        const summary = parseFlowSummary(response);
        const ts = new Date().toISOString();

        const memory = {
          id: generateId("mem"),
          createdAt: ts,
          updatedAt: ts,
          type: "workflow" as const,
          title: summary.goal || `Workflow: ${doneActions.length} actions`,
          content: formatSummary(summary),
          concepts: extractConcepts(doneActions),
          files: extractFiles(doneActions),
          ...memoryContext.context,
          strength: 1.0,
          version: 1,
          isLatest: true,
          metadata: {
            flowCompressed: true,
            actionCount: doneActions.length,
            actionIds: doneActions.map((a) => a.id),
          },
        };

        await kv.set(KV.memories, memory.id, memory);
        await indexFlowMemory(memory);
        await recordAudit(kv, "compress", "mem::flow-compress", [memory.id], {
          action: "compress_flow",
          flowCompressed: true,
          actionCount: doneActions.length,
          project: data.project,
        });

        return {
          success: true,
          compressed: doneActions.length,
          memoryId: memory.id,
          summary,
        };
      } catch (err) {
        return {
          success: false,
          error: `compression failed: ${String(err)}`,
          compressed: 0,
        };
      }
    },
  );
}

function buildFlowPrompt(actions: Action[], edges: ActionEdge[]): string {
  const lines: string[] = ["## Completed Action Chain\n"];

  const sorted = [...actions].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  for (const action of sorted) {
    lines.push(`### ${action.title}`);
    if (action.description) lines.push(action.description);
    if (action.result) lines.push(`Result: ${action.result}`);
    lines.push(
      `Priority: ${action.priority}, Tags: ${(action.tags ?? []).join(", ")}`,
    );
    lines.push("");
  }

  if (edges.length > 0) {
    lines.push("## Dependencies");
    for (const edge of edges) {
      lines.push(
        `- ${edge.sourceActionId} --${edge.type}--> ${edge.targetActionId}`,
      );
    }
  }

  return lines.join("\n");
}

function parseFlowSummary(response: string): {
  goal: string;
  outcome: string;
  steps: string;
  discoveries: string;
  lesson: string;
} {
  const extract = (tag: string): string => {
    const match = response.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return match ? match[1].trim() : "";
  };
  return {
    goal: extract("goal"),
    outcome: extract("outcome"),
    steps: extract("steps"),
    discoveries: extract("discoveries"),
    lesson: extract("lesson"),
  };
}

function formatSummary(s: {
  goal: string;
  outcome: string;
  steps: string;
  discoveries: string;
  lesson: string;
}): string {
  const parts: string[] = [];
  if (s.goal) parts.push(`Goal: ${s.goal}`);
  if (s.outcome) parts.push(`Outcome: ${s.outcome}`);
  if (s.steps) parts.push(`Steps: ${s.steps}`);
  if (s.discoveries) parts.push(`Discoveries: ${s.discoveries}`);
  if (s.lesson) parts.push(`Lesson: ${s.lesson}`);
  return parts.join("\n\n");
}

function extractConcepts(actions: Action[]): string[] {
  const concepts = new Set<string>();
  for (const a of actions) {
    for (const tag of a.tags ?? []) {
      if (!tag.startsWith("routine:")) concepts.add(tag);
    }
  }
  return Array.from(concepts);
}

function extractFiles(actions: Action[]): string[] {
  const files = new Set<string>();
  for (const a of actions) {
    if (a.metadata && typeof a.metadata === "object") {
      const meta = a.metadata as Record<string, unknown>;
      if (Array.isArray(meta.files)) {
        for (const f of meta.files) {
          if (typeof f === "string") files.add(f);
        }
      }
    }
  }
  return Array.from(files);
}
