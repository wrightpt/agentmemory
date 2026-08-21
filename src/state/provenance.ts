import type {
  CompressedObservation,
  CompactRetrievalProvenance,
  Memory,
  RetrievalAttributionSnapshot,
  RetrievalProvenance,
  Session,
} from "../types.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";

const SNAPSHOT_STRING_FIELDS = [
  "project",
  "canonicalRepoId",
  "repoRemote",
  "repoRoot",
  "worktree",
  "branch",
  "commitSha",
  "terminalSession",
  "parentSession",
  "missionId",
  "missionTitle",
  "missionRole",
] as const satisfies readonly (keyof RetrievalAttributionSnapshot)[];

/** Capture immutable attribution at write time from normalized hook/session data. */
export function captureRetrievalAttribution(
  source: Partial<Session> & { projectAliases?: string[] },
): RetrievalAttributionSnapshot | undefined {
  const snapshot: RetrievalAttributionSnapshot = {};
  for (const field of SNAPSHOT_STRING_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value.trim()) {
      snapshot[field] = value.trim();
    }
  }
  if (source.projectAliases?.length) {
    snapshot.projectAliases = [
      ...new Set(
        source.projectAliases.map((alias) => alias.trim()).filter(Boolean),
      ),
    ].sort();
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

async function firstExistingSession(
  kv: StateKV,
  sessionIds: Array<string | undefined>,
): Promise<Session | null> {
  const candidates = [
    ...new Set(
      sessionIds.filter((sessionId): sessionId is string =>
        Boolean(sessionId && sessionId !== "memory"),
      ),
    ),
  ];
  for (const sessionId of candidates) {
    const session = await kv
      .get<Session>(KV.sessions, sessionId)
      .catch(() => null);
    if (session) return session;
  }
  return null;
}

export async function resolveRetrievalProvenance(
  kv: StateKV,
  observation: CompressedObservation,
  sourceMemory?: Memory | null,
): Promise<RetrievalProvenance> {
  const memory =
    sourceMemory === undefined
      ? await kv.get<Memory>(KV.memories, observation.id).catch(() => null)
      : sourceMemory;
  // A Memory's sessionIds are its source provenance. The observation wrapper
  // deliberately carries sessionIds[0] as an internal index/hydration locator,
  // so it must not be projected back out as though a composite had one source.
  // For an ordinary observation, its own sessionId remains the single source.
  const sourceSessionIds = [
    ...new Set(
      (memory ? memory.sessionIds ?? [] : [observation.sessionId])
        .filter((sessionId): sessionId is string =>
          typeof sessionId === "string",
        )
        .map((sessionId) => sessionId.trim())
        .filter((sessionId) => sessionId && sessionId !== "memory"),
    ),
  ].sort();
  const session = await firstExistingSession(kv, [
    observation.sessionId,
    ...(memory?.sessionIds ?? []),
  ]);
  const attribution = memory?.attribution ?? observation.attribution;
  // Once a writer captured any immutable attribution, that snapshot is the
  // complete write-time claim. Missing fields must remain missing: filling
  // them from a mutable Session later can falsely move a memory to another
  // branch/mission/repository or assign a composite to the first session's
  // agent. Session fallback remains solely for legacy rows with no snapshot.
  const legacySession = attribution === undefined ? session : undefined;
  const sessionId =
    sourceSessionIds.length === 1 ? sourceSessionIds[0] : undefined;
  const sessionIds =
    sourceSessionIds.length > 1 ? sourceSessionIds : undefined;
  const commitSha =
    attribution?.commitSha ??
    legacySession?.commitSha ??
    (legacySession?.commitShas?.length
      ? legacySession.commitShas[legacySession.commitShas.length - 1]
      : undefined);
  const project =
    attribution?.project ?? memory?.project ?? legacySession?.project;
  const projectAliases =
    attribution?.projectAliases ?? legacySession?.projectAliases;
  const agentId =
    memory?.agentId ?? observation.agentId ?? legacySession?.agentId;
  const canonicalRepoId =
    attribution?.canonicalRepoId ?? legacySession?.canonicalRepoId;
  const repoRemote = attribution?.repoRemote ?? legacySession?.repoRemote;
  const repoRoot = attribution?.repoRoot ?? legacySession?.repoRoot;
  const worktree = attribution?.worktree ?? legacySession?.worktree;
  const branch = attribution?.branch ?? legacySession?.branch;
  const terminalSession =
    attribution?.terminalSession ?? legacySession?.terminalSession;
  const parentSession =
    attribution?.parentSession ?? legacySession?.parentSession;
  const missionId = attribution?.missionId ?? legacySession?.missionId;
  const missionTitle = attribution?.missionTitle ?? legacySession?.missionTitle;
  const missionRole = attribution?.missionRole ?? legacySession?.missionRole;
  const files = [...new Set([...(memory?.files ?? []), ...observation.files])];
  const attributed = Boolean(
    project ||
    canonicalRepoId ||
    sessionId ||
    agentId ||
    missionId ||
    commitSha ||
    Boolean(sessionIds?.length) ||
    files.length,
  );

  return {
    ...(project ? { project } : {}),
    ...(projectAliases?.length ? { projectAliases } : {}),
    ...(canonicalRepoId ? { canonicalRepoId } : {}),
    ...(repoRemote ? { repoRemote } : {}),
    ...(repoRoot ? { repoRoot } : {}),
    ...(worktree ? { worktree } : {}),
    ...(branch ? { branch } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionIds ? { sessionIds } : {}),
    ...(terminalSession ? { terminalSession } : {}),
    ...(parentSession ? { parentSession } : {}),
    ...(missionId ? { missionId } : {}),
    ...(missionTitle ? { missionTitle } : {}),
    ...(missionRole ? { missionRole } : {}),
    ...(agentId ? { agentId } : {}),
    files,
    timestamp: memory?.createdAt ?? observation.timestamp,
    observationId: observation.id,
    ...(memory
      ? { memoryId: memory.id, memoryType: memory.type }
      : { memoryType: observation.type }),
    ...(observation.confidence !== undefined
      ? { confidence: observation.confidence }
      : {}),
    importance: memory?.strength ?? observation.importance,
    ...(memory ? { isLatest: memory.isLatest } : {}),
    ...(memory?.supersedes?.length ? { supersedes: memory.supersedes } : {}),
    attributed,
  };
}

export function compactRetrievalProvenance(
  provenance: RetrievalProvenance,
): CompactRetrievalProvenance {
  return {
    ...(provenance.project ? { project: provenance.project } : {}),
    ...(provenance.canonicalRepoId
      ? { canonicalRepoId: provenance.canonicalRepoId }
      : {}),
    ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
    ...(provenance.sessionIds?.length
      ? { sessionIds: [...provenance.sessionIds] }
      : {}),
    ...(provenance.agentId ? { agentId: provenance.agentId } : {}),
    ...(provenance.missionId ? { missionId: provenance.missionId } : {}),
    ...(provenance.branch ? { branch: provenance.branch } : {}),
    ...(provenance.commitSha ? { commitSha: provenance.commitSha } : {}),
    timestamp: provenance.timestamp,
    ...(provenance.memoryType ? { memoryType: provenance.memoryType } : {}),
    ...(provenance.importance !== undefined
      ? { importance: provenance.importance }
      : {}),
    ...(provenance.confidence !== undefined
      ? { confidence: provenance.confidence }
      : {}),
    attributed: provenance.attributed,
  };
}

/**
 * Return an API-safe observation projection.
 *
 * Durable memories are wrapped as observations for indexing and hydration.
 * For composites that wrapper uses sessionIds[0] internally, but publishing
 * that locator would misrepresent one source as the source. Keep the stable
 * observation shape while replacing only that internal locator with the
 * existing synthetic `memory` sentinel; callers can inspect sessionIds on the
 * accompanying provenance object.
 */
export function publicRetrievalObservation(
  observation: CompressedObservation,
  provenance: RetrievalProvenance,
): CompressedObservation {
  return provenance.sessionIds?.length
    ? { ...observation, sessionId: "memory" }
    : observation;
}
