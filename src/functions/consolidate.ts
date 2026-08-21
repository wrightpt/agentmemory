import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  Memory,
  Session,
  MemoryProvider,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { memoryToObservation } from "../state/memory-utils.js";
import { recordAudit } from "./audit.js";
import { captureRetrievalAttribution } from "../state/provenance.js";
import { normalizeRepositoryIdentity } from "./project-relationships.js";
import {
  getSearchIndex,
  scheduleIndexSave,
  vectorIndexAddGuarded,
  vectorIndexRemove,
} from "./search.js";

const CONSOLIDATION_SYSTEM = `You are a memory consolidation engine. Given a set of related observations from coding sessions, synthesize them into a single long-term memory.

Output XML:
<memory>
  <type>pattern|preference|architecture|bug|workflow|fact</type>
  <title>Concise memory title (max 80 chars)</title>
  <content>2-4 sentence description of the learned insight</content>
  <concepts>
    <concept>key term</concept>
  </concepts>
  <files>
    <file>relevant/file/path</file>
  </files>
  <strength>1-10 how confident/important this memory is</strength>
</memory>`;

import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { logger } from "../logger.js";

type ConsolidationObservation = CompressedObservation & { sid: string };

interface ConsolidationScope {
  key: string;
  canonicalRepoId?: string;
  project?: string;
}

function normalizedCanonicalRepoId(
  value: string | undefined,
): string | undefined {
  if (!value?.trim()) return undefined;
  return normalizeRepositoryIdentity(value);
}

function sourceScope(
  observation: ConsolidationObservation,
  session: Session | undefined,
): ConsolidationScope {
  const canonicalRepoId = normalizedCanonicalRepoId(
    observation.attribution === undefined
      ? session?.canonicalRepoId
      : observation.attribution.canonicalRepoId,
  );
  if (canonicalRepoId) {
    return { key: `repo:${canonicalRepoId}`, canonicalRepoId };
  }
  const project = attributedString(
    observation,
    observation.attribution?.project,
    session?.project,
  );
  return {
    key: `legacy-project:${project ?? "unattributed"}`,
    ...(project ? { project } : {}),
  };
}

function consensusString(
  rows: ConsolidationObservation[],
  sessionsById: Map<string, Session>,
  read: (
    observation: ConsolidationObservation,
    session: Session | undefined,
  ) => string | undefined,
): string | undefined {
  const values = rows.map((row) =>
    read(row, sessionsById.get(row.sid))?.trim(),
  );
  if (values.some((value) => !value)) return undefined;
  const unique = new Set(values as string[]);
  return unique.size === 1 ? [...unique][0] : undefined;
}

function attributedString(
  observation: ConsolidationObservation,
  observationValue: string | undefined,
  sessionValue: string | undefined,
): string | undefined {
  const value =
    observation.attribution === undefined ? sessionValue : observationValue;
  return value?.trim() || undefined;
}

function consolidatedAttribution(
  rows: ConsolidationObservation[],
  sessionsById: Map<string, Session>,
  scope: ConsolidationScope,
  explicitProject?: string,
) {
  const aliases = new Set<string>();
  for (const row of rows) {
    const session = sessionsById.get(row.sid);
    const sourceAliases =
      row.attribution === undefined
        ? session?.projectAliases
        : row.attribution.projectAliases;
    for (const alias of sourceAliases ?? []) {
      if (alias.trim()) aliases.add(alias.trim());
    }
  }
  const project =
    explicitProject ??
    scope.project ??
    consensusString(rows, sessionsById, (row, session) =>
      attributedString(row, row.attribution?.project, session?.project),
    );
  if (project) aliases.delete(project);

  return captureRetrievalAttribution({
    project,
    projectAliases: aliases.size > 0 ? [...aliases].sort() : undefined,
    canonicalRepoId: scope.canonicalRepoId,
    repoRemote: consensusString(rows, sessionsById, (row, session) =>
      attributedString(row, row.attribution?.repoRemote, session?.repoRemote),
    ),
    repoRoot: consensusString(rows, sessionsById, (row, session) =>
      attributedString(row, row.attribution?.repoRoot, session?.repoRoot),
    ),
    worktree: consensusString(rows, sessionsById, (row, session) =>
      attributedString(row, row.attribution?.worktree, session?.worktree),
    ),
    branch: consensusString(rows, sessionsById, (row, session) =>
      attributedString(row, row.attribution?.branch, session?.branch),
    ),
    commitSha: consensusString(rows, sessionsById, (row, session) =>
      attributedString(row, row.attribution?.commitSha, session?.commitSha),
    ),
    terminalSession: consensusString(rows, sessionsById, (row, session) =>
      attributedString(
        row,
        row.attribution?.terminalSession,
        session?.terminalSession,
      ),
    ),
    parentSession: consensusString(rows, sessionsById, (row, session) =>
      attributedString(
        row,
        row.attribution?.parentSession,
        session?.parentSession,
      ),
    ),
    missionId: consensusString(rows, sessionsById, (row, session) =>
      attributedString(row, row.attribution?.missionId, session?.missionId),
    ),
    missionTitle: consensusString(rows, sessionsById, (row, session) =>
      attributedString(
        row,
        row.attribution?.missionTitle,
        session?.missionTitle,
      ),
    ),
    missionRole: consensusString(rows, sessionsById, (row, session) =>
      attributedString(row, row.attribution?.missionRole, session?.missionRole),
    ),
  });
}

