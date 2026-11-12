import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateKV } from '../src/state/kv.js';
import { KV } from '../src/state/schema.js';
import { listAuditEntries } from '../src/state/partitioned-ledgers.js';
import { withActionStoreLock } from '../src/functions/action-store.js';
import { registerActionsFunction } from '../src/functions/actions.js';
import { registerLeasesFunction } from '../src/functions/leases.js';
import { registerWorkAuthorityFunction } from '../src/functions/work-authority.js';
import { CloseoutGuardController, registerCloseoutGuardFunctions } from '../src/functions/closeout-guard.js';
import { CLOSEOUT_GUARD_PROTOCOL, closeoutAliases } from '../src/functions/closeout-guard-policy.js';
import { registerApiTriggers } from '../src/triggers/api.js';
import type { NativeGuard } from '../src/state/closeout-guard-native.js';
import { mockSdk } from './helpers/mocks.js';

vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const session = 'shared-auto-launch-interactive-codex-test';
const request = (requestId = 'request-1', target = session) => ({ protocol: CLOSEOUT_GUARD_PROTOCOL, requestId, session: target, projectIds: ['repo'] });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const fixtures: Array<ReturnType<typeof fixture>> = [];
function fixture(options: { acquisitionMs?: number; lifetimeMs?: number; releaseWaitMs?: number } = {}) {
  const sdk = mockSdk(), store = new Map<string, Map<string, any>>();
  const hooks: { before?: (call: any) => Promise<void>; after?: (call: any) => Promise<void> } = {};
  for (const op of ['get', 'list', 'set', 'delete', 'list_groups']) {
    sdk.registerFunction(`state::${op}`, async (raw: any) => {
      const call = { op, ...raw }; await hooks.before?.(call);
      let result;
      if (op === 'get') result = store.get(raw.scope)?.get(raw.key);
      else if (op === 'list') result = [...store.get(raw.scope)?.values() || []];
      else if (op === 'list_groups') result = { groups: [...store.keys()] };
      else if (op === 'set') {
        if (!store.has(raw.scope)) store.set(raw.scope, new Map());
        store.get(raw.scope)!.set(raw.key, structuredClone(raw.value)); result = raw.value;
      } else store.get(raw.scope)?.delete(raw.key);
      const cloned = structuredClone(result); await hooks.after?.(call); return cloned;
    });
  }
  const kv = new StateKV(sdk as never), secondKv = new StateKV(sdk as never);
  const native = { initialize: vi.fn(async () => {}), begin: vi.fn(async () => {
    const done = deferred(), live: unknown[] = [];
    const guard: NativeGuard = { lock: { file: '/fixture/lock', pid: process.pid, fd: 9, dev: '1', ino: '2',
      startTicks: '3', socket: '/fixture/socket', nonce: 'b'.repeat(64) }, liveFile: '/fixture/live',
      activate: value => { live.push(value); }, revoke: vi.fn(() => { if (native.autoDrain) done.resolve(); }), drained: done.promise };
    native.guards.push({ guard, done, live }); return guard;
  }), autoDrain: true, guards: [] as Array<{ guard: NativeGuard; done: ReturnType<typeof deferred>; live: unknown[] }> };
  const controller = new CloseoutGuardController(kv, { native, ...options });
  registerActionsFunction(sdk as never, kv); registerLeasesFunction(sdk as never, kv);
  registerWorkAuthorityFunction(sdk as never, kv); registerCloseoutGuardFunctions(sdk as never, controller);
  const call = (id: string, payload: unknown = {}) => sdk.trigger(`mem::${id}`, payload) as Promise<any>;
  const create = async (overrides = {}) => (await call('action-create', { title: 'Private title', description: 'Private description',
    projectId: 'repo', tags: [], actor: 'fixture', ...overrides })).action;
  const acquire = (body = request()) => call('closeout-guard-acquire', body);
  const release = (row: any) => call('closeout-guard-release', { protocol: CLOSEOUT_GUARD_PROTOCOL, guardId: row.guardId, capability: row.capability });
  const f = { sdk, store, hooks, kv, secondKv, native, controller, call, create, acquire, release };
  fixtures.push(f); return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.hooks.before = undefined; f.hooks.after = undefined;
    f.native.autoDrain = true;
    for (const g of f.native.guards) g.done.resolve();
  }
  await tick();
  vi.unstubAllEnvs();
});

