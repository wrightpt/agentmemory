import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { KV } from '../src/state/schema.js';
import fixture from './fixtures/work-authority-defer-all.json';

const script = fileURLToPath(new URL('../scripts/work-authority-fixture.ts', import.meta.url));
const mode = 'zero-selected-defer-all/v1';
const children = new Set<ChildProcess>();
const roots: string[] = [];

async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
  }
  children.delete(child);
}

afterEach(async () => {
  await Promise.all([...children].map(stop));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function start(root: string) {
  await fs.rm(path.join(root, 'endpoint.json'), { force: true });
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, root], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited ${child.exitCode}: ${stderr}`);
    try {
      const { url } = JSON.parse(await fs.readFile(path.join(root, 'endpoint.json'), 'utf8'));
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const request = async (route: string, body?: unknown) => {
        const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST',
          ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
          signal: AbortSignal.timeout(5000) });
        return response.json();
      };
      return { child, request };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error(`fixture startup timed out: ${stderr}`);
}

async function fixtureRoot(scenario?: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'work-authority-test-')));
  roots.push(root);
  await fs.writeFile(path.join(root, 'authority-fixture.json'), JSON.stringify({ purpose: 'isolated-work-authority-test', root, scenario }));
  return root;
}

describe('isolated work-authority transport fixture', () => {
  it.each([false, true])('preserves restart/replay and source custody with zero mode=%s', async zero => {
    const root = await fixtureRoot(zero ? mode : undefined);
    let engine = await start(root);
    const projectId = zero ? fixture.projectId : 'agent-workspace-config';
    const prefix = zero ? fixture.prefix : 'awc';
    const route = `/agentmemory/work-authority?projectId=${projectId}&includeSnapshot=true`;
    const source = await engine.request(route);
    expect(source).toMatchObject({ success: true, phase: 'agentmemory', generation: 0, snapshot: { activeLeases: [] } });
    expect(source.snapshot.records).toHaveLength(zero ? 15 : 3);
    const sourceStore = JSON.parse(await fs.readFile(path.join(root, 'engine-fixture.json'), 'utf8'));
    const selectedIds = zero ? [] : [source.snapshot.records[0].id];
    const payload = { protocol: 'work-authority/v1', operation: 'freeze', projectId, prefix, generation: 0,
      planDigest: createHash('sha256').update(JSON.stringify({ selectionMode: zero ? mode : undefined, source })).digest('hex'),
      sourceDigest: source.snapshot.sourceDigest, selectedIds,
      deferredIds: source.snapshot.records.map((row: any) => row.id).filter((id: string) => !selectedIds.includes(id)).sort(),
      heldClaimIds: source.snapshot.records.filter((row: any) => row.status === 'active' || row.assignedTo).map((row: any) => row.id).sort(),
      ...(zero ? { selectionMode: mode, sourceRevision: source.snapshot.sourceRevision } : {}),
    };
    if (zero) {
      expect(await engine.request('/agentmemory/work-authority', { ...payload, selectionMode: undefined }))
        .toMatchObject({ success: false, error: 'invalid_freeze_scope' });
    }
    const frozen = await engine.request('/agentmemory/work-authority', payload);
    expect(frozen).toMatchObject({ success: true, replayed: false, authority: { phase: 'frozen', generation: 1 } });
    await stop(engine.child);
    engine = await start(root);
    expect((await engine.request(route)).authority).toEqual(frozen.authority);
    expect(await engine.request('/agentmemory/work-authority', payload)).toEqual({ ...frozen, replayed: true });
    expect(await engine.request('/fixture/old-client', {})).toMatchObject({ success: false, error: 'work_authority_read_only' });
    const commit = { protocol: payload.protocol, operation: 'commit', projectId, generation: 1, planDigest: payload.planDigest,
      receiptDigest: 'b'.repeat(64), mapping: selectedIds.map(sourceActionId => ({ sourceActionId, beadId: `${prefix}-task` })),
      deferredTrackingId: `${prefix}-triage`, ...(zero ? { selectionMode: mode } : {}) };
    expect(await engine.request('/agentmemory/work-authority', { ...commit, deferredTrackingId: undefined }))
      .toMatchObject({ success: false, error: 'invalid_import_receipt' });
    const committed = await engine.request('/agentmemory/work-authority', commit);
    expect(committed).toMatchObject({ success: true, replayed: false, authority: { ...frozen.authority, phase: 'beads' } });
    await stop(engine.child);
    engine = await start(root);
    expect(await engine.request('/agentmemory/work-authority', commit)).toEqual({ ...committed, replayed: true });
    const observed = await engine.request(route);
    expect(observed.snapshot).toEqual(source.snapshot);
    expect(observed.authority.mapping).toHaveLength(zero ? 0 : 1);
    expect(await engine.request('/fixture/old-client', {})).toMatchObject({ success: false, error: 'work_authority_read_only' });
    await stop(engine.child);
    const finalStore = JSON.parse(await fs.readFile(path.join(root, 'engine-fixture.json'), 'utf8'));
    for (const scope of [KV.actions, KV.actionEdges, KV.leases, KV.actionState, KV.actionEvents]) {
      expect(finalStore[scope]).toEqual(sourceStore[scope]);
    }
    if (zero) expect(Object.values(finalStore[KV.actions])).toEqual(fixture.records);
  }, 20000);

  it('refuses a corrupted persisted empty receipt after process restart', async () => {
    const root = await fixtureRoot(mode);
    let engine = await start(root);
    const route = '/agentmemory/work-authority?projectId=workstation-shell&includeSnapshot=true';
    const source = await engine.request(route);
    const freeze = { protocol: 'work-authority/v1', operation: 'freeze', projectId: 'workstation-shell', prefix: 'wsh',
      generation: 0, planDigest: 'a'.repeat(64), sourceDigest: source.snapshot.sourceDigest,
      sourceRevision: source.snapshot.sourceRevision, selectedIds: [], selectionMode: mode,
      deferredIds: source.snapshot.records.map((row: any) => row.id).sort(), heldClaimIds: ['act_fixture_09', 'act_fixture_10'] };
    expect(await engine.request('/agentmemory/work-authority', freeze)).toMatchObject({ success: true });
    const commit = { protocol: freeze.protocol, operation: 'commit', projectId: freeze.projectId, generation: 1,
      planDigest: freeze.planDigest, selectionMode: mode, receiptDigest: 'b'.repeat(64), mapping: [], deferredTrackingId: 'wsh-triage' };
    expect(await engine.request('/agentmemory/work-authority', commit)).toMatchObject({ success: true });
    await stop(engine.child);
    const stateFile = path.join(root, 'engine-fixture.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state[KV.workAuthority][freeze.projectId].mapping = [{ sourceActionId: 'act_fixture_01', beadId: 'wsh-accidental' }];
    await fs.writeFile(stateFile, JSON.stringify(state));
    engine = await start(root);
    expect(await engine.request('/agentmemory/work-authority', commit)).toMatchObject({ success: false, error: 'work_authority_invalid' });
    expect(await engine.request('/fixture/old-client', {})).toMatchObject({ success: false });
    await stop(engine.child);
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toEqual(state);
  }, 20000);
});