function consolidatedAgentId(
  rows: ConsolidationObservation[],
  sessionsById: Map<string, Session>,
): string | undefined {
  return consensusString(rows, sessionsById, (row, session) =>
    attributedString(row, row.agentId, session?.agentId),
  );
}

type CanonicalEvidence =
  | { kind: "known"; canonicalRepoId: string }
  | { kind: "ambiguous" }
  | { kind: "absent" };

function memoryCanonicalEvidence(
  memory: Memory,
  sessionsById: Map<string, Session>,
): CanonicalEvidence {
  const direct = normalizedCanonicalRepoId(memory.attribution?.canonicalRepoId);
  if (direct) return { kind: "known", canonicalRepoId: direct };
  if (memory.attribution !== undefined) return { kind: "absent" };
  const sessionRepoIds = new Set(
    (memory.sessionIds ?? [])
      .map((sessionId) =>
        normalizedCanonicalRepoId(sessionsById.get(sessionId)?.canonicalRepoId),
      )
      .filter((repoId): repoId is string => Boolean(repoId)),
  );
  if (sessionRepoIds.size === 1) {
    return { kind: "known", canonicalRepoId: [...sessionRepoIds][0] };
  }
  return sessionRepoIds.size > 1 ? { kind: "ambiguous" } : { kind: "absent" };
}

function canEvolveMemory(
  memory: Memory,
  incomingScope: ConsolidationScope,
  scopedProject: string | undefined,
  sessionsById: Map<string, Session>,
): boolean {
  const existing = memoryCanonicalEvidence(memory, sessionsById);
  if (incomingScope.canonicalRepoId || existing.kind !== "absent") {
    return Boolean(
      incomingScope.canonicalRepoId &&
      existing.kind === "known" &&
      incomingScope.canonicalRepoId === existing.canonicalRepoId,
    );
  }
  // Legacy rows with no canonical evidence keep the historical project
  // fallback only when both sides carry the same explicit project identity.
  // A missing identity on either side is ambiguous and must not authorize a
  // destructive evolution.
  const incomingProject = scopedProject ?? incomingScope.project;
  return Boolean(
    incomingProject && memory.project && memory.project === incomingProject,
  );
}

async function indexDurableMemory(memory: Memory): Promise<void> {
  try {
    getSearchIndex().add(memoryToObservation(memory));
    scheduleIndexSave();
  } catch (error) {
    logger.warn("Failed to index consolidated memory into BM25", {
      memId: memory.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await vectorIndexAddGuarded(
    memory.id,
    memory.sessionIds?.[0] ?? "memory",
    `${memory.title} ${memory.content}`,
    { kind: "memory", logId: memory.id },
  );
}

function parseMemoryXml(
  xml: string,
  sessionIds: string[],
): Omit<Memory, "id" | "createdAt" | "updatedAt"> | null {
  const type = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  const content = getXmlTag(xml, "content");
  if (!type || !title || !content) return null;

  const validTypes = new Set([
    "pattern",
    "preference",
    "architecture",
    "bug",
    "workflow",
    "fact",
  ]);

  return {
    type: (validTypes.has(type) ? type : "fact") as Memory["type"],
    title,
    content,
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    sessionIds,
    strength: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "strength") || "5", 10) || 5),
    ),
    version: 1,
    isLatest: true,
  };
}

