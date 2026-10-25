import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { StateKV } from '../src/state/kv.js';
import { KV } from '../src/state/schema.js';
import { registerActionsFunction } from '../src/functions/actions.js';
import { registerFrontierFunction } from '../src/functions/frontier.js';
import { registerLeasesFunction } from '../src/functions/leases.js';
import { registerWorkAuthorityFunction } from '../src/functions/work-authority.js';
import { mockSdk } from './helpers/mocks.js';
import { createHash } from 'node:crypto';
import fixture from './fixtures/work-authority-defer-all.json';
import { ZERO_SELECTED_DEFER_ALL } from '../src/state/work-authority.js';
import { listAuditEntries } from '../src/state/partitioned-ledgers.js';
import { registerApiTriggers } from '../src/triggers/api.js';

// Real StateKV + barrier; clone values like the engine transport. No mocked
// write guard, process-local authority cache, or live engine writes.
function harness(store = new Map<string, Map<string, any>>(), projectId = 'agent-workspace-config') {
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
  const create = (data = {}) => call('action-create', { title: 'Curated implementation', projectId, actor: 'codex', ...data });
  const read = () => call('work-authority-get', { projectId, includeSnapshot: true });
  const freeze = async (selectedIds: string[], overrides = {}) => {
    const source = await read();
    return call('work-authority-transition', { protocol: 'work-authority/v1', operation: 'freeze',
      projectId, prefix: 'awc', generation: 0, planDigest: 'a'.repeat(64), sourceDigest: source.snapshot.sourceDigest,
      selectedIds, deferredIds: source.snapshot.records.map((a: any) => a.id).filter((id: string) => !selectedIds.includes(id)), ...overrides });
  };
  return { sdk, kv, call, create, read, freeze, projectId, store };
}

