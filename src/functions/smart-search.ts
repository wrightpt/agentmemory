import type { ISdk } from "iii-sdk";
import type {
  CompactLessonResult,
  CompactSearchResult,
  CompressedObservation,
  HybridSearchResult,
  Memory,
  RetrievalScope,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAccessBatch } from "./access-tracker.js";
import {
  getAgentId,
  isAgentScopeIsolated,
  getFollowupWindowSeconds,
} from "../config.js";
import { logger } from "../logger.js";
import { getCounters } from "../telemetry/setup.js";
import type { LessonAccessContext } from "./lesson-access.js";
import type { CompactRetrievedLesson } from "./lesson-retrieval.js";
import type { RetrievalPolicyContext } from "../state/retrieval-policy.js";
import {
  applyRetrievalPolicy,
  retrievalScopeMultiplier,
} from "../state/retrieval-policy.js";
import {
  compactRetrievalProvenance,
  publicRetrievalObservation,
  resolveRetrievalProvenance,
} from "../state/provenance.js";
import { memoryToObservation } from "../state/memory-utils.js";
import {
  normalizeRepositoryIdentity,
  repositoryRelationshipIdentityScope,
} from "./project-relationships.js";

// #771: smart-search followup-rate diagnostic. Stored per session as
// the most recent search payload, used to detect whether the next
// search inside the window had a disjoint result set. sessionId is
// duplicated into the row so the hourly sweep can delete by it
// (StateKV.list returns values only).
export interface RecentSearch {
  sessionId: string;
  query: string;
  resultIds: string[];
  at: number;
}

// Module-scope counter mirror so `mem::diagnostic::followup-stats` can
// read the rate back without going through the OTEL collector. The
// OTEL counter is still the canonical export; this is an in-process
// convenience for `agentmemory status` + tests.
const followupStats = {
  followupWithinWindow: 0,
  agentInitiatedSearches: 0,
};

// Tracks the in-flight detection promises so tests (and shutdown
// flushes) can wait for all queued lock bodies to drain. The Set adds
// when a detection is queued and removes when it settles; size === 0
// means no pending detections.
const pendingFollowups = new Set<Promise<void>>();

export function getFollowupStats(): {
  followupWithinWindow: number;
  agentInitiatedSearches: number;
  rate: number;
} {
  const total = followupStats.agentInitiatedSearches;
  return {
    ...followupStats,
    rate: total > 0 ? followupStats.followupWithinWindow / total : 0,
  };
}

export async function flushPendingFollowups(): Promise<void> {
  // Snapshot the current pending set; new detections queued after the
  // snapshot run in a fresh batch.
  await Promise.all(Array.from(pendingFollowups));
}

export function resetFollowupStatsForTests(): void {
  followupStats.followupWithinWindow = 0;
  followupStats.agentInitiatedSearches = 0;
}

