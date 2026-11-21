import { createHash } from "node:crypto";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { actionProject, getWorkAuthority } from "../state/work-authority.js";
import { peekActionCollectionState, withActionStoreLock } from "./action-store.js";
import type { Action, ActionLeaseObservation, Lease } from "../types.js";

const MAX_VERSION = Math.floor((Number.MAX_SAFE_INTEGER - 1) / 2);
const identity = (value: unknown): value is string => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class LeaseObservationError extends Error {
  constructor(readonly code: string) { super(code); }
}
const refuse = (code: string): never => { throw new LeaseObservationError(code); };
function version(lease: Lease): number {
  const n = lease.observationVersion ?? 0;
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_VERSION) refuse("lease_observation_version_invalid");
  return n;
}
function sourceFields(lease: Lease) {
  return { id: lease.id, actionId: lease.actionId, agentId: lease.agentId,
    acquiredAt: lease.acquiredAt, renewedAt: lease.renewedAt ?? null,
    expiresAt: lease.expiresAt, status: lease.status, observationVersion: version(lease),
    observationLegacyDigest: lease.observationLegacyDigest ?? null };
}
const legacyDigest = (rows: Lease[]) => digest(rows.filter(row => row.observationVersion === undefined)
  .map(sourceFields).sort((a, b) => a.id.localeCompare(b.id)));

/** Call only while holding the existing mem:action:<id> mutation lock. A version
 * travels in the same native lease-row write as its mutation, never a second
 * authority/ledger or a read-side write. Terminal rows are retained while their
 * action exists by the existing stale-delete policy, preserving the version floor. */
export async function writeVersionedLease(kv: StateKV, lease: Lease, rows?: Lease[]): Promise<void> {
  const leases = rows ?? await kv.list<Lease>(KV.leases);
  let maximum = 0;
  for (const row of leases) if (row.actionId === lease.actionId) maximum = Math.max(maximum, version(row));
  if (maximum >= MAX_VERSION) refuse("lease_observation_version_exhausted");
  lease.observationVersion = maximum + 1;
  lease.observationLegacyDigest = legacyDigest(leases.filter(row => row.actionId === lease.actionId && row.id !== lease.id));
  lease.observationDigest = digest(sourceFields(lease));
  await kv.set(KV.leases, lease.id, lease);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) refuse("lease_observation_row_invalid");
  return new Date(value as string).toISOString();
}

export function projectActionLease(action: Action, rows: Lease[], projectId: string, now: number): ActionLeaseObservation {
  if (!Array.isArray(rows) || rows.length > 50000) refuse("lease_observation_incomplete");
  if (!Number.isSafeInteger(now) || now < 0) refuse("lease_observation_clock_invalid");
  // An unscopable record cannot prove absence for the requested action. Malformed
  // records with another explicit actionId do not contaminate this task's read.
  if (rows.some(row => !row || !identity(row.actionId))) refuse("lease_observation_unscoped_row");
  const selected = rows.filter(row => row.actionId === action.id);
  const counts = new Map<string, number>();
  for (const row of rows) if (typeof row.id === "string") counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const ids = new Set<string>();
  const versions = new Set<number>();
  let maximum = 0;
  let latest: Lease | undefined;
  const active: Lease[] = [];
  let expiredActive = false;
  for (const row of selected) {
    if (!identity(row.id) || !identity(row.agentId) || ids.has(row.id)
        || counts.get(row.id) !== 1
        || !["active", "released", "expired"].includes(row.status)) refuse("lease_observation_row_invalid");
    ids.add(row.id);
    const acquired = Date.parse(timestamp(row.acquiredAt));
    const renewed = row.renewedAt === undefined ? acquired : Date.parse(timestamp(row.renewedAt));
    const expiry = Date.parse(timestamp(row.expiresAt));
    if (acquired > renewed || renewed > now || expiry <= renewed) refuse("lease_observation_clock_invalid");
    const n = version(row);
    const hasVersion = row.observationVersion !== undefined;
    const hasDigest = row.observationDigest !== undefined;
    const hasLegacyDigest = row.observationLegacyDigest !== undefined;
    if (hasVersion !== hasDigest || hasVersion !== hasLegacyDigest
        || (hasVersion && (n === 0 || typeof row.observationLegacyDigest !== "string"
          || !/^[a-f0-9]{64}$/.test(row.observationLegacyDigest) || row.observationDigest !== digest(sourceFields(row))))) {
      // An older binary can preserve the additive stamp while changing a row.
      // Refuse that unversioned change rather than silently reuse its watermark.
      refuse("lease_observation_unversioned_change");
    }
    if (n > 0 && versions.has(n)) refuse("lease_observation_version_conflict");
    if (n > 0) versions.add(n);
    if (n > maximum) { maximum = n; latest = row; }
    if (row.status === "active") {
      if (expiry > now) active.push(row);
      else expiredActive = true;
    }
  }
  if (latest && latest.observationLegacyDigest !== legacyDigest(selected)) refuse("lease_observation_unversioned_change");
  if (active.length > 1) refuse("lease_observation_conflict");
  const row = active[0];
  if (row && ((action.lifecycle || action.status) !== "active" || action.assignedTo !== row.agentId)) {
    refuse("lease_observation_holder_conflict");
  }
  const lease = row ? { id: row.id, agentId: row.agentId, acquiredAt: timestamp(row.acquiredAt),
    renewedAt: row.renewedAt ? timestamp(row.renewedAt) : null, expiresAt: timestamp(row.expiresAt) } : null;
  const state = row ? "active" as const : "none" as const;
  // Reserve the odd step for natural expiry before cleanup changes any row.
  // A subsequent native mutation consumes the next even step, so cleanup,
  // release/reacquisition and renewals cannot move the observed order backwards.
  const sequence = maximum * 2 + (!row && expiredActive ? 1 : 0);
  const source = selected.map(sourceFields).sort((a, b) => a.id.localeCompare(b.id));
  return { protocol: "action-lease-observation/v1", projectId, actionId: action.id, state, lease,
    observedAt: new Date(now).toISOString(),
    watermark: { sequence, digest: digest({ projectId, actionId: action.id, state, source }) } };
}

/** Cheap read-only cut. Preserve mutation lock order: per-action then the
 * action-store lock. Pending recovery is refused, not repaired by this read.
 * Normal action APIs retain their existing recovery behavior. */
export async function observeActionLease(kv: StateKV, projectId: string, actionId: string) {
  if (!identity(projectId) || !identity(actionId)) refuse("lease_observation_scope_required");
  return withKeyedLock(`mem:action:${actionId}`, () => withActionStoreLock(async () => {
    const state = await peekActionCollectionState(kv);
    if (state.pending) refuse("lease_observation_action_pending");
    const action = await kv.get<Action>(KV.actions, actionId);
    if (!action) refuse("lease_observation_action_missing");
    if (actionProject(action!) !== projectId) refuse("lease_observation_scope_mismatch");
    const authority = await getWorkAuthority(kv, projectId);
    if (authority !== null) refuse("lease_observation_authority_unavailable");
    const rows = await kv.list<Lease>(KV.leases);
    const leaseObservation = projectActionLease(action!, rows, projectId, Date.now());
    return structuredClone({ action: action!, revision: state.revision, workAuthority: null, leaseObservation });
  }));
}