export function registerConsolidateFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction(
    "mem::consolidate",
    async (data: { project?: string; minObservations?: number }) => {
      const minObs = data.minObservations ?? 10;

      const sessions = await kv.list<Session>(KV.sessions);
      const sessionsById = new Map(
        sessions.map((session) => [session.id, session]),
      );
      const filtered = data.project
        ? sessions.filter((s) => s.project === data.project)
        : sessions;

      const allObs: ConsolidationObservation[] = [];
      const obsPerSession: CompressedObservation[][] = [];
      for (let batch = 0; batch < filtered.length; batch += 10) {
        const chunk = filtered.slice(batch, batch + 10);
        const results = await Promise.all(
          chunk.map((s) =>
            kv
              .list<CompressedObservation>(KV.observations(s.id))
              .catch(() => [] as CompressedObservation[]),
          ),
        );
        obsPerSession.push(...results);
      }
      for (let i = 0; i < filtered.length; i++) {
        for (const obs of obsPerSession[i]) {
          if (obs.title && obs.importance >= 5) {
            allObs.push({ ...obs, sid: filtered[i].id });
          }
        }
      }

      if (allObs.length < minObs) {
        return { consolidated: 0, reason: "insufficient_observations" };
      }

      const conceptGroups = new Map<
        string,
        {
          concept: string;
          scope: ConsolidationScope;
          observations: typeof allObs;
        }
      >();
      for (const obs of allObs) {
        const scope = sourceScope(obs, sessionsById.get(obs.sid));
        for (const concept of obs.concepts) {
          const normalizedConcept = concept.toLowerCase();
          const key = `${normalizedConcept}\u0000${scope.key}`;
          if (!conceptGroups.has(key)) {
            conceptGroups.set(key, {
              concept: normalizedConcept,
              scope,
              observations: [],
            });
          }
          conceptGroups.get(key)!.observations.push(obs);
        }
      }

      let consolidated = 0;
      const existingMemories = (await kv.list<Memory>(KV.memories)).sort(
        (a, b) => a.id.localeCompare(b.id),
      );
      const existingTitles = new Set(
        existingMemories.map((m) => m.title.toLowerCase()),
      );

      const MAX_LLM_CALLS = 10;
      let llmCallCount = 0;

      const sortedGroups = [...conceptGroups.values()]
        .filter((group) => group.observations.length >= 3)
        .sort(
          (a, b) =>
            b.observations.length - a.observations.length ||
            a.concept.localeCompare(b.concept) ||
            a.scope.key.localeCompare(b.scope.key),
        );

      for (const { concept, scope, observations: obsGroup } of sortedGroups) {
        if (llmCallCount >= MAX_LLM_CALLS) break;

        const top = obsGroup
          .slice()
          .sort(
            (a, b) => b.importance - a.importance || a.id.localeCompare(b.id),
          )
          .slice(0, 8);
        const sessionIds = [...new Set(top.map((o) => o.sid))];

        const prompt = top
          .map(
            (o) =>
              `[${o.type}] ${o.title}\n${o.narrative}\nFiles: ${o.files.join(", ")}\nImportance: ${o.importance}`,
          )
          .join("\n\n");

        try {
          const response = await Promise.race([
            provider.compress(
              CONSOLIDATION_SYSTEM,
              `Concept: "${concept}"\n\nObservations:\n${prompt}`,
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("compress timeout")), 30_000),
            ),
          ]);
          llmCallCount++;
          const parsed = parseMemoryXml(response, sessionIds);
          if (!parsed) continue;

          const now = new Date().toISOString();
          const obsIds = [...new Set(top.map((o) => o.id))];
          const scopedProject =
            typeof data.project === "string" && data.project.trim().length > 0
              ? data.project.trim()
              : undefined;
          const attribution = consolidatedAttribution(
            top,
            sessionsById,
            scope,
            scopedProject,
          );
          const agentId = consolidatedAgentId(top, sessionsById);

          // Canonical repository evidence is authoritative even for an
          // unscoped/background run. Legacy project identity is used only when
          // both sides lack canonical evidence and explicitly agree.
          const existingMatch = existingMemories.find(
            (m) =>
              m.isLatest !== false &&
              m.title.toLowerCase() === parsed.title.toLowerCase() &&
              canEvolveMemory(m, scope, scopedProject, sessionsById),
          );

          if (existingMatch) {
            existingMatch.isLatest = false;
            await kv.set(KV.memories, existingMatch.id, existingMatch);
            getSearchIndex().remove(existingMatch.id);
            await vectorIndexRemove(existingMatch.id);
            scheduleIndexSave();
            await recordAudit(
              kv,
              "evolve",
              "mem::consolidate",
              [existingMatch.id],
              {
                action: "mark_non_latest",
                concept,
              },
            );

            const evolved: Memory = {
              id: generateId("mem"),
              createdAt: now,
              updatedAt: now,
              ...parsed,
              version: (existingMatch.version || 1) + 1,
              parentId: existingMatch.id,
              supersedes: [
                existingMatch.id,
                ...(existingMatch.supersedes || []),
              ],
              sourceObservationIds: obsIds,
              isLatest: true,
              ...(agentId ? { agentId } : {}),
              ...(scopedProject !== undefined && { project: scopedProject }),
              ...(attribution ? { attribution } : {}),
            };
            await kv.set(KV.memories, evolved.id, evolved);
            await indexDurableMemory(evolved);
            await recordAudit(kv, "evolve", "mem::consolidate", [evolved.id], {
              action: "evolve_memory",
              oldId: existingMatch.id,
              newId: evolved.id,
              concept,
            });
            existingTitles.add(evolved.title.toLowerCase());
            consolidated++;
          } else {
            const memory: Memory = {
              id: generateId("mem"),
              createdAt: now,
              updatedAt: now,
              ...parsed,
              sourceObservationIds: obsIds,
              version: 1,
              isLatest: true,
              ...(agentId ? { agentId } : {}),
              ...(scopedProject !== undefined && { project: scopedProject }),
              ...(attribution ? { attribution } : {}),
            };
            await kv.set(KV.memories, memory.id, memory);
            await indexDurableMemory(memory);
            await recordAudit(kv, "remember", "mem::consolidate", [memory.id], {
              action: "create_memory",
              concept,
            });
            existingTitles.add(memory.title.toLowerCase());
            consolidated++;
          }
        } catch (err) {
          logger.warn("Consolidation failed for concept", {
            concept,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info("Consolidation complete", {
        consolidated,
        totalObs: allObs.length,
      });
      return { consolidated, totalObservations: allObs.length };
    },
  );
}
