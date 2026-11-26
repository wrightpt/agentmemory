import { createHash } from "node:crypto";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { actionProject, getWorkAuthority } from "../state/work-authority.js";
import { peekActionCollectionState, withActionStoreLock } from "./action-store.js";
import { logger } from "../logger.js";
import type { Action, ActionLeaseObservation, Lease } from "../types.js";

const MAX_VERSION = Math.floor((Number.MAX_SAFE_INTEGER - 1) / 2);
const MAX_ACTION_LEASES = 50000;
const BATCH = 64;
const identity = (value: unknown): value is string => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
// Native acquire, MCP, REST and the todo CLI accept opaque holder strings. A
// holder is only bounded and free of control and bidirectional-format characters.
const holder = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(value);
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

// A derived index keeps an observation bounded by its own action's lease history.
// Each action has its own scope holding one key per native lease row. Keys are
// only ever added, never replaced or pruned, so a late, repeated or concurrent
// write can add a key but cannot hide another one. A key whose row is absent
// (retention removed it, or its row write never happened) is skipped. The native
// ledger stays authoritative: each process indexes it once at boot, because a
// rolled-back binary writes lease rows without maintaining the index.
type LeaseIndexKey = { actionId: string; leaseId: string };
const ready = new WeakSet<object>();
const tainted = new WeakSet<object>();
const rebuilds = new WeakMap<object, Promise<void>>();
const generations = new WeakMap<object, number>();

async function indexLease(kv: StateKV, lease: Lease): Promise<void> {
  const scope = KV.leaseIndex(lease.actionId);
  const key = await kv.get<LeaseIndexKey>(scope, lease.id);
  if (key?.actionId === lease.actionId && key.leaseId === lease.id) return;
  await kv.set(scope, lease.id, { actionId: lease.actionId, leaseId: lease.id });
}

async function readRows(kv: StateKV, ids: string[]): Promise<Lease[]> {
  const rows: Lease[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    for (const row of await Promise.all(ids.slice(i, i + BATCH).map(id => kv.get<Lease>(KV.leases, id)))) {
      if (row !== null && row !== undefined) rows.push(row);
    }
  }
  return rows;
}

/** One action's lease rows through its index scope, or null before this process
 * has indexed the ledger. A key or row that names another action means the index
 * is wrong and refuses rather than answering. */
async function indexedActionLeases(kv: StateKV, actionId: string): Promise<Lease[] | null> {
  if (!ready.has(kv)) return null;
  const keys = await kv.list<LeaseIndexKey>(KV.leaseIndex(actionId));
  if (!Array.isArray(keys) || keys.length > MAX_ACTION_LEASES) refuse("lease_observation_incomplete");
  const ids = new Set<string>();
  for (const key of keys) {
    if (!key || key.actionId !== actionId || !identity(key.leaseId)) refuse("lease_observation_index_invalid");
    ids.add(key.leaseId);
  }
  const rows = await readRows(kv, [...ids].sort());
  if (rows.some(row => row.actionId !== actionId)) refuse("lease_observation_index_invalid");
  return rows;
}

function invalidate(kv: StateKV): void {
  generations.set(kv, (generations.get(kv) ?? 0) + 1);
  ready.delete(kv);
  rebuildLeaseIndex(kv).catch(error => logger.warn("lease index rebuild failed", { error: String(error) }));
}

/** Call only while holding the existing mem:action:<id> mutation lock. A version
 * travels in the same native lease-row write as its mutation, never a second
 * authority/ledger or a read-side write. Terminal rows are retained while their
 * action exists by the existing stale-delete policy, preserving the version floor. */
export async function writeVersionedLease(kv: StateKV, lease: Lease, rows?: Lease[]): Promise<void> {
  let leases = rows;
  if (!leases && identity(lease.actionId)) {
    try { leases = await indexedActionLeases(kv, lease.actionId) ?? undefined; } catch { leases = undefined; }
  }
  leases ??= await kv.list<Lease>(KV.leases);
  let maximum = 0;
  for (const row of leases) if (row.actionId === lease.actionId) maximum = Math.max(maximum, version(row));
  if (maximum >= MAX_VERSION) refuse("lease_observation_version_exhausted");
  lease.observationVersion = maximum + 1;
  lease.observationLegacyDigest = legacyDigest(leases.filter(row => row.actionId === lease.actionId && row.id !== lease.id));
  lease.observationDigest = digest(sourceFields(lease));
  const scoped = identity(lease.actionId) && identity(lease.id);
  // Index before the row: an interrupted or unknown write leaves a key whose row
  // is absent, which readers skip, never a row that readers cannot find.
  if (scoped) await indexLease(kv, lease);
  await kv.set(KV.leases, lease.id, lease);
  if (!scoped) {
    // An unscopable row cannot prove absence for any action until a rebuild sees it.
    tainted.add(kv);
    invalidate(kv);
  }
}

