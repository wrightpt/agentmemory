import { KV } from './schema.js';
import type { StateKV } from './kv.js';
import type { Action, ActionEdge, Lease, WorkAuthority } from '../types.js';

export class WorkAuthorityError extends Error {
  constructor(readonly projectId: string, readonly phase: string) {
    super('work_authority_read_only');
  }
}

export const actionProject = (action: Partial<Action>) => action.projectId || action.project || 'workstation';

export async function getWorkAuthority(kv: StateKV, projectId: string): Promise<WorkAuthority | null> {
  const row = await kv.get<WorkAuthority>(KV.workAuthority, projectId);
  if (row && (row.protocol !== 'work-authority/v1' || row.projectId !== projectId
    || !['frozen', 'beads'].includes(row.phase) || !Number.isSafeInteger(row.generation))) {
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
