import { createHash } from "node:crypto";

export const STALE_DELETE_PROTOCOL = "stale-delete-v1";
export const MIN_IDLE_MS = 72 * 60 * 60 * 1000;
export type CleanupRow = Record<string, unknown>;
export interface StaleDeleteRequest {
  protocol: typeof STALE_DELETE_PROTOCOL;
  kind: "memory" | "lease";
  id: string;
  expectedFingerprint: string;
  cutoff: string;
}

export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item)
    ? item.map(canonical)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]))
      : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  const time = Date.parse(value), day = value.slice(0, 10);
  if (!Number.isFinite(time) || new Date(day + "T00:00:00Z").toISOString().slice(0, 10) !== day) return NaN;
  return time;
}

export function validRequest(data: unknown, now: number): data is StaleDeleteRequest {
  if (!data || typeof data !== "object") return false;
  const row = data as CleanupRow, cutoff = timestamp(row.cutoff);
  return row.protocol === STALE_DELETE_PROTOCOL && ["memory", "lease"].includes(String(row.kind))
    && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256
    && typeof row.expectedFingerprint === "string" && /^[a-f0-9]{64}$/.test(row.expectedFingerprint)
    && Number.isFinite(cutoff) && cutoff <= now - MIN_IDLE_MS;
}

export function validRows(value: unknown, maximum: number): CleanupRow[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(row =>
    !row || typeof row !== "object" || typeof row.id !== "string" || !row.id.length)) {
    throw new Error("invalid_or_excessive_maintenance_inventory");
  }
  if (new Set(value.map(row => row.id)).size !== value.length) {
    throw new Error("duplicate_maintenance_inventory_identity");
  }
  return value as CleanupRow[];
}

export function memoryRetentionReason(memory: CleanupRow, access: unknown, cutoff: number): string | undefined {
  if (memory.isLatest !== true || memory.project || memory.projectId || memory.repoRoot || memory.worktree
    || !Array.isArray(memory.sessionIds) || memory.sessionIds.length) return "scoped-or-session-linked";
  const attribution = memory.attribution as CleanupRow | undefined;
  if (attribution?.project || attribution?.canonicalRepoId) return "attributed";
  if (!["pattern", "preference", "architecture", "bug", "workflow", "fact"].includes(String(memory.type))) return "invalid-type";
  const created = timestamp(memory.createdAt), updated = timestamp(memory.updatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created) return "invalid-timestamp";
  if (Math.max(created, updated) >= cutoff) return "recent";
  if (access !== null && access !== undefined) {
    if (typeof access !== "object") return "invalid-access-log";
    const row = access as CleanupRow, last = timestamp(row.lastAt);
    if (row.memoryId !== memory.id || !Number.isFinite(last) || !Array.isArray(row.recent)
      || row.recent.length > 20000 || row.recent.some(t => typeof t !== "number" || !Number.isFinite(t) || t < 0)) return "invalid-access-log";
    if (last >= cutoff || row.recent.some(t => t >= cutoff)) return "recent-access";
  }
  for (const key of ["supersedes", "relatedIds", "sourceObservationIds"]) {
    if (memory[key] !== undefined && (!Array.isArray(memory[key]) || memory[key].length)) return "linked-evidence";
  }
  if (memory.parentId || memory.imageRef || memory.imageData) return "linked-evidence";
}

export function leaseRetentionReason(lease: CleanupRow, action: unknown, cutoff: number): string | undefined {
  if (typeof lease.actionId !== "string" || !lease.actionId || typeof lease.agentId !== "string" || !lease.agentId) return "invalid-identity";
  if (!["released", "expired"].includes(String(lease.status))) return "not-terminal";
  if (action !== null) return "action-exists";
  const acquired = timestamp(lease.acquiredAt), expires = timestamp(lease.expiresAt);
  const renewed = lease.renewedAt === undefined ? acquired : timestamp(lease.renewedAt);
  if (![acquired, expires, renewed].every(Number.isFinite) || expires < acquired || renewed < acquired || renewed > expires) return "invalid-timestamp";
  if (Math.max(acquired, renewed, expires) >= cutoff) return "recent";
}
