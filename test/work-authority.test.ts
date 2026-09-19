import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { StateKV } from '../src/state/kv.js';
import { KV } from '../src/state/schema.js';
import { registerActionsFunction } from '../src/functions/actions.js';
import { registerFrontierFunction } from '../src/functions/frontier.js';
import { registerLeasesFunction } from '../src/functions/leases.js';
import { registerWorkAuthorityFunction } from '../src/functions/work-authority.js';
import { mockSdk } from './helpers/mocks.js';

// Real StateKV + barrier; clone values like the engine transport. No mocked
// write guard, process-local authority cache, or live engine writes.
function harness(store = new Map<string, Map<string, any>>()) {
  const sdk = mockSdk();
  sdk.registerFunction('state::list_groups', async () => ({ groups: [...store.keys()] }));
  for (const op of ['get', 'set', 'delete', 'list']) {
    sdk.registerFunction(`state::${op}`, async (raw: any) => {
      const { scope, key, value } = raw;
      if (op === 'get') return structuredClone(store.get(scope)?.get(key));
      if (op === 'list') return structuredClone([...store.get(scope)?.values() || []]);
      if (op === 'delete') { store.get(scope)?.delete(key); return; }
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, structuredClone(value));
      return structuredClone(value);
    });
  }
  const kv = new StateKV(sdk as never);
  registerActionsFunction(sdk as never, kv);
  registerFrontierFunction(sdk as never, kv);
  registerLeasesFunction(sdk as never, kv);
  registerWorkAuthorityFunction(sdk as never, kv);
  const call = (id: string, data: any = {}): Promise<any> => sdk.trigger(`mem::${id}`, data);
  const projectId = 'agent-workspace-config';
  const create = (data = {}) => call('action-create', { title: 'Curated implementation', projectId, actor: 'codex', ...data });
  const read = () => call('work-authority-get', { projectId });
  const freeze = async (selectedIds: string[], overrides = {}) => {
    const source = await read();
    return call('work-authority-transition', { protocol: 'work-authority/v1', operation: 'freeze',
      projectId, prefix: 'awc', generation: 0, planDigest: 'a'.repeat(64), sourceDigest: source.snapshot.sourceDigest,
      selectedIds, deferredIds: source.snapshot.records.map((a: any) => a.id).filter((id: string) => !selectedIds.includes(id)), ...overrides });
  };
  return { sdk, kv, call, create, read, freeze, projectId, store };
}

