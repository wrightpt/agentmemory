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
const READ_BATCH = 64;
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

// A derived per-action index of native lease keys keeps an observation bounded
// by its own action's history. The native ledger stays authoritative: each
// process rebuilds the index from it once at boot, because a rolled-back binary
// writes lease rows without maintaining it, and the current binary keeps entries
// current under the existing per-action lock.
type LeaseIndexEntry = { actionId: string; leaseIds: string[] };
const ready = new WeakSet<object>();
const tainted = new WeakSet<object>();
const rebuilds = new WeakMap<object, Promise<void>>();
const generations = new WeakMap<object, number>();

function entryIds(entry: LeaseIndexEntry | null | undefined, actionId: string): string[] {
  if (entry === null || entry === undefined) return [];
  if (entry.actionId !== actionId || !Array.isArray(entry.leaseIds) || entry.leaseIds.length > MAX_ACTION_LEASES
      || entry.leaseIds.some(id => !identity(id))) refuse("lease_observation_index_invalid");
  return entry.leaseIds;
}

async function readRows(kv: StateKV, ids: string[]): Promise<Array<Lease | null>> {
  const rows: Array<Lease | null> = [];
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    rows.push(...await Promise.all(ids.slice(i, i + READ_BATCH).map(id => kv.get<Lease>(KV.leases, id))));
  }
  return rows;
}

/** One action's lease rows through the derived index, or null before this process
 * has rebuilt it. Retention deletes rows only for removed actions, so an absent
 * row is skipped; a row that names another action means the index is wrong. */
async function indexedActionLeases(kv: StateKV, actionId: string): Promise<Lease[] | null> {
  if (!ready.has(kv)) return null;
  const ids = entryIds(await kv.get<LeaseIndexEntry>(KV.leaseIndex, actionId), actionId);
  const rows = (await readRows(kv, ids)).filter((row): row is Lease => row !== null && row !== undefined);
  if (rows.some(row => row.actionId !== actionId)) refuse("lease_observation_index_invalid");
  return rows;
}

function invalidate(kv: StateKV): void {
  generations.set(kv, (generations.get(kv) ?? 0) + 1);
  ready.delete(kv);
  rebuildLeaseIndex(kv).catch(error => logger.warn("lease index rebuild failed", { error: String(error) }));
}

async function indexLease(kv: StateKV, lease: Lease): Promise<void> {
  let ids: string[] = [];
  try {
    ids = entryIds(await kv.get<LeaseIndexEntry>(KV.leaseIndex, lease.actionId), lease.actionId);
  } catch {
    // A damaged entry is rebuilt from the ledger; keep this row reachable meanwhile.
    invalidate(kv);
  }
  if (ids.includes(lease.id)) return;
  await kv.set(KV.leaseIndex, lease.actionId, { actionId: lease.actionId, leaseIds: [...ids, lease.id].sort() });
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
  // Index before the row: an interrupted write leaves an id whose row is absent,
  // which readers skip, never a row that readers cannot find.
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
  const scanned = new Map<string, Set<string>>();
  let unscoped = false;
  for (const row of rows) {
    if (!row || !identity(row.actionId) || !identity(row.id)) { unscoped = true; continue; }
    let ids = scanned.get(row.actionId);
    if (!ids) scanned.set(row.actionId, ids = new Set<string>());
    ids.add(row.id);
  }
  const actions = new Set(scanned.keys());
  for (const entry of await kv.list<LeaseIndexEntry>(KV.leaseIndex)) {
    if (entry && identity(entry.actionId)) actions.add(entry.actionId);
  }
  for (const actionId of [...actions].sort()) {
    await withKeyedLock(`mem:action:${actionId}`, async () => {
      const entry = await kv.get<LeaseIndexEntry>(KV.leaseIndex, actionId);
      const seen = new Set(scanned.get(actionId) ?? []);
      let prior: string[] = [];
      try { prior = entryIds(entry, actionId); } catch { prior = []; }
      // Ids this binary indexed after the scan still have rows; deleted rows do not.
      for (const id of prior) {
        if (seen.has(id)) continue;
        const row = await kv.get<Lease>(KV.leases, id);
        if (row && row.actionId === actionId) seen.add(id);
      }
      const ids = [...seen].sort();
      const unchanged = entry?.actionId === actionId && Array.isArray(entry.leaseIds)
        && entry.leaseIds.length === ids.length && entry.leaseIds.every((id, index) => id === ids[index]);
      if (unchanged) return;
      if (ids.length) await kv.set(KV.leaseIndex, actionId, { actionId, leaseIds: ids });
      else await kv.delete(KV.leaseIndex, actionId);
    });
  }
  return unscoped;
}

/** Rebuild this process's derived lease index from the native ledger. A pass that
 * overlaps an invalidation repeats; readiness is granted only to a clean pass. */
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

/** Boot rebuild, outside request handling. Observations that arrive first wait
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
 * action-store lock, which is held only for collection state, the exact action
 * and its authority. Lease rows change only under the per-action lock, held for
 * the whole read, so rows read after leaving the store lock belong to the same
 * cut. Pending recovery is refused, not repaired by this read. Normal action
 * APIs retain their existing recovery behavior. */
export async function observeActionLease(kv: StateKV, projectId: string, actionId: string) {
  if (!identity(projectId) || !identity(actionId)) refuse("lease_observation_scope_required");
  await leaseIndexReady(kv);
  return withKeyedLock(`mem:action:${actionId}`, async () => {
    const cut = await withActionStoreLock(async () => {
      const state = await peekActionCollectionState(kv);
      if (state.pending) refuse("lease_observation_action_pending");
      const action = await kv.get<Action>(KV.actions, actionId);
      if (!action) refuse("lease_observation_action_missing");
      if (actionProject(action!) !== projectId) refuse("lease_observation_scope_mismatch");
      const authority = await getWorkAuthority(kv, projectId);
      if (authority !== null) refuse("lease_observation_authority_unavailable");
      return { action: action!, revision: state.revision };
    });
    const rows = await indexedActionLeases(kv, actionId);
    if (rows === null) refuse("lease_observation_index_unavailable");
    if (tainted.has(kv)) refuse("lease_observation_unscoped_row");
    const leaseObservation = projectActionLease(cut.action, rows!, projectId, Date.now());
    return structuredClone({ action: cut.action, revision: cut.revision, workAuthority: null, leaseObservation });
  });
}