describe('project authority cutover', () => {
  it('ordinary authority reads never scan historical collections', async () => {
    const h = harness();
    await h.create();
    const list = vi.spyOn(h.kv, 'list');
    expect(await h.call('work-authority-get', { projectId: h.projectId })).toMatchObject({ phase: 'agentmemory' });
    expect(list).not.toHaveBeenCalled();
  });
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

async function deferredHarness() {
  const h = harness(undefined, fixture.projectId);
  for (const row of fixture.records) await h.kv.set(KV.actions, row.id, row);
  const source = await h.read();
  const plan = { selectionMode: ZERO_SELECTED_DEFER_ALL, projectId: h.projectId, snapshot: source.snapshot };
  const freezePayload = {
    protocol: 'work-authority/v1', operation: 'freeze', projectId: h.projectId, prefix: fixture.prefix,
    generation: 0, selectionMode: ZERO_SELECTED_DEFER_ALL,
    planDigest: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    sourceDigest: source.snapshot.sourceDigest, sourceRevision: source.snapshot.sourceRevision,
    selectedIds: [], deferredIds: fixture.records.map(row => row.id),
    heldClaimIds: fixture.records.filter(row => row.assignedTo).map(row => row.id),
  };
  const commitPayload = { protocol: 'work-authority/v1', operation: 'commit', projectId: h.projectId,
    generation: 1, selectionMode: ZERO_SELECTED_DEFER_ALL, planDigest: freezePayload.planDigest,
    receiptDigest: 'b'.repeat(64), mapping: [], deferredTrackingId: 'wsh-triage' };
  const transition = (payload: any) => h.call('work-authority-transition', payload);
  return { ...h, source, freezePayload, commitPayload, transition,
    zeroFreeze: (overrides = {}) => transition({ ...freezePayload, ...overrides }),
    zeroCommit: (overrides = {}) => transition({ ...commitPayload, ...overrides }),
  };
}

describe('explicit zero-selected defer-all cutover', () => {
  it('preserves all 15 records and both held claims, fences every writer and admits no work across restart', async () => {
    const h = await deferredHarness();
    const before = await h.kv.list(KV.actions);
    const frozen = await h.zeroFreeze();
    expect(frozen).toMatchObject({ success: true, replayed: false, authority: {
      phase: 'frozen', generation: 1, selectionMode: ZERO_SELECTED_DEFER_ALL,
      selectedIds: [], deferredIds: h.freezePayload.deferredIds, heldClaimIds: h.freezePayload.heldClaimIds,
      sourceDigest: h.freezePayload.sourceDigest, sourceRevision: h.freezePayload.sourceRevision,
      planDigest: h.freezePayload.planDigest,
    } });
    expect(frozen.authority.deferredIds).toHaveLength(15);
    expect(frozen.authority.heldClaimIds).toHaveLength(2);
    const audits = await listAuditEntries(h.kv);
    expect(await h.zeroFreeze()).toEqual({ ...frozen, replayed: true });
    expect(await listAuditEntries(h.kv)).toEqual(audits);
    expect(await h.create()).toMatchObject({ success: false, error: 'work_authority_read_only' });
    expect(await h.call('action-update', { actionId: fixture.records[0].id, status: 'active' }))
      .toMatchObject({ success: false, error: 'work_authority_read_only' });
    await expect(h.call('lease-acquire', { actionId: fixture.records[0].id, agentId: 'worker' }))
      .rejects.toThrow('work_authority_read_only');
    for (const [scope, key, value] of [
      [KV.actions, fixture.records[0].id, { ...fixture.records[0], projectId: 'other' }],
      [KV.actionEdges, 'edge', { sourceActionId: fixture.records[0].id, targetActionId: 'act_other' }],
      [KV.leases, 'lease', { actionId: fixture.records[0].id }],
    ] as const) await expect(h.kv.set(scope, key, value)).rejects.toThrow('work_authority_read_only');
    await expect(h.kv.delete(KV.actions, fixture.records[0].id)).rejects.toThrow('work_authority_read_only');
    await expect(h.kv.update(KV.actions, fixture.records[0].id, [])).rejects.toThrow('work_authority_read_only');
    expect(await h.call('frontier', { project: h.projectId })).toMatchObject({ frontier: [] });
    expect(await h.call('action-list', { project: h.projectId, view: 'actionable' })).toMatchObject({ actions: [] });
    expect((await h.call('action-list', { project: h.projectId })).actions).toHaveLength(15);
    expect(await h.kv.list(KV.actions)).toEqual(before);
    const committed = await h.zeroCommit();
    expect(committed).toMatchObject({ success: true, replayed: false, authority: {
      ...frozen.authority, phase: 'beads', mapping: [], deferredTrackingId: 'wsh-triage', receiptDigest: 'b'.repeat(64),
    } });
    const restarted = harness(h.store, h.projectId);
    const committedAudits = await listAuditEntries(h.kv);
    expect(await restarted.call('work-authority-transition', h.commitPayload)).toEqual({ ...committed, replayed: true });
    expect(await restarted.call('work-authority-transition', h.freezePayload)).toEqual({ ...committed, replayed: true });
    expect(await listAuditEntries(restarted.kv)).toEqual(committedAudits);
    expect(await restarted.call('frontier', { project: h.projectId })).toMatchObject({ frontier: [] });
    expect(await restarted.kv.list(KV.actions)).toEqual(before);
    expect(await restarted.create()).toMatchObject({ success: false, error: 'work_authority_read_only' });
    expect(await restarted.create({ projectId: 'other' })).toMatchObject({ success: true });
    expect(await restarted.call('work-authority-transition', h.freezePayload)).toMatchObject({ success: true, replayed: true });
  });

  it.each([
    ['accidental empty selection', { selectionMode: undefined }],
    ['boolean opt-in', { selectionMode: true }],
    ['unknown mode version', { selectionMode: 'zero-selected-defer-all/v2' }],
    ['missing selection', { selectedIds: undefined }],
    ['null selection', { selectedIds: null }],
    ['nonempty selection', { selectedIds: ['act_fixture_01'] }],
    ['missing dispositions', { deferredIds: undefined }],
    ['empty dispositions', { deferredIds: [] }],
    ['duplicate dispositions', { deferredIds: ['act_fixture_01', 'act_fixture_01'] }],
    ['wrong disposition type', { deferredIds: 'act_fixture_01' }],
    ['malformed ID', { deferredIds: ['../workstation-shell'] }],
    ['missing held claims', { heldClaimIds: undefined }],
    ['null held claims', { heldClaimIds: null }],
    ['duplicate held claims', { heldClaimIds: ['act_fixture_09', 'act_fixture_09'] }],
    ['unsorted held claims', { heldClaimIds: ['act_fixture_10', 'act_fixture_09'] }],
    ['unknown held claim', { heldClaimIds: ['act_unknown'] }],
    ['missing revision', { sourceRevision: undefined }],
    ['negative revision', { sourceRevision: -1 }],
    ['fractional revision', { sourceRevision: 0.5 }],
    ['string revision', { sourceRevision: '0' }],
    ['stale revision', { sourceRevision: 9000 }],
    ['wrong phase generation', { generation: 1 }],
    ['negative generation', { generation: -1 }],
    ['wrong protocol', { protocol: 'work-authority/v2' }],
    ['bad plan hash', { planDigest: 'bad' }],
    ['coerced plan hash', { planDigest: ['a'.repeat(64)] }],
    ['bad source hash', { sourceDigest: 'b'.repeat(64) }],
    ['coerced source hash', { sourceDigest: ['b'.repeat(64)] }],
    ['bad prefix', { prefix: 'wsh.*' }],
    ['coerced prefix', { prefix: ['wsh'] }],
  ])('rejects %s before publishing authority', async (_name, overrides) => {
    const h = await deferredHarness();
    const before = structuredClone(h.store);
    expect(await h.zeroFreeze(overrides)).toMatchObject({ success: false });
    expect(h.store).toEqual(before);
    expect((await h.read()).phase).toBe('agentmemory');
  });

  it.each(['omitted', 'extra', 'reordered', 'claim_omitted', 'claim_added', 'oversized'])('rejects %s disposition', async cause => {
    const h = await deferredHarness();
    const deferredIds = cause === 'omitted' ? h.freezePayload.deferredIds.slice(1)
      : cause === 'extra' ? [...h.freezePayload.deferredIds, 'act_unknown']
      : cause === 'reordered' ? [...h.freezePayload.deferredIds].reverse()
      : cause === 'oversized' ? Array.from({ length: 1001 }, (_, i) => `act_${i}`)
      : h.freezePayload.deferredIds;
    expect(await h.zeroFreeze({ deferredIds,
      heldClaimIds: cause === 'claim_omitted' ? [] : cause === 'claim_added'
        ? ['act_fixture_01', ...h.freezePayload.heldClaimIds] : h.freezePayload.heldClaimIds,
    })).toMatchObject({ success: false });
    expect(await h.kv.get(KV.workAuthority, h.projectId)).toBeNull();
  });

  it('rejects an empty project even with the opt-in', async () => {
    const h = await deferredHarness();
    h.store.get(KV.actions)!.clear();
    const source = await h.read();
    expect(await h.zeroFreeze({ deferredIds: [], heldClaimIds: [], sourceDigest: source.snapshot.sourceDigest }))
      .toMatchObject({ success: false, error: 'invalid_freeze_scope' });
  });

  it.each(['record', 'revision', 'new_record', 'removed_record', 'closed_record', 'edge'])(
    'rejects source drift before freezing: %s', async cause => {
      const h = await deferredHarness();
      const rows = h.store.get(KV.actions)!;
      const row = rows.get('act_fixture_01');
      if (cause === 'record') row.title = 'changed';
      if (cause === 'revision') row.revision++;
      if (cause === 'new_record') rows.set('act_new', { ...row, id: 'act_new' });
      if (cause === 'removed_record') rows.delete(row.id);
      if (cause === 'closed_record') { row.status = 'done'; row.lifecycle = 'done'; }
      if (cause === 'edge') await h.kv.set(KV.actionEdges, 'edge', { id: 'edge', type: 'requires', sourceActionId: row.id, targetActionId: 'act_other' });
      expect(await h.zeroFreeze()).toMatchObject({ success: false, error: 'source_changed_or_leased' });
      expect(await h.kv.get(KV.workAuthority, h.projectId)).toBeNull();
    });

  it('holds active, assigned, gated and dependent history without selecting or altering it', async () => {
    const h = await deferredHarness();
    const row = h.store.get(KV.actions)!.get('act_fixture_01');
    row.status = row.lifecycle = 'active';
    await h.kv.set(KV.actionEdges, 'edge', { id: 'edge', type: 'requires', sourceActionId: row.id, targetActionId: 'act_fixture_02' });
    const source = await h.read();
    const before = structuredClone(h.store.get(KV.actions));
    expect(await h.zeroFreeze({ sourceDigest: source.snapshot.sourceDigest,
      heldClaimIds: [row.id, ...h.freezePayload.heldClaimIds] })).toMatchObject({ success: true });
    expect(h.store.get(KV.actions)).toEqual(before);
    expect(await h.zeroCommit()).toMatchObject({ success: true, authority: { selectedIds: [], mapping: [] } });
  });

  it.each(['active', 'invalid_expiry', 'unknown_status', 'missing_status', 'closed_action'])('rejects unsafe project lease: %s', async cause => {
    const h = await deferredHarness();
    let actionId = fixture.records[0].id;
    if (cause === 'closed_action') {
      actionId = 'act_closed';
      await h.kv.set(KV.actions, actionId, { ...fixture.records[0], id: actionId, status: 'done', lifecycle: 'done' });
    }
    await h.kv.set(KV.leases, 'lease', { id: 'lease', actionId,
      status: cause === 'unknown_status' ? 'unknown' : cause === 'missing_status' ? undefined : 'active',
      expiresAt: cause === 'invalid_expiry' ? 'invalid' : '2999-01-01T00:00:00Z' });
    expect(await h.zeroFreeze()).toMatchObject({ success: false, error: 'source_changed_or_leased' });
  });

  it.each(['expired', 'released', 'unrelated'])('allows %s lease without changing it', async cause => {
    const h = await deferredHarness();
    const lease = { id: 'lease', actionId: cause === 'unrelated' ? 'act_other' : fixture.records[0].id,
      status: cause === 'released' ? 'released' : 'active', expiresAt: cause === 'expired' ? '2000-01-01' : '2999-01-01' };
    await h.kv.set(KV.leases, lease.id, lease);
    expect(await h.zeroFreeze()).toMatchObject({ success: true });
    expect(await h.zeroCommit()).toMatchObject({ success: true });
    expect(await h.kv.get(KV.leases, lease.id)).toEqual(lease);
  });

  it.each(['freeze', 'freeze_replay', 'commit', 'commit_replay'])('rejects an outstanding writer during %s', async operation => {
    const h = await deferredHarness();
    if (operation !== 'freeze') await h.zeroFreeze();
    if (operation === 'commit_replay') await h.zeroCommit();
    const before = await h.kv.get(KV.workAuthority, h.projectId);
    let release!: () => void;
    const pending = h.kv.maintenanceBarrier.mutate(KV.leases, 'lease', {}, () => new Promise<void>(resolve => { release = resolve; }));
    try {
      expect(await (operation.startsWith('freeze') ? h.zeroFreeze() : h.zeroCommit()))
        .toMatchObject({ success: false, error: 'source_concurrent_write' });
      expect(await h.kv.get(KV.workAuthority, h.projectId)).toEqual(before);
    } finally { release(); await pending; }
  });

  it.each(['freeze_replay', 'commit', 'commit_replay'])('rechecks source and leases during %s', async operation => {
    const h = await deferredHarness();
    await h.zeroFreeze();
    if (operation === 'commit_replay') await h.zeroCommit();
    const before = await h.kv.get(KV.workAuthority, h.projectId);
    const row = h.store.get(KV.actions)!.get('act_fixture_01');
    const title = row.title;
    row.title = 'out-of-band source drift';
    const run = () => operation === 'freeze_replay' ? h.zeroFreeze() : h.zeroCommit();
    expect(await run()).toMatchObject({ success: false, error: 'source_changed_or_leased' });
    row.title = title;
    h.store.set(KV.leases, new Map([['lease', { actionId: row.id, status: 'active', expiresAt: '2999-01-01' }]]));
    expect(await run()).toMatchObject({ success: false, error: 'source_changed_or_leased' });
    expect(await h.kv.get(KV.workAuthority, h.projectId)).toEqual(before);
  });

  it.each(['mode', 'generation', 'plan', 'source', 'revision', 'prefix', 'deferred', 'held', 'selected'])(
    'binds freeze replay to the original %s', async field => {
      const h = await deferredHarness();
      const frozen = await h.zeroFreeze();
      const changes: Record<string, any> = { mode: { selectionMode: undefined }, generation: { generation: 1 },
        plan: { planDigest: 'c'.repeat(64) }, source: { sourceDigest: 'd'.repeat(64) }, revision: { sourceRevision: 1 },
        prefix: { prefix: 'other' }, deferred: { deferredIds: h.freezePayload.deferredIds.slice(1) },
        held: { heldClaimIds: [] }, selected: { selectedIds: ['act_fixture_01'] } };
      expect(await h.zeroFreeze(changes[field])).toMatchObject({ success: false });
      expect(await h.kv.get(KV.workAuthority, h.projectId)).toEqual(frozen.authority);
    });

  it.each([
    ['missing mode', { selectionMode: undefined }], ['wrong mode', { selectionMode: 'zero-selected-defer-all/v2' }],
    ['wrong generation', { generation: 0 }], ['wrong plan', { planDigest: 'c'.repeat(64) }],
    ['no receipt', { receiptDigest: undefined }], ['invalid receipt', { receiptDigest: 'bad' }],
    ['coerced receipt', { receiptDigest: ['b'.repeat(64)] }], ['no mapping', { mapping: undefined }],
    ['null mapping', { mapping: null }], ['selected mapping', { mapping: [{ sourceActionId: 'act_fixture_01', beadId: 'wsh-task' }] }],
    ['no triage', { deferredTrackingId: undefined }], ['wrong triage prefix', { deferredTrackingId: 'other-triage' }],
    ['invalid triage', { deferredTrackingId: 'wsh-../oops' }], ['coerced triage', { deferredTrackingId: ['wsh-triage'] }],
  ])('rejects commit with %s', async (_name, overrides) => {
    const h = await deferredHarness();
    await h.zeroFreeze();
    const before = structuredClone(h.store);
    expect(await h.zeroCommit(overrides)).toMatchObject({ success: false });
    expect(h.store).toEqual(before);
  });

  it('cannot commit without a freeze or change an already committed receipt', async () => {
    const h = await deferredHarness();
    expect(await h.zeroCommit()).toMatchObject({ success: false, error: 'authority_plan_conflict' });
    await h.zeroFreeze(); await h.zeroCommit();
    for (const changes of [{ receiptDigest: 'c'.repeat(64) }, { deferredTrackingId: 'wsh-other' }]) {
      expect(await h.zeroCommit(changes)).toMatchObject({ success: false, error: 'authority_receipt_conflict' });
    }
  });

  it.each([
    { selectionMode: undefined }, { selectionMode: 'zero-selected-defer-all/v2' }, { generation: 0 },
    { selectedIds: ['act_fixture_01'] }, { deferredIds: [] }, { deferredIds: ['act_fixture_01', 'act_fixture_01'] },
    { heldClaimIds: ['act_unknown'] }, { heldClaimIds: null }, { prefix: '.*' }, { sourceRevision: -1 },
    { sourceDigest: 'bad' }, { planDigest: 'bad' }, { phase: 'agentmemory' }, { mapping: [] },
  ])('fails closed on a malformed persisted zero-selection authority: %j', async corruption => {
    const h = await deferredHarness();
    await h.zeroFreeze();
    const stored = h.store.get(KV.workAuthority)!.get(h.projectId);
    Object.assign(stored, corruption);
    const restarted = harness(h.store, h.projectId);
    await expect(restarted.read()).rejects.toThrow('work_authority_invalid');
    expect(await restarted.call('work-authority-transition', h.commitPayload)).toMatchObject({ success: false, error: 'work_authority_invalid' });
    await expect(restarted.kv.set(KV.actions, fixture.records[0].id, fixture.records[0])).rejects.toThrow('work_authority_invalid');
  });

  it.each(['deferredIds', 'heldClaimIds'])('rechecks persisted %s against the source', async field => {
    const h = await deferredHarness();
    await h.zeroFreeze();
    const stored = h.store.get(KV.workAuthority)!.get(h.projectId);
    stored[field] = stored[field].slice(1);
    expect(await h.zeroCommit()).toMatchObject({ success: false, error: 'authority_scope_conflict' });
  });

  it.each(['freeze_before', 'freeze_after', 'commit_before', 'commit_after'])('keeps partial storage failure fenced: %s', async failure => {
    const h = await deferredHarness();
    const commit = failure.startsWith('commit');
    if (commit) await h.zeroFreeze();
    const set = h.kv.set.bind(h.kv);
    const spy = vi.spyOn(h.kv, 'set').mockImplementation(async (scope, key, value) => {
      if (scope !== KV.workAuthority) return set(scope, key, value);
      if (failure.endsWith('after')) await set(scope, key, value);
      throw new Error('synthetic_storage_failure');
    });
    expect(await (commit ? h.zeroCommit() : h.zeroFreeze())).toMatchObject({ success: false, error: 'synthetic_storage_failure' });
    spy.mockRestore();
    expect(h.kv.maintenanceBarrier.needsReconciliation).toBe(true);
    expect(await (commit ? h.zeroCommit() : h.zeroFreeze())).toMatchObject({ success: false, error: 'source_concurrent_write' });
    const restarted = harness(h.store, h.projectId);
    const result = await restarted.call('work-authority-transition', commit ? h.commitPayload : h.freezePayload);
    expect(result).toMatchObject({ success: true, replayed: failure.endsWith('after') });
    expect(await restarted.kv.list(KV.actions)).toEqual(fixture.records);
  });

  it('does not let zero mode reinterpret an existing nonempty import', async () => {
    const h = harness();
    const { action } = await h.create();
    const frozen = await h.freeze([action.id]);
    expect(frozen.authority).not.toHaveProperty('selectionMode');
    expect(await h.freeze([action.id], { selectionMode: ZERO_SELECTED_DEFER_ALL }))
      .toMatchObject({ success: false, error: 'authority_selection_mode_conflict' });
    expect(await h.freeze([action.id])).toEqual({ ...frozen, replayed: true });
  });

  it('whitelists the opt-in and revision through authenticated REST with real transition validation', async () => {
    const h = await deferredHarness();
    registerApiTriggers(h.sdk as never, h.kv, 'fixture-secret');
    const run = (body: any, headers = { authorization: 'Bearer fixture-secret' }) => h.sdk.trigger('api::work-authority-transition', { headers, body });
    expect(await run(h.freezePayload, {} as any)).toMatchObject({ status_code: 401 });
    expect(await run({ ...h.freezePayload, selectionMode: undefined })).toMatchObject({ body: { success: false } });
    const trigger = vi.spyOn(h.sdk, 'trigger');
    expect(await run({ ...h.freezePayload, unknown: 'must not be forwarded' }))
      .toMatchObject({ status_code: 200, body: { success: true, authority: { selectionMode: ZERO_SELECTED_DEFER_ALL } } });
    expect(trigger).toHaveBeenCalledWith({ function_id: 'mem::work-authority-transition', payload: h.freezePayload });
    expect(await run(h.commitPayload)).toMatchObject({ body: { success: true, authority: { phase: 'beads', mapping: [] } } });
  });
});
