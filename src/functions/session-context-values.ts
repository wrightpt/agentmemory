import type { HookPayload } from "../types.js";
import { normalizeRepositoryRemote } from "../utils/repository-identity.js";

export const SESSION_CONTEXT_STRING_FIELDS = [
  "repoRoot",
  "scopeType",
  "worktree",
  "branch",
  "taskSlug",
  "canonicalRepoId",
  "repoRemote",
  "terminalSession",
  "missionId",
  "missionTitle",
  "missionRole",
  "parentSession",
  "commitSha",
] as const;

export type SessionContextStringField = (typeof SESSION_CONTEXT_STRING_FIELDS)[number];
export type NormalizedSessionContext = Partial<
  Pick<HookPayload, SessionContextStringField | "projectAliases">
>;

const MAX_LENGTH: Record<SessionContextStringField, number> = {
  repoRoot: 4096,
  scopeType: 128,
  worktree: 4096,
  branch: 1024,
  taskSlug: 512,
  canonicalRepoId: 1024,
  repoRemote: 4096,
  terminalSession: 512,
  missionId: 512,
  missionTitle: 1024,
  missionRole: 128,
  parentSession: 512,
  commitSha: 128,
};

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonicalRepoId(value: unknown): string | undefined {
  const normalized = nonEmpty(value);
  if (
    !normalized ||
    normalized.length > MAX_LENGTH.canonicalRepoId ||
    /[\s\\?#]/.test(normalized) ||
    normalized.includes("://")
  ) {
    return undefined;
  }
  return normalized;
}

function commitSha(value: unknown): string | undefined {
  const normalized = nonEmpty(value)?.toLowerCase();
  return normalized && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalized)
    ? normalized
    : undefined;
}

function projectAliases(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const aliases = new Set<string>();
  for (const candidate of value) {
    const alias = nonEmpty(candidate);
    if (alias) aliases.add(alias.slice(0, 1024));
    if (aliases.size >= 128) break;
  }
  return aliases.size > 0 ? [...aliases].sort() : undefined;
}

/** Normalize optional session metadata before it reaches durable state. */
export function normalizeSessionContextValues(
  input: Record<string, unknown>,
): NormalizedSessionContext {
  const result: NormalizedSessionContext = {};
  for (const field of SESSION_CONTEXT_STRING_FIELDS) {
    if (field === "canonicalRepoId" || field === "repoRemote" || field === "commitSha") {
      continue;
    }
    const value = nonEmpty(input[field]);
    if (value) result[field] = value.slice(0, MAX_LENGTH[field]);
  }

  const normalizedRemote = nonEmpty(input.repoRemote)
    ? normalizeRepositoryRemote(String(input.repoRemote))
    : undefined;
  if (normalizedRemote) {
    result.repoRemote = normalizedRemote.repoRemote;
    result.canonicalRepoId = normalizedRemote.canonicalRepoId;
  } else {
    const identity = canonicalRepoId(input.canonicalRepoId);
    if (identity) result.canonicalRepoId = identity;
  }

  const sha = commitSha(input.commitSha);
  if (sha) result.commitSha = sha;
  const aliases = projectAliases(input.projectAliases);
  if (aliases) result.projectAliases = aliases;
  return result;
}
