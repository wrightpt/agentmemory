import { createHash } from 'node:crypto';
import type { ISdk } from 'iii-sdk';
import type { StateKV } from '../state/kv.js';
import { KV } from '../state/schema.js';
import type { Action, ActionEdge, Lease, WorkAuthority } from '../types.js';
import { actionProject, getWorkAuthority } from '../state/work-authority.js';
import { recoverActionStoreUnlocked, withActionStoreLock } from './action-store.js';
import { isCanonicalProjectId } from './action-model.js';
import { recordAudit } from './audit.js';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^act_[a-zA-Z0-9_]+$/;
const digest = (data: unknown): string => createHash('sha256').update(JSON.stringify(data)).digest('hex');
function fail(code: string): never { throw new Error(code); }

async function snapshot(kv: StateKV, projectId: string) {
  const state = await recoverActionStoreUnlocked(kv);
  const all = await kv.list<Action>(KV.actions);
  const projectActions = all.filter(a => actionProject(a) === projectId);
  const actions = projectActions.filter(a => !['done', 'cancelled'].includes(a.lifecycle || a.status));
  if (actions.length > 1000) fail('work_authority_project_too_large');
  const ids = new Set(actions.map(a => a.id));
  const edges = (await kv.list<ActionEdge>(KV.actionEdges))
    .filter(e => ids.has(e.sourceActionId) || ids.has(e.targetActionId))
    .map(e => ({ id: e.id, type: e.type, sourceActionId: e.sourceActionId, targetActionId: e.targetActionId }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const records = actions.map(a => ({ id: a.id, revision: a.revision || 0,
    projectId, status: a.status, owner: a.owner || null, assignedTo: a.assignedTo || null,
    awaitingHuman: Boolean(a.awaitingHuman), blocked: Boolean(a.blockedReason),
    notBefore: a.notBefore || null, parentId: a.parentId || null,
    contentDigest: digest(a),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const projectIds = new Set(projectActions.map(a => a.id));
  const activeLeases = (await kv.list<Lease>(KV.leases)).filter(l => projectIds.has(l.actionId)
    && l.status === 'active' && Date.parse(l.expiresAt) > Date.now()).map(l => l.actionId).sort();
  return { records, edges, activeLeases, sourceRevision: state.revision, sourceDigest: digest({ records, edges }) };
}

export function registerWorkAuthorityFunction(sdk: ISdk, kv: StateKV) {
  sdk.registerFunction('mem::work-authority-get', async (data: { projectId?: string; includeSnapshot?: boolean }) => {
    if (!isCanonicalProjectId(data?.projectId)) return { success: false, error: 'invalid_project_id' };
    return withActionStoreLock(async () => {
      const authority = await getWorkAuthority(kv, data.projectId!);
      return { success: true, protocol: 'work-authority/v1', projectId: data.projectId,
        phase: authority?.phase || 'agentmemory', generation: authority?.generation || 0,
        authority, ...(data.includeSnapshot === true ? { snapshot: await snapshot(kv, data.projectId!) } : {}) };
    });
  });

  sdk.registerFunction('mem::work-authority-transition', async (data: {
    protocol?: string; operation?: string; projectId?: string; planDigest?: string;
    sourceDigest?: string; generation?: number; selectedIds?: string[]; deferredIds?: string[];
    heldClaimIds?: string[];
    prefix?: string; mapping?: Array<{ sourceActionId: string; beadId: string }>;
    receiptDigest?: string; deferredTrackingId?: string; actor?: string;
  }) => {
    try {
      if (data?.protocol !== 'work-authority/v1' || !isCanonicalProjectId(data.projectId)
        || !HASH.test(data.planDigest || '') || !Number.isSafeInteger(data.generation)
        || !['freeze', 'commit'].includes(data.operation || '')) fail('invalid_authority_transition');
      const projectId = data.projectId!;
      return await withActionStoreLock(async () => {
        await recoverActionStoreUnlocked(kv);
        const authority = await getWorkAuthority(kv, projectId);
        if (data.operation === 'freeze') {
          if (authority) {
            if (authority.planDigest !== data.planDigest) fail('authority_plan_conflict');
            return { success: true, authority, replayed: true };
          }
          if (data.generation !== 0 || !HASH.test(data.sourceDigest || '')
            || !/^[a-z][a-z0-9]{1,7}$/.test(data.prefix || '')
            || !Array.isArray(data.selectedIds) || !data.selectedIds.length || data.selectedIds.length > 32
            || !Array.isArray(data.deferredIds) || data.deferredIds.length > 1000
            || [...data.selectedIds, ...data.deferredIds].some(id => !ID.test(id))
            || new Set([...data.selectedIds, ...data.deferredIds]).size !== data.selectedIds.length + data.deferredIds.length) {
            fail('invalid_freeze_scope');
          }
          const writeRevision = kv.maintenanceBarrier.snapshot();
          const source = await snapshot(kv, projectId);
          if (source.sourceDigest !== data.sourceDigest || source.activeLeases.length) fail('source_changed_or_leased');
          const heldClaims = source.records.filter(row => row.status === 'active' || row.assignedTo).map(row => row.id).sort();
          // A historical assignment is not an active lease. It may be held for
          // triage only when the reviewed plan names it explicitly; never admit
          // it as executable or alter its historical ownership/status.
          if (JSON.stringify(data.heldClaimIds || []) !== JSON.stringify(heldClaims)) fail('unreviewed_project_claims');
          const allIds = [...data.selectedIds, ...data.deferredIds].sort();
          if (JSON.stringify(allIds) !== JSON.stringify(source.records.map(a => a.id).sort())) fail('incomplete_project_disposition');
          for (const id of data.selectedIds) {
            const row = source.records.find(a => a.id === id)!;
            if (row.status !== 'pending' || row.assignedTo || row.awaitingHuman || row.blocked
              || (row.notBefore && Date.parse(row.notBefore) > Date.now())) fail('selected_work_not_admitted');
          }
          // This first cutover admits only closed dependency scopes. Arbitrary
          // mixed-authority and checkpoint relationships cannot become ready.
          if (source.edges.some(e => data.selectedIds!.includes(e.sourceActionId)
            || data.selectedIds!.includes(e.targetActionId))) fail('selected_dependencies_require_review');
          const frozen: WorkAuthority = { protocol: 'work-authority/v1', projectId, phase: 'frozen', generation: 1,
            planDigest: data.planDigest!, prefix: data.prefix!, sourceDigest: source.sourceDigest,
            sourceRevision: source.sourceRevision, selectedIds: [...data.selectedIds].sort(),
            deferredIds: [...data.deferredIds].sort(), heldClaimIds: heldClaims,
            frozenAt: new Date().toISOString(), actor: data.actor || 'work-importer' };
          const result = await kv.maintenanceBarrier.tryCommit(writeRevision, async invalidate => {
            for (const row of source.records) invalidate(row.id);
            await kv.set(KV.workAuthority, projectId, frozen);
            await recordAudit(kv, 'action_update', 'mem::work-authority-transition', frozen.selectedIds,
              { projectId, phase: 'frozen', planDigest: frozen.planDigest, generation: frozen.generation });
            return frozen;
          });
          if (!result.committed) fail('source_concurrent_write');
          return { success: true, authority: result.value, replayed: false };
        }
        if (!authority || authority.planDigest !== data.planDigest || authority.generation !== data.generation) fail('authority_plan_conflict');
        const beadPattern = new RegExp(`^${authority.prefix}-[a-z0-9]+$`);
        if (!HASH.test(data.receiptDigest || '') || !Array.isArray(data.mapping)
          || data.mapping.length !== authority.selectedIds.length
          || new Set(data.mapping.map(m => m.beadId)).size !== data.mapping.length
          || data.mapping.some(m => !ID.test(m.sourceActionId) || !beadPattern.test(m.beadId))
          || JSON.stringify(data.mapping.map(m => m.sourceActionId).sort()) !== JSON.stringify(authority.selectedIds)
          || (authority.deferredIds.length && !beadPattern.test(data.deferredTrackingId || ''))
          || data.mapping.some(m => m.beadId === data.deferredTrackingId)) fail('invalid_import_receipt');
        if (authority.phase === 'beads') {
          if (authority.receiptDigest !== data.receiptDigest || digest(authority.mapping) !== digest(data.mapping)
            || authority.deferredTrackingId !== data.deferredTrackingId) fail('authority_receipt_conflict');
          return { success: true, authority, replayed: true };
        }
        const committed: WorkAuthority = { ...authority, phase: 'beads', receiptDigest: data.receiptDigest,
          mapping: data.mapping, deferredTrackingId: data.deferredTrackingId, committedAt: new Date().toISOString() };
        await kv.set(KV.workAuthority, projectId, committed);
        await recordAudit(kv, 'action_update', 'mem::work-authority-transition', committed.selectedIds,
          { projectId, phase: 'beads', planDigest: committed.planDigest, receiptDigest: committed.receiptDigest });
        return { success: true, authority: committed, replayed: false };
      });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'authority_transition_failed' };
    }
  });
}