export function registerSmartSearchFunction(
  sdk: ISdk,
  kv: StateKV,
  searchFn: (
    query: string,
    limit: number,
    context?: RetrievalPolicyContext,
  ) => Promise<HybridSearchResult[]>,
): void {
  sdk.registerFunction("mem::smart-search",
    async (data: {
      query?: string;
      expandIds?: Array<string | { obsId: string; sessionId: string }>;
      limit?: number;
      project?: string;
      includeLessons?: boolean;
      // optional per-call agent filter for runtimes routing many
      // roles through one server. "*" opts out of the env-default
      // scope and returns hits from every agent.
      agentId?: string;
      // #771: session anchor for the followup-rate diagnostic. The
      // API trigger fills this from req.body / headers; direct
      // sdk.trigger callers can pass it explicitly.
      sessionId?: string;
      // #771: marks viewer-originated searches so the diagnostic
      // ignores them — only agent-initiated re-queries should count.
      source?: string;
      accessContext?: LessonAccessContext;
      currentProject?: string;
      currentRepo?: string;
      missionId?: string;
      includeRelatedProjects?: boolean;
      relatedProjects?: string[];
      includeGlobal?: boolean;
      includeCrossRepo?: boolean;
      currentFiles?: string[];
    }) => {

      // Compute the agent filter once, up front. Both the expandIds
      // branch and the hybrid-search branch consult it — otherwise
      // expandIds becomes a cross-agent leak (#554 follow-up).
      //
      // #817 follow-up: fail-closed when isolated mode is on AND no
      // agent id is resolvable from any source. Silently letting
      // filterAgentId fall through to `undefined` would be the same
      // cross-agent leak this filter is meant to prevent.
      const isolated = isAgentScopeIsolated();
      const explicitAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId.trim()
          : undefined;
      const wildcardAgent = explicitAgentId === "*";
      const envAgentId = isolated ? getAgentId() : undefined;
      const filterAgentId = wildcardAgent
        ? undefined
        : explicitAgentId ?? envAgentId;
      if (
        isolated &&
        !wildcardAgent &&
        !explicitAgentId &&
        !envAgentId
      ) {
        throw new Error(
          "mem::smart-search: AGENTMEMORY_AGENT_SCOPE=isolated is set but " +
            "no agent id is available (env AGENT_ID unset and no explicit " +
            "agentId in the call). Refusing to read cross-agent rows. " +
            'Pass agentId: "*" to opt in to a wildcard read.',
        );
      }

      const retrievalContext = await resolveRetrievalContext(kv, data, filterAgentId);

      if (data.expandIds && data.expandIds.length > 0) {
        const raw = data.expandIds.slice(0, 20);
        const items = raw.map((entry) => {
          if (typeof entry === "string") return { obsId: entry, sessionId: undefined as string | undefined };
          if (entry && typeof entry === "object" && typeof (entry as any).obsId === "string") {
            return { obsId: (entry as any).obsId, sessionId: (entry as any).sessionId as string | undefined };
          }
          return null;
        }).filter((item): item is NonNullable<typeof item> => item !== null);

        const sources = await Promise.all(
          items.map(({ obsId, sessionId }) =>
            findRetrievalSource(kv, obsId, sessionId),
          ),
        );
        const candidates = await Promise.all(
          sources.map(async (source, index) => {
            if (!source) return null;
            const provenance = await resolveRetrievalProvenance(
              kv,
              source.observation,
              source.memory,
            );
            return {
              id: source.observation.id,
              baseScore: 1 - index * 0.000001,
              value: source,
              provenance,
            };
          }),
        );
        const expanded = candidates.filter(
          (candidate): candidate is NonNullable<typeof candidate> =>
            candidate !== null,
        );
        const scoped = applyRetrievalPolicy(expanded, retrievalContext).map(
          (candidate) => ({
            obsId: candidate.id,
            ...(candidate.provenance.sessionId
              ? { sessionId: candidate.provenance.sessionId }
              : {}),
            observation: publicRetrievalObservation(
              candidate.value.observation,
              candidate.provenance,
            ),
            provenance: candidate.provenance,
            scope: candidate.scope,
            scopeReason: candidate.scopeReason,
          }),
        );

        void recordAccessBatch(
          kv,
          scoped.map((e) => e.observation.id),
        );

        const truncated = data.expandIds.length > raw.length;
        logger.info("Smart search expanded", {
          requested: data.expandIds.length,
          attempted: raw.length,
          returned: scoped.length,
          filteredOutOfScope: expanded.length - scoped.length,
          truncated,
        });
        return { mode: "expanded", results: scoped, truncated };
      }

      if (!data.query || typeof data.query !== "string" || !data.query.trim()) {
        return { mode: "compact", results: [], error: "query is required" };
      }

      const limit = Math.max(1, Math.min(data.limit ?? 20, 100));
      // Lesson recall stays capped: lessons are denser than raw
      // observations so 10 covers most recall flows.
      const lessonLimit = Math.min(limit, 10);
      const includeLessons = data.includeLessons !== false;

      // Over-fetch when filtering. Hybrid search can't filter on
      // agentId (BM25/vector indexes don't carry it), so we ask the
      // searcher for more hits than we need and trim post-filter. 3×
      // is a defensible middle ground: enough headroom for a small
      // workload, capped at 300 so a 100-limit request never asks for
      // thousands of hits.
      const overFetchLimit = filterAgentId
        ? Math.min(limit * 3, 300)
        : limit;

      const [hybridResults, lessons] = await Promise.all([
        searchFn(data.query, overFetchLimit, retrievalContext),
        includeLessons
          ? recallLessons(
              sdk,
              data.query,
              lessonLimit,
              lessonProjectScope(retrievalContext),
              data.accessContext,
            )
          : Promise.resolve([]),
      ]);

      const filteredHybrid = filterAgentId
        ? hybridResults
            .filter(
              (r) =>
                (r.provenance?.agentId ?? r.observation.agentId) ===
                filterAgentId,
            )
            .slice(0, limit)
        : hybridResults.slice(0, limit);

      const compact: CompactSearchResult[] = filteredHybrid.map((r) => ({
        obsId: r.observation.id,
        ...(r.provenance?.sessionId
          ? { sessionId: r.provenance.sessionId }
          : {}),
        title: r.observation.title,
        type: r.observation.type,
        score: r.combinedScore,
        timestamp: r.provenance?.timestamp ?? r.observation.timestamp,
        bm25Score: r.bm25Score,
        vectorScore: r.vectorScore,
        graphScore: r.graphScore,
        ...(r.scope ? { scope: r.scope } : {}),
        ...(r.scopeReason ? { scopeReason: r.scopeReason } : {}),
        provenanceAvailable: Boolean(r.provenance),
        ...(r.provenance
          ? { provenance: compactRetrievalProvenance(r.provenance) }
          : {}),
      }));

      void recordAccessBatch(
        kv,
        compact.map((r) => r.obsId),
      );

      // #771: followup-rate diagnostic. Only fires for agent-initiated
      // searches that carry a sessionId — viewer-originated searches
      // (source === "viewer") and direct-sdk callers without a session
      // anchor are skipped. The result-set comparison uses obsIds: a
      // disjoint set under the window suggests the previous call's
      // results were not used, which is our directional proxy for
      // reader-failure-with-evidence.
      if (
        data.sessionId &&
        typeof data.sessionId === "string" &&
        data.source !== "viewer" &&
        compact.length > 0
      ) {
        // Skip detection when retrieval returned nothing: an empty
        // result set is a retrieval failure, not a reader-failure
        // signal. Counting it as "disjoint from prior" would inflate
        // the rate every time search returns no hits.
        followupStats.agentInitiatedSearches++;
        // Off the critical response path. The withKeyedLock(sessionId)
        // call serializes detection per session, so two rapid
        // back-to-back searches from the same agent still see ordered
        // prior-row writes — the second call's lock body queues
        // behind the first's. Other sessions run in parallel.
        const sessionIdForFollowup = data.sessionId;
        const queryForFollowup = data.query;
        const compactForFollowup = compact;
        const detection = withKeyedLock(
          `recent-searches:${sessionIdForFollowup}`,
          () =>
            detectFollowup(
              kv,
              sessionIdForFollowup,
              queryForFollowup,
              compactForFollowup,
            ),
        )
          .catch((err) => {
            logger.warn("Smart search followup detection failed", {
              sessionId: sessionIdForFollowup,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            pendingFollowups.delete(detection);
          });
        pendingFollowups.add(detection);
      }

      logger.info("Smart search compact", {
        query: data.query,
        results: compact.length,
        lessons: lessons.length,
      });
      const response: {
        mode: "compact";
        results: CompactSearchResult[];
        lessons?: CompactLessonResult[];
      } = { mode: "compact", results: compact };
      if (includeLessons) response.lessons = lessons;
      return response;
    },
  );
}

async function recallLessons(
  sdk: ISdk,
  query: string,
  limit: number,
  projectScope: LessonProjectScope,
  accessContext?: LessonAccessContext,
): Promise<CompactLessonResult[]> {
  try {
    const projects = projectScope.filters;
    const projectPayload =
      projects.length <= 1
        ? { project: projects[0] }
        : { projects };
    const recallLimit =
      projects.length > 1 ? Math.min(MAX_LESSON_RECALL_LIMIT, limit * 3) : limit;
    const result = (await sdk.trigger({
      function_id: "mem::lesson-recall",
      payload: {
        query,
        limit: recallLimit,
        ...projectPayload,
        retrievalMode: "hybrid",
        compact: true,
        accessContext,
      },
    })) as {
      success?: boolean;
      lessons?: CompactRetrievedLesson[];
    };
    if (!result?.success || !Array.isArray(result.lessons)) return [];
    return result.lessons.map((lesson) => {
      const evidenceVerdict = lesson.evidenceVerdict;
      const contradicted = lesson.contradicted;
      const evidenceLabel: CompactLessonResult["evidenceLabel"] = contradicted
        ? "contradicted evidence"
        : evidenceVerdict === "refuted"
          ? "refuted evidence (negative)"
          : evidenceVerdict === "supported"
            ? "supported evidence"
            : evidenceVerdict === "mixed"
              ? "mixed evidence"
              : "unverified evidence";
      const scoped = classifyLessonScope(lesson.project, projectScope);
      const adjustedScore =
        lesson.score *
        (scoped ? retrievalScopeMultiplier(scoped.scope) : 1);
      return {
        lessonId: lesson.lessonId,
        content: lesson.content,
        claim: lesson.claim,
        evidenceVerdict,
        evidenceLabel,
        contradicted,
        confidence: lesson.confidence,
        score: roundLessonScore(adjustedScore),
        createdAt: lesson.createdAt,
        project: lesson.project,
        tags: lesson.tags ?? [],
        ...(scoped
          ? { scope: scoped.scope, scopeReason: scoped.scopeReason }
          : {}),
      };
    }).sort(
      (left, right) =>
        right.score - left.score || left.lessonId.localeCompare(right.lessonId),
    ).slice(0, limit);
  } catch (err) {
    logger.warn("Smart search: mem::lesson-recall failed; returning empty lesson list", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

const MAX_LESSON_RECALL_LIMIT = 50;
const MAX_LESSON_PROJECT_FILTERS = 32;

interface LessonProjectScope {
  filters: string[];
  current: Set<string>;
  related: Set<string>;
  hasLocalContext: boolean;
}

function lessonProjectScope(
  context: RetrievalPolicyContext,
): LessonProjectScope {
  const currentFilters = new Set<string>();
  const relatedFilters = new Set<string>();
  const current = new Set<string>();
  const related = new Set<string>();
  const add = (
    identities: Set<string>,
    filters: Set<string>,
    value: string | undefined,
  ): void => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    identities.add(trimmed.toLowerCase());
    filters.add(trimmed);
  };
  const hasLocalContext = Boolean(
    context.currentProject || context.currentRepoId,
  );
  if (!hasLocalContext) {
    return { filters: [], current, related, hasLocalContext: false };
  }
  add(current, currentFilters, context.currentProject);
  for (const alias of context.currentProjectAliases ?? []) {
    add(current, currentFilters, alias);
  }
  add(current, currentFilters, context.currentRepoId);
  if (context.includeRelatedProjects === true) {
    for (const repoId of context.relatedRepoIds ?? []) {
      add(related, relatedFilters, repoId);
    }
  }
  const filters = [
    ...[...currentFilters].sort(),
    ...[...relatedFilters].sort(),
    ...(context.includeGlobal !== false ? ["global"] : []),
  ].slice(0, MAX_LESSON_PROJECT_FILTERS);
  return {
    filters: [...filters].sort(),
    current,
    related,
    hasLocalContext: true,
  };
}

function classifyLessonScope(
  project: string | undefined,
  context: LessonProjectScope,
): { scope: RetrievalScope; scopeReason: string } | undefined {
  if (!context.hasLocalContext) return undefined;
  const identity = project?.trim().toLowerCase();
  if (identity && context.current.has(identity)) {
    return {
      scope: "current_repo",
      scopeReason: "same project identity or canonical repository",
    };
  }
  if (identity && context.related.has(identity)) {
    return {
      scope: "related_repo",
      scopeReason: "explicit repository relationship",
    };
  }
  if (identity === "global") {
    return { scope: "global", scopeReason: "explicit global lesson" };
  }
  return undefined;
}

function roundLessonScore(score: number): number {
  return Math.round(score * 1_000_000) / 1_000_000;
}

async function detectFollowup(
  kv: StateKV,
  sessionId: string,
  query: string,
  compact: CompactSearchResult[],
): Promise<void> {
  const now = Date.now();
  const windowMs = Math.max(1, getFollowupWindowSeconds()) * 1000;
  const currentIds = compact.map((r) => r.obsId);
  const current: RecentSearch = { sessionId, query, resultIds: currentIds, at: now };

  const prior = await kv
    .get<RecentSearch>(KV.recentSearches, sessionId)
    .catch(() => null);

  await kv.set(KV.recentSearches, sessionId, current);

  if (!prior || typeof prior.at !== "number") return;
  if (now - prior.at > windowMs) return;
  // Same query inside the window is a retry, not a follow-up; skip so a
  // duplicate request from a flaky client doesn't inflate the metric.
  if (typeof prior.query === "string" && prior.query === query) return;

  const priorIds = Array.isArray(prior.resultIds) ? prior.resultIds : [];
  const priorSet = new Set(priorIds);
  const hasOverlap = currentIds.some((id) => priorSet.has(id));
  if (hasOverlap) return;

  getCounters().smartSearchFollowupWithinWindow.add(1);
  followupStats.followupWithinWindow++;
  logger.info("Smart search followup detected", {
    sessionId,
    windowSeconds: Math.round(windowMs / 1000),
    priorQuery: prior.query,
    nextQuery: query,
    priorResultCount: priorIds.length,
    nextResultCount: currentIds.length,
  });
}

async function resolveRetrievalContext(
  kv: StateKV,
  data: {
    project?: string;
    currentProject?: string;
    currentRepo?: string;
    missionId?: string;
    sessionId?: string;
    includeRelatedProjects?: boolean;
    relatedProjects?: string[];
    includeGlobal?: boolean;
    includeCrossRepo?: boolean;
    currentFiles?: string[];
  },
  filterAgentId?: string,
): Promise<RetrievalPolicyContext> {
  const session = data.sessionId
    ? await kv.get<Session>(KV.sessions, data.sessionId).catch(() => null)
    : null;
  const currentProject =
    data.currentProject?.trim() || data.project?.trim() || session?.project;
  const currentProjectAliases = new Set(session?.projectAliases ?? []);
  if (session?.project && session.project !== currentProject) {
    currentProjectAliases.add(session.project);
  }
  currentProjectAliases.delete(currentProject ?? "");
  const rawCurrentRepo = data.currentRepo?.trim() || session?.canonicalRepoId;
  const currentRepoId = rawCurrentRepo
    ? normalizeRepositoryIdentity(rawCurrentRepo)
    : undefined;
  const related = new Set<string>();
  for (const repoId of data.relatedProjects ?? []) {
    if (typeof repoId !== "string") continue;
    const normalized = normalizeRepositoryIdentity(repoId);
    if (normalized) related.add(normalized);
  }
  if (currentRepoId) {
    try {
      const relationshipScope = await repositoryRelationshipIdentityScope(
        kv,
        currentRepoId,
      );
      for (const identity of relationshipScope.current) {
        if (identity !== currentRepoId) currentProjectAliases.add(identity);
      }
      if (data.includeRelatedProjects === true) {
        for (const repoId of relationshipScope.related) related.add(repoId);
      }
    } catch (error) {
      logger.warn("Smart search: related repository lookup failed", {
        currentRepoId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ...(currentProject ? { currentProject } : {}),
    ...(currentProjectAliases.size > 0
      ? { currentProjectAliases: [...currentProjectAliases].sort() }
      : {}),
    ...(currentRepoId ? { currentRepoId } : {}),
    ...(data.missionId?.trim() || session?.missionId
      ? { currentMissionId: data.missionId?.trim() || session?.missionId }
      : {}),
    ...(related.size > 0 ? { relatedRepoIds: [...related].sort() } : {}),
    ...(Array.isArray(data.currentFiles)
      ? {
          currentFiles: data.currentFiles
            .filter((file): file is string => typeof file === "string")
            .map((file) => file.trim())
            .filter(Boolean)
            .slice(0, 100),
        }
      : {}),
    includeRelatedProjects: data.includeRelatedProjects === true,
    includeGlobal: data.includeGlobal !== false,
    includeCrossRepo: data.includeCrossRepo === true,
    ...(filterAgentId !== undefined ? { filterAgentId } : {}),
  };
}

async function findRetrievalSource(
  kv: StateKV,
  obsId: string,
  sessionIdHint?: string,
): Promise<{
  observation: CompressedObservation;
  memory: Memory | null;
} | null> {
  if (sessionIdHint) {
    const obs = await kv
      .get<CompressedObservation>(KV.observations(sessionIdHint), obsId)
      .catch(() => null);
    if (obs && "title" in obs) return { observation: obs, memory: null };
  }

  const memory = await kv.get<Memory>(KV.memories, obsId).catch(() => null);
  if (memory) {
    return { observation: memoryToObservation(memory), memory };
  }

  const sessions = await kv.list<{ id: string }>(KV.sessions);
  for (let i = 0; i < sessions.length; i += 5) {
    const batch = sessions.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((s) =>
        kv.get<CompressedObservation>(KV.observations(s.id), obsId).catch(() => null),
      ),
    );
    const found = results.find((result) => result && "title" in result);
    if (found) return { observation: found, memory: null };
  }
  return null;
}