describe('project authority cutover', () => {
  it('freezes exact source scope, rejects old writes, keeps history and unrelated work', async () => {
    const h = harness();
    const { action } = await h.create();
    const deferred = (await h.create({ title: 'Old work needs triage' })).action;
    const history = await h.call('action-get', { actionId: action.id });
    const frozen = await h.freeze([action.id]);
    expect(frozen).toMatchObject({ success: true, authority: { phase: 'frozen', deferredIds: [deferred.id] } });
    expect(await h.create()).toMatchObject({ success: false, error: 'work_authority_read_only' });
    expect(await h.call('action-update', { actionId: action.id, projectId: 'other', status: 'done' }))
      .toMatchObject({ success: false, error: 'work_authority_read_only' });
    await expect(h.call('lease-acquire', { actionId: action.id, agentId: 'worker' }))
      .rejects.toThrow('work_authority_read_only');
    expect(await h.call('action-get', { actionId: action.id })).toMatchObject({
      action: history.action, events: history.events, workAuthority: { phase: 'frozen' },
    });
    expect(await h.create({ projectId: 'other' })).toMatchObject({ success: true });
    expect(await h.call('frontier', { project: h.projectId })).toMatchObject({ frontier: [] });
    const listed = await h.call('action-list', { project: h.projectId, view: 'actionable' });
    expect(listed.actions).toEqual([]);
    expect((await h.call('action-list', { project: h.projectId })).actions).toHaveLength(2);
  });

  it('guards raw action, edge and lease writes/deletes without poisoning the maintenance barrier', async () => {
    const h = harness();
    const { action } = await h.create();
    await h.freeze([action.id]);
    for (const [scope, key, value] of [
      [KV.actions, action.id, { ...action, projectId: 'other' }],
      [KV.actionEdges, 'edge', { sourceActionId: 'other', targetActionId: action.id }],
      [KV.leases, 'lease', { actionId: action.id }],
    ] as const) await expect(h.kv.set(scope, key, value)).rejects.toThrow('work_authority_read_only');
    await expect(h.kv.delete(KV.actions, action.id)).rejects.toThrow('work_authority_read_only');
    expect(h.kv.maintenanceBarrier.needsReconciliation).toBe(false);
  });

  it.each(['digest', 'omission', 'lease', 'dependency', 'human', 'assigned'])(
    'rejects unsafe admission: %s', async cause => {
      const h = harness();
      const { action } = await h.create(cause === 'human' ? { awaitingHuman: true } : cause === 'assigned' ? { assignedTo: 'worker' } : {});
      if (cause === 'assigned') await h.kv.set(KV.actions, action.id, { ...action, assignedTo: 'worker' });
      if (cause === 'omission') await h.create();
      if (cause === 'lease') await h.call('lease-acquire', { actionId: action.id, agentId: 'worker' });
      if (cause === 'dependency') {
        const other = (await h.create()).action;
        await h.kv.set(KV.actionEdges, 'edge', { id: 'edge', sourceActionId: action.id, targetActionId: other.id, type: 'requires' });
      }
      const result = await h.freeze([action.id], cause === 'digest' ? { sourceDigest: 'b'.repeat(64) }
        : cause === 'omission' ? { deferredIds: [] } : {});
      expect(result.success).toBe(false);
      expect((await h.read()).phase).toBe('agentmemory');
    });

  it('requires complete unique receipts; replay and process restart preserve the fence', async () => {
    const h = harness();
    const { action } = await h.create();
    await h.create();
    await h.freeze([action.id]);
    const payload = { protocol: 'work-authority/v1', operation: 'commit', projectId: h.projectId,
      generation: 1, planDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64),
      mapping: [{ sourceActionId: action.id, beadId: 'awc-abc' }], deferredTrackingId: 'awc-def' };
    expect((await h.call('work-authority-transition', { ...payload, mapping: [] })).success).toBe(false);
    expect(await h.call('work-authority-transition', payload)).toMatchObject({ success: true, authority: { phase: 'beads' } });
    const restarted = harness(h.store);
    expect(await restarted.call('work-authority-transition', payload)).toMatchObject({ success: true, replayed: true });
    expect((await restarted.call('work-authority-transition', { ...payload, receiptDigest: 'c'.repeat(64) })).success).toBe(false);
    expect(await restarted.create()).toMatchObject({ success: false, error: 'work_authority_read_only' });
  });

  it('refuses freeze while an engine writer is outstanding', async () => {
    const h = harness();
    const { action } = await h.create();
    let finish!: () => void;
    const pending = h.kv.maintenanceBarrier.mutate(KV.leases, 'lease', {}, () => new Promise<void>(r => { finish = r; }));
    expect(await h.freeze([action.id])).toMatchObject({ success: false, error: 'source_concurrent_write' });
    finish(); await pending;
    expect((await h.freeze([action.id])).success).toBe(true);
  });

  it('requires explicit quarantine of historical assignments and preserves their owner', async () => {
    const h = harness();
    const selected = (await h.create()).action;
    const legacy = (await h.create()).action;
    await h.kv.set(KV.actions, legacy.id, { ...legacy, assignedTo: 'historic-owner', status: 'active', lifecycle: 'active' });
    expect(await h.freeze([selected.id])).toMatchObject({ success: false, error: 'unreviewed_project_claims' });
    expect((await h.freeze([selected.id], { heldClaimIds: [legacy.id] })).success).toBe(true);
    expect(await h.kv.get(KV.actions, legacy.id)).toMatchObject({ assignedTo: 'historic-owner', status: 'active' });
  });
});