async function rebuildOnce(kv: StateKV): Promise<boolean> {
  const rows = await kv.list<Lease>(KV.leases);
  let unscoped = false;
  const scoped: Lease[] = [];
  for (const row of rows) {
    if (!row || !identity(row.actionId) || !identity(row.id)) unscoped = true;
    else scoped.push(row);
  }
  // Adds only. Writers index their own rows meanwhile, so no lock is needed.
  for (let i = 0; i < scoped.length; i += BATCH) {
    await Promise.all(scoped.slice(i, i + BATCH).map(row => indexLease(kv, row)));
  }
  return unscoped;
}

/** Index the native ledger for this process. A pass that overlaps an
 * invalidation repeats; readiness is granted only to a clean pass. */
export function rebuildLeaseIndex(kv: StateKV): Promise<void> {
  const inflight = rebuilds.get(kv);
  if (inflight) return inflight;
  ready.delete(kv);
  const run = (async () => {
    for (;;) {
      const generation = generations.get(kv) ?? 0;
      const unscoped = await rebuildOnce(kv);
      if ((generations.get(kv) ?? 0) !== generation) continue;
      if (unscoped) tainted.add(kv); else tainted.delete(kv);
      ready.add(kv);
      return;
    }
  })().finally(() => { rebuilds.delete(kv); });
  rebuilds.set(kv, run);
  return run;
}

/** Boot indexing, outside request handling. Observations that arrive first wait
 * for it; writers use the full ledger until it is ready. */
export function startLeaseIndex(kv: StateKV): void {
  rebuildLeaseIndex(kv).catch(error => logger.warn("lease index rebuild failed; observations retry it", { error: String(error) }));
}

async function leaseIndexReady(kv: StateKV): Promise<void> {
  if (!ready.has(kv)) {
    try { await rebuildLeaseIndex(kv); } catch { refuse("lease_observation_index_unavailable"); }
  }
  if (tainted.has(kv)) refuse("lease_observation_unscoped_row");
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) refuse("lease_observation_row_invalid");
  return new Date(value as string).toISOString();
}

export function projectActionLease(action: Action, rows: Lease[], projectId: string, now: number): ActionLeaseObservation {
  if (!Array.isArray(rows) || rows.length > MAX_ACTION_LEASES) refuse("lease_observation_incomplete");
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
    if (!identity(row.id) || !holder(row.agentId) || ids.has(row.id)
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
 * action-store lock, both held for the whole read. Ordinary action updates take
 * the store lock, so the action, its authority, its lease rows and the sampling
 * instant form one cut, and the work under the lock is bounded by this action's
 * own lease history. Pending recovery is refused, not repaired by this read.
 * Normal action APIs retain their existing recovery behavior. */
export async function observeActionLease(kv: StateKV, projectId: string, actionId: string) {
  if (!identity(projectId) || !identity(actionId)) refuse("lease_observation_scope_required");
  await leaseIndexReady(kv);
  return withKeyedLock(`mem:action:${actionId}`, () => withActionStoreLock(async () => {
    const state = await peekActionCollectionState(kv);
    if (state.pending) refuse("lease_observation_action_pending");
    const action = await kv.get<Action>(KV.actions, actionId);
    if (!action) refuse("lease_observation_action_missing");
    if (actionProject(action!) !== projectId) refuse("lease_observation_scope_mismatch");
    const authority = await getWorkAuthority(kv, projectId);
    if (authority !== null) refuse("lease_observation_authority_unavailable");
    const rows = await indexedActionLeases(kv, actionId);
    if (rows === null) refuse("lease_observation_index_unavailable");
    if (tainted.has(kv)) refuse("lease_observation_unscoped_row");
    const leaseObservation = projectActionLease(action!, rows!, projectId, Date.now());
    return structuredClone({ action: action!, revision: state.revision, workAuthority: null, leaseObservation });
  }));
}