describe('closeout write guard', () => {
  it('accepts the broker managed-name alphabet and refuses external or path-like names', async () => {
    const f = fixture();
    const held = await f.acquire(request('dotted', `${session}.v2_1`));
    expect(held.success).toBe(true); await f.release(held);
    for (const target of ['shared-web-term-1', 'external-1', `${session}/child`, `${session}\n`]) {
      expect(await f.acquire(request('invalid-name', target))).toMatchObject({ success: false, error: 'closeout_guard_invalid_request' });
    }
  });

  it('holds fresh engine state and audits without secrets, with a stable evidence digest', async () => {
    const f = fixture(); await f.create();
    const first = await f.acquire(); expect(first.success).toBe(true);
    expect(first.snapshot).toMatchObject({ actionRevision: 1, claims: [], activeLeases: [], actions: { count: 1 }, leases: { count: 0 } });
    const live = f.native.guards[0].live[0] as any;
    expect(live).toMatchObject({ guardId: first.guardId, evidenceDigest: first.evidenceDigest, engine: { pid: process.pid } });
    expect(JSON.stringify(live)).not.toContain(first.capability);
    expect(await f.release(first)).toMatchObject({ success: true, status: 'released', released: true });
    const second = await f.acquire(request('request-2'));
    expect(second.evidenceDigest).toBe(first.evidenceDigest);
    expect(second.snapshot).toEqual(first.snapshot); expect(second.guardId).not.toBe(first.guardId);
    await f.release(second);
    const audit = await listAuditEntries(f.kv);
    expect(audit.filter(r => r.operation === 'closeout_guard').map(r => r.details.phase)).toEqual(['acquired', 'revoked', 'drained', 'acquired', 'revoked', 'drained']);
    expect(JSON.stringify(audit)).not.toContain(first.capability);
    expect(JSON.stringify(audit)).not.toContain(first.lock.nonce);
    expect(JSON.stringify(first.snapshot)).not.toContain('Private');
  });

  it.each(['owner', 'assignedTo', 'tag', 'truncated_owner', 'truncated_tag'])('refuses a bound active action through %s', async binding => {
    const f = fixture(), target = `${session}-${'x'.repeat(140)}`;
    const extra = binding === 'tag' ? { tags: [`tmux:${target}`] }
      : binding === 'truncated_tag' ? { tags: [`tmux:${target.slice(0, 128)}`] }
      : binding === 'truncated_owner' ? { assignedTo: `wsh:${target.slice(0, 128)}` }
      : { [binding]: target };
    const action = await f.create(extra);
    await f.kv.set(KV.actions, action.id, { ...action, ...extra });
    expect(await f.acquire(request('bound', target))).toMatchObject({ success: false, error: 'closeout_guard_session_claimed' });
  });

  it.each(['orphan', 'other-project', 'short-alias'])('refuses active %s lease independently of action filtering', async kind => {
    const f = fixture(), target = `${session}-${'x'.repeat(140)}`;
    const a = kind === 'other-project' ? await f.create({ projectId: 'elsewhere' }) : { id: 'act_missing' };
    await f.kv.set(KV.leases, 'lse_one', { id: 'lse_one', actionId: a.id,
      agentId: kind === 'short-alias' ? `wsh:${target.slice(0, 128)}` : `wsh:${target}`,
      status: 'active', acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await f.acquire(request('lease', target))).toMatchObject({ success: false, error: 'closeout_guard_session_claimed' });
  });

  it.each(['actions-null', 'action-duplicate', 'action-status', 'action-tags', 'lease-expiry', 'lease-identity', 'lease-status'])('refuses malformed inventory %s', async kind => {
    const f = fixture(), original = f.kv.list.bind(f.kv);
    const a = await f.create();
    const row = { id: 'lse_one', actionId: a.id, agentId: session, status: 'active', acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    f.kv.list = (async scope => {
      if (scope === KV.actions && kind === 'actions-null') return null;
      if (scope === KV.actions && kind === 'action-duplicate') return [a, a];
      if (scope === KV.actions && kind === 'action-status') return [{ ...a, status: 'unknown' }];
      if (scope === KV.actions && kind === 'action-tags') return [{ ...a, tags: undefined }];
      if (scope === KV.leases && kind === 'lease-expiry') return [{ ...row, expiresAt: 'bad' }];
      if (scope === KV.leases && kind === 'lease-identity') return [{ ...row, agentId: undefined }];
      if (scope === KV.leases && kind === 'lease-status') return [{ ...row, status: 'unknown' }];
      return original(scope);
    }) as typeof f.kv.list;
    expect(await f.acquire()).toMatchObject({ success: false });
    expect(f.native.guards[0].live).toEqual([]);
  });

  it('recovers a pending action event before deciding that the session is unclaimed', async () => {
    const f = fixture(), a = await f.create();
    await f.kv.set(KV.actionEvents, 'aev_pending', { id: 'aev_pending', actionId: a.id, entityType: 'action', schemaVersion: 2,
      revision: 2, timestamp: new Date().toISOString(), actor: 'fixture', type: 'fields_changed', after: { ...a, revision: 2, owner: session } });
    await f.kv.set(KV.actionState, 'current', { schemaVersion: 2, revision: 1, updatedAt: new Date().toISOString(),
      pending: { revision: 2, eventId: 'aev_pending', eventScope: KV.actionEvents } });
    expect(await f.acquire()).toMatchObject({ success: false, error: 'closeout_guard_session_claimed' });
    expect(await f.kv.get(KV.actions, a.id)).toMatchObject({ owner: session, revision: 2 });
  });

  it('refuses a lease mutation already in flight before its storage effect', async () => {
    const f = fixture(), entered = deferred(), finish = deferred();
    f.hooks.before = async c => { if (c.op === 'set' && c.scope === KV.leases) { entered.resolve(); await finish.promise; } };
    const writer = f.secondKv.set(KV.leases, 'lse_one', { id: 'lse_one' }); await entered.promise;
    expect(await f.acquire()).toMatchObject({ success: false, error: 'closeout_guard_concurrent_write' });
    finish.resolve(); await writer;
  });

  it('holds action writes, independent lease renewal, and public authority reads until drain', async () => {
    const f = fixture(), a = await f.create();
    await f.call('lease-acquire', { actionId: a.id, agentId: 'other' });
    const held = await f.acquire(); expect(held.success).toBe(true);
    let changed = false, renewed = false, read = false;
    const write = f.call('action-update', { actionId: a.id, title: 'new' }).then(() => { changed = true; });
    const renew = f.call('lease-renew', { actionId: a.id, agentId: 'other' }).then(() => { renewed = true; });
    const authority = f.call('work-authority-get', { projectId: 'repo' }).then(() => { read = true; });
    await tick(); expect([changed, renewed, read]).toEqual([false, false, false]);
    await f.release(held); await Promise.all([write, renew, authority]);
    expect([changed, renewed, read]).toEqual([true, true, true]);
  });

  it('keeps writers blocked on uncertain revoke/drain and resumes only after proof', async () => {
    const f = fixture({ releaseWaitMs: 5 }); f.native.autoDrain = false;
    const held = await f.acquire(), g = f.native.guards[0];
    g.guard.revoke = () => { throw new Error('transport uncertain'); };
    let wrote = false;
    const write = f.secondKv.set(KV.actions, 'act_other', { id: 'act_other', tags: [], status: 'pending' }).then(() => { wrote = true; });
    expect(await f.release(held)).toMatchObject({ success: false, status: 'draining', released: false });
    await tick(); expect(wrote).toBe(false);
    g.done.resolve(); await write;
    expect(await f.release(held)).toMatchObject({ status: 'released', released: true, success: false });
  });

  it('invalidates stale target writes queued at the maintenance barrier', async () => {
    const f = fixture(), held = await f.acquire();
    const write = f.secondKv.set(KV.actions, 'act_stale', { id: 'act_stale', assignedTo: session });
    const denied = expect(write).rejects.toThrow('maintenance_write_conflict');
    await f.release(held); await denied;
  });

  it('serializes a claim arriving while the final inventory read is outstanding', async () => {
    const f = fixture(), entered = deferred(), finish = deferred();
    f.hooks.after = async c => { if (c.op === 'list' && c.scope === KV.actions) { entered.resolve(); await finish.promise; } };
    const capture = f.acquire(); await entered.promise;
    const write = f.secondKv.set(KV.actions, 'act_late', { id: 'act_late', status: 'active', assignedTo: session, tags: [] });
    const denied = expect(write).rejects.toThrow('maintenance_write_conflict');
    await tick(); expect(f.store.get(KV.actions)?.has('act_late')).not.toBe(true);
    finish.resolve(); const held = await capture; expect(held.success).toBe(true);
    await f.release(held); await denied;
  });

  it('allows terminal historical bindings and released leases', async () => {
    const f = fixture(), a = await f.create();
    await f.kv.set(KV.actions, a.id, { ...a, status: 'done', lifecycle: 'done', owner: session, tags: [`tmux:${session}`] });
    await f.kv.set(KV.leases, 'lse_old', { id: 'lse_old', actionId: a.id, agentId: `wsh:${session}`, status: 'released',
      acquiredAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-01T01:00:00Z' });
    const held = await f.acquire(); expect(held.success).toBe(true); await f.release(held);
  });

  it('expires a queued acquire without acquiring later', async () => {
    const f = fixture({ acquisitionMs: 10 }), entered = deferred(), end = deferred();
    const writer = withActionStoreLock(async () => { entered.resolve(); await end.promise; }); await entered.promise;
    expect(await f.acquire()).toMatchObject({ error: 'closeout_guard_acquire_expired' });
    end.resolve(); await writer; await tick(); expect(f.native.begin).not.toHaveBeenCalled();
  });

  it('revokes at expiry without releasing writers until native completion', async () => {
    const f = fixture({ lifetimeMs: 30, releaseWaitMs: 5 }); f.native.autoDrain = false;
    const held = await f.acquire(); let wrote = false;
    const writer = f.secondKv.set(KV.actions, 'act_other', { id: 'act_other' }).then(() => { wrote = true; });
    await new Promise(resolve => setTimeout(resolve, 45)); expect(wrote).toBe(false);
    expect(await f.release(held)).toMatchObject({ status: 'draining' });
    f.native.guards[0].done.resolve(); await writer;
  });

  it('binds replay, rejects bad capabilities, and makes release idempotent', async () => {
    const f = fixture(), a = await f.acquire();
    expect(await f.acquire()).toEqual(a);
    expect(await f.acquire({ ...request(), projectIds: [] })).toMatchObject({ error: 'closeout_guard_request_conflict' });
    expect(await f.acquire(request('another'))).toMatchObject({ error: 'closeout_guard_busy' });
    expect(await f.release({ ...a, capability: 'a'.repeat(64) })).toMatchObject({ success: false });
    const released = await f.release(a); expect(await f.release(a)).toEqual(released);
    expect(await f.acquire()).toMatchObject({ error: 'closeout_guard_request_used' });
  });

  it('refuses audit failure before exposing a native witness', async () => {
    const f = fixture();
    f.hooks.before = async c => { if (c.op === 'set' && c.scope.startsWith('mem:audit')) throw new Error('audit offline'); };
    expect(await f.acquire()).toMatchObject({ success: false, error: 'closeout_guard_audit_failed' });
    expect(f.native.guards[0].live).toEqual([]);
  });

  it.each(['selected', 'zero-selected-defer-all/v1', 'empty-project-first-admission/v1'])('captures authority mode %s through existing validation', async mode => {
    const f = fixture();
    const row: any = { protocol: 'work-authority/v1', projectId: 'repo', phase: 'beads', generation: 1,
      prefix: 'rp', planDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), sourceRevision: 0,
      selectedIds: mode === 'selected' ? ['act_one'] : [], deferredIds: mode === 'zero-selected-defer-all/v1' ? ['act_old'] : [],
      heldClaimIds: [], frozenAt: new Date().toISOString(), actor: 'private actor', committedAt: new Date().toISOString(),
      receiptDigest: 'c'.repeat(64), mapping: mode === 'selected' ? [{ sourceActionId: 'act_one', beadId: 'rp-one' }] : [] };
    if (mode !== 'selected') row.selectionMode = mode;
    if (mode === 'zero-selected-defer-all/v1') row.deferredTrackingId = 'rp-old';
    await f.kv.set(KV.workAuthority, 'repo', row);
    const result = await f.acquire(); expect(result.success).toBe(true);
    expect(result.snapshot.workAuthority[0]).toMatchObject({ projectId: 'repo', phase: 'beads', generation: 1,
      authority: { selectedIds: row.selectedIds, mapping: row.mapping } });
    expect(JSON.stringify(result.snapshot)).not.toContain('private actor'); await f.release(result);
  });
});

describe('mandatory private API authentication', () => {
  it.each(['acquire', 'release'])('requires a configured secret for %s and whitelists fields', async operation => {
    const f = fixture(), handler = vi.fn(async () => ({ success: true }));
    f.sdk.registerFunction(`mem::closeout-guard-${operation}`, handler);
    registerApiTriggers(f.sdk as never, f.kv);
    const endpoint = `api::closeout-guard-${operation}`;
    expect(await f.sdk.trigger(endpoint, { headers: {}, body: request() })).toMatchObject({ status_code: 503 });
    registerApiTriggers(f.sdk as never, f.kv, 'test-secret');
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { 'X-WSH-Agent-Id': 'claude-cloud-orchestrator' }]) {
      expect(await f.sdk.trigger(endpoint, { headers, body: request() })).toMatchObject({ status_code: 401 });
    }
    expect(handler).not.toHaveBeenCalled();
    const body = operation === 'acquire' ? request() : { protocol: CLOSEOUT_GUARD_PROTOCOL, guardId: 'x', capability: 'a'.repeat(64) };
    expect(await f.sdk.trigger(endpoint, { headers: { authorization: 'Bearer test-secret' }, body: { ...body, command: 'forbidden', project: 'ignored' } })).toMatchObject({ status_code: 200 });
    expect(handler).toHaveBeenCalledWith(body);
  });
});
