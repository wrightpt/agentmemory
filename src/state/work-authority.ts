import { KV } from './schema.js';
import type { StateKV } from './kv.js';
import type { Action, ActionEdge, Lease, WorkAuthority } from '../types.js';

export const ZERO_SELECTED_DEFER_ALL = 'zero-selected-defer-all/v1';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^act_[a-zA-Z0-9_]+$/;

function canonicalIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1000
    && value.every(id => typeof id === 'string' && ID.test(id))
    && new Set(value).size === value.length
    && JSON.stringify(value) === JSON.stringify([...value].sort());
}

export function isDeferredOnlyScope(selected: unknown, deferred: unknown, held: unknown): boolean {
  return Array.isArray(selected) && selected.length === 0
    && canonicalIds(deferred) && deferred.length > 0
    && canonicalIds(held) && held.every(id => deferred.includes(id));
}

function validDeferredOnlyAuthority(row: WorkAuthority): boolean {
  return row.selectionMode === ZERO_SELECTED_DEFER_ALL
    && row.generation === 1 && isDeferredOnlyScope(row.selectedIds, row.deferredIds, row.heldClaimIds)
    && typeof row.planDigest === 'string' && HASH.test(row.planDigest)
    && typeof row.sourceDigest === 'string' && HASH.test(row.sourceDigest)
    && Number.isSafeInteger(row.sourceRevision) && row.sourceRevision >= 0
    && typeof row.prefix === 'string' && /^[a-z][a-z0-9]{1,7}$/.test(row.prefix)
    && (row.phase === 'frozen'
      ? [row.mapping, row.receiptDigest, row.deferredTrackingId, row.committedAt].every(value => value === undefined)
      : Array.isArray(row.mapping) && row.mapping.length === 0
        && typeof row.receiptDigest === 'string' && HASH.test(row.receiptDigest)
        && typeof row.deferredTrackingId === 'string'
        && new RegExp(`^${row.prefix}-[a-z0-9]+$`).test(row.deferredTrackingId));
}

export class WorkAuthorityError extends Error {
  constructor(readonly projectId: string, readonly phase: string) {
    super('work_authority_read_only');
  }
}

export const actionProject = (action: Partial<Action>) => action.projectId || action.project || 'workstation';

export async function getWorkAuthority(kv: StateKV, projectId: string): Promise<WorkAuthority | null> {
  const row = await kv.get<WorkAuthority>(KV.workAuthority, projectId);
  if (row && (row.protocol !== 'work-authority/v1' || row.projectId !== projectId
    || !['frozen', 'beads'].includes(row.phase) || !Number.isSafeInteger(row.generation)
    || ((row.selectionMode !== undefined || (Array.isArray(row.selectedIds) && !row.selectedIds.length))
      && !validDeferredOnlyAuthority(row)))) {
    throw new Error('work_authority_invalid');
  }
  return row;
}

export async function assertActionAuthority(kv: StateKV, ...actions: Array<Partial<Action> | null | undefined>) {
  const projects = new Set(actions.filter(Boolean).map(a => actionProject(a!)));
  for (const project of projects) {
    const authority = await getWorkAuthority(kv, project);
    if (authority) throw new WorkAuthorityError(project, authority.phase);
  }
}

export async function fencedProjects(kv: StateKV): Promise<string[]> {
  const rows = await kv.list<WorkAuthority>(KV.workAuthority);
  for (const row of rows) {
    if (!row || !row.projectId || !await getWorkAuthority(kv, row.projectId)) {
      throw new Error('work_authority_invalid');
    }
  }
  return rows.map(row => row.projectId).sort();
}

// Called inside the existing maintenance write barrier, after queued writes
// resume. This also covers raw import/heal/lease paths outside action helpers.
export async function assertWorkMutation(kv: StateKV, scope: string, key: string, value: unknown, partial = false) {
  if (![KV.actions, KV.actionEdges, KV.leases].includes(scope as never)) return;
  if (partial) {
    if ((await fencedProjects(kv)).length) throw new WorkAuthorityError('*', 'partial_update');
    return;
  }
  if (scope === KV.actions) {
    await assertActionAuthority(kv, await kv.get<Action>(scope, key), value as Action | undefined);
    return;
  }
  const before = await kv.get<ActionEdge | Lease>(scope, key);
  const rows = [before, value].filter(Boolean) as Array<ActionEdge & Lease>;
  const ids = new Set(rows.flatMap(row => scope === KV.leases
    ? [row.actionId] : [row.sourceActionId, row.targetActionId]));
  for (const id of ids) {
    if (id) await assertActionAuthority(kv, await kv.get<Action>(KV.actions, id));
  }
}
