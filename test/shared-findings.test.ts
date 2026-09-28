import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { registerFindingsFunctions } from '../src/findings/service.js';
import { registerFindingApi } from '../src/triggers/findings.js';
import { registerLessonsFunctions } from '../src/functions/lessons.js';
import { canonicalJson, deterministicClaim, DETERMINISTIC_APPLICABILITY, sha256 } from '../src/findings/evidence.js';
import { resolveLessonBoundaryAccess, type LessonCallerPolicy } from '../src/functions/lesson-access.js';
import { KV } from '../src/state/schema.js';
import type { FindingPolicy, FindingProposal, FindingView } from '../src/findings/types.js';
import { mockKV, mockSdk } from './helpers/mocks.js';

vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const view: FindingView = { project: 'fixture', taskId: 'task-1', role: 'worker', phase: 'coding' };
const scope = { ring: 'repo' as const, scopeId: 'repo:fixture' };
const tokens = { alice: 'fixture-alice-only', bob: 'fixture-bob-only', outsider: 'fixture-outsider-only', generator: 'fixture-generator-only', report: 'fixture-report-only' };
function policyPrincipal(principalId: string, token: string) {
  return { principalId, principalKind: 'agent' as const, tokenSha256: sha256(token), clearance: 'internal' as const,
    scopes: [{ ...scope, access: principalId === 'bob' ? 'read' as const : 'write' as const }] };
}
const callerPolicy: LessonCallerPolicy = { version: 1, principals: Object.entries(tokens).map(([id, token]) => policyPrincipal(id, token)) };
function context(id: keyof typeof tokens) {
  const result = resolveLessonBoundaryAccess({ 'x-agentmemory-caller-token': tokens[id] }, { mode: 'enforce', policy: callerPolicy });
  if (!result.success) throw new Error('fixture_context_failed');
  return result.context;
}

describe('shared findings admission, snapshots and corrections', () => {
  let dir: string;
  let policy: FindingPolicy;
  let proposal: FindingProposal;
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let rawStore: ReturnType<typeof mockKV>;
  let artifact: string;

  beforeEach(async () => {
    vi.stubEnv('AGENTMEMORY_LESSON_ACCESS_MODE', 'classify');
    dir = await mkdtemp(join(tmpdir(), 'agentmemory-findings-'));
    artifact = join(dir, 'qualification.json');
    const raw = '{"valid":true,"errors":0}\n';
    await writeFile(artifact, raw);
    policy = { version: 1, reviewers: [],
      grants: [
        { ...view, principalId: 'alice', publish: true },
        { ...view, principalId: 'bob', publish: false },
        { ...view, principalId: 'generator', role: 'generator', phase: 'pre-outcome', publish: false },
        { ...view, principalId: 'report', role: 'report', phase: 'post-freeze', publish: true },
      ],
      sources: [{ id: 'receipt', project: 'fixture', taskId: 'task-1', scope, sensitivity: 'internal', visibility: 'pre-outcome',
        uri: 'urn:research-ontology:fixture:qualification', revision: 'fixture-v1', sha256: sha256(raw), location: { type: 'artifact', path: artifact } }],
    };
    proposal = { project: 'fixture', taskId: 'task-1', kind: 'data-quality', claim: '', applicability: [DETERMINISTIC_APPLICABILITY],
      sources: [{ sourceId: 'receipt', sha256: sha256(raw), startLine: 1, endLine: 1, quote: raw.trimEnd() }],
      check: { type: 'json-pointer-equals', sourceId: 'receipt', pointer: '/errors', expected: 0 } };
    proposal.claim = deterministicClaim(proposal);
    rawStore = mockKV();
    kv = { ...rawStore,
      get: async (scope, key) => structuredClone(await rawStore.get(scope, key)),
      list: async scope => structuredClone(await rawStore.list(scope)),
      set: async (scope, key, value) => rawStore.set(scope, key, structuredClone(value)),
    } as ReturnType<typeof mockKV>;
    sdk = mockSdk();
    registerLessonsFunctions(sdk as never, kv as never);
    registerFindingsFunctions(sdk as never, kv as never, { policy: () => policy });
    registerFindingApi(sdk as never, () => null, { callerPolicy });
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
  async function call(operation: string, body: Record<string, unknown> = {}, id: keyof typeof tokens = 'alice', selectedView = view): Promise<any> {
    return sdk.trigger(`mem::finding-${operation}`, { ...body, view: selectedView, accessContext: context(id) });
  }
  async function publish() { const result = await call('publish', { proposal }); expect(result.success).toBe(true); return result; }
  async function snapshot(id: keyof typeof tokens = 'alice', selectedView = view) {
    const result = await call('snapshot', {}, id, selectedView); expect(result.success).toBe(true); return result;
  }

  it('requires authenticated proof and exact task grants even in legacy classify mode', async () => {
    const inputs = [undefined, { ...context('alice'), principalId: 'outsider' }, { ...context('alice'), mode: 'classify' }];
    for (const accessContext of inputs) {
      expect(await sdk.trigger('mem::finding-publish', { view, proposal, accessContext })).toMatchObject({ success: false, code: 'access_denied' });
    }
    expect(await call('publish', { proposal }, 'outsider')).toMatchObject({ success: false, code: 'access_denied' });
    expect(await call('publish', { proposal }, 'alice', { ...view, taskId: 'other' })).toMatchObject({ success: false, code: 'access_denied' });
    expect(await kv.list(KV.lessons)).toEqual([]);
  });

  it('rejects fabricated flags and unsupported narrative before any visible write', async () => {
    const forged = { ...proposal, verified: true, verifierId: 'independent' };
    expect(await call('publish', { proposal: forged })).toMatchObject({ success: false });
    expect(await call('publish', { proposal: { ...proposal, claim: 'The code is correct.' } })).toMatchObject({ success: false });
    expect(await call('publish', { proposal: { ...proposal, check: { type: 'narrative' } } })).toMatchObject({ success: false });
    expect(await kv.list(KV.lessons)).toEqual([]);
    expect(await kv.list(KV.lessonEvidence)).toEqual([]);
  });

  it('writes immutable evidence before visibility and deduplicates concurrent publication', async () => {
    const writes: string[] = [];
    const original = kv.set;
    kv.set = async (scope, key, value) => { writes.push(scope); return original(scope, key, value); };
    const results = await Promise.all(Array.from({ length: 8 }, () => call('publish', { proposal })));
    expect(results.filter(item => item.action === 'admitted')).toHaveLength(1);
    expect(results.filter(item => item.action === 'already_admitted')).toHaveLength(7);
    expect(new Set(results.map(item => item.lessonId)).size).toBe(1);
    expect(writes.indexOf(KV.lessonEvidence)).toBeLessThan(writes.indexOf(KV.lessons));
    expect(await kv.list(KV.lessons)).toHaveLength(1);
  });

  it('deduplicates the same supported material across independent authors', async () => {
    const first = await publish();
    policy.grants.push({ ...view, principalId: 'report', publish: true });
    const second = await call('publish', { proposal }, 'report');
    expect(second).toMatchObject({ success: true, action: 'already_admitted', lessonId: first.lessonId });
    expect(second.verification.authorId).toBe('alice');
    expect(await kv.list(KV.lessons)).toHaveLength(1);
  });

  it('keeps partial publications invisible and resumes using their immutable evidence', async () => {
    const original = kv.set;
    kv.set = async (scope, key, value) => { if (scope === KV.lessons) throw new Error('simulated interruption'); return original(scope, key, value); };
    expect(await call('publish', { proposal })).toMatchObject({ success: false });
    expect(await kv.list(KV.lessons)).toHaveLength(0);
    expect(await kv.list(KV.lessonEvidence)).toHaveLength(1);
    expect((await snapshot()).snapshot.entries).toEqual([]);
    kv.set = original;
    await publish();
    expect((await snapshot()).snapshot.entries).toHaveLength(1);
  });

  it('recovers an acknowledged-lost publication without strengthening or duplicating it', async () => {
    const original = kv.set;
    kv.set = async (scope, key, value) => { const result = await original(scope, key, value); if (scope === KV.lessons) throw new Error('lost reply'); return result; };
    expect(await call('publish', { proposal })).toMatchObject({ success: false });
    kv.set = original;
    expect(await call('publish', { proposal })).toMatchObject({ success: true, action: 'already_admitted' });
    expect(await kv.list(KV.lessons)).toHaveLength(1);
  });

  it('allows two scoped worker views to reuse a finding with stable compact snapshots', async () => {
    const admitted = await publish();
    const alice = await snapshot();
    const bob = await snapshot('bob');
    expect(alice.snapshot.entries).toEqual(bob.snapshot.entries);
    expect(alice.snapshot.id).not.toBe(bob.snapshot.id);
    expect((await snapshot()).snapshot).toEqual(alice.snapshot);
    expect(bob.snapshot.entries[0].lessonId).toBe(admitted.lessonId);
    expect(JSON.stringify(bob.snapshot)).not.toContain('"raw"');
    const expanded = await call('expand', { snapshotId: bob.snapshot.id, lessonId: admitted.lessonId, level: 'raw', maxChars: 5 }, 'bob');
    expect(expanded).toMatchObject({ success: true, untrustedData: true, raw: '{"val', nextOffset: 5 });
    expect(await call('expand', { snapshotId: alice.snapshot.id, lessonId: admitted.lessonId, level: 'raw' }, 'bob')).toMatchObject({ success: false, code: 'access_denied' });
    expect(await call('expand', { snapshotId: bob.snapshot.id, lessonId: 'unknown', level: 'raw' }, 'bob')).toMatchObject({ success: false });
    expect(await call('publish', { proposal }, 'bob')).toMatchObject({ success: false, code: 'access_denied' });
  });

  it('applies phase and sensitivity checks to snapshots and unfolding', async () => {
    policy.sources[0].visibility = 'post-freeze';
    proposal.kind = 'evaluation';
    const reportView: FindingView = { ...view, role: 'report', phase: 'post-freeze' };
    const admitted = await call('publish', { proposal }, 'report', reportView);
    expect(admitted.success).toBe(true);
    const reportSnapshot = await snapshot('report', reportView);
    const generatorView: FindingView = { ...view, role: 'generator', phase: 'pre-outcome' };
    expect((await snapshot('generator', generatorView)).snapshot.entries).toEqual([]);
    expect(await call('expand', { snapshotId: reportSnapshot.snapshot.id, lessonId: admitted.lessonId, level: 'evidence' }, 'generator', generatorView)).toMatchObject({ success: false });
    expect(await call('snapshot', {}, 'generator', { ...generatorView, phase: 'post-freeze' })).toMatchObject({ success: false });
    expect((await snapshot()).snapshot.entries).toEqual([]);
    policy.sources[0].sensitivity = 'restricted';
    expect(await call('publish', { proposal }, 'report', reportView)).toMatchObject({ success: false, code: 'access_denied' });
  });

  it('fails closed for missing, tampered and stale backing evidence', async () => {
    const admitted = await publish();
    const frozen = await snapshot();
    const lesson = await kv.get<any>(KV.lessons, admitted.lessonId);
    const evidence = await kv.get<any>(KV.lessonEvidence, lesson.sharedFinding.evidenceId);
    await kv.delete(KV.lessonEvidence, evidence.id);
    expect(await call('expand', { snapshotId: frozen.snapshot.id, lessonId: admitted.lessonId, level: 'raw' })).toMatchObject({ success: false, code: 'evidence_unavailable' });
    expect((await snapshot()).unavailable).toEqual([{ lessonId: admitted.lessonId, code: 'evidence_unavailable' }]);
    await kv.set(KV.lessonEvidence, evidence.id, evidence);
    await writeFile(artifact, '{"valid":false,"errors":99}\n');
    const failed = await call('expand', { snapshotId: frozen.snapshot.id, lessonId: admitted.lessonId, level: 'raw' });
    expect(failed).toMatchObject({ success: false, code: 'finding_source_hash_mismatch' });
    expect(JSON.stringify(failed)).not.toContain('99');
  });

  it('invalidates old snapshots on policy change and never replaces their frozen content', async () => {
    await publish();
    const frozen = await snapshot();
    policy.grants.push({ ...view, taskId: 'new-task', principalId: 'alice', publish: true });
    expect(await call('snapshot', { snapshotId: frozen.snapshot.id })).toMatchObject({ success: false, code: 'snapshot_policy_changed' });
    expect(await kv.get(KV.lessonSnapshots, frozen.snapshot.id)).toEqual(frozen.snapshot);
  });

  it('retracts via existing lesson lifecycle and blocks old snapshots plus republish', async () => {
    const admitted = await publish();
    const frozen = await snapshot();
    expect(await sdk.trigger('mem::lesson-delete', { lessonId: admitted.lessonId, reason: 'ordinary call' })).toMatchObject({ success: false });
    expect(await call('correct', { lessonId: admitted.lessonId, reason: 'corrected', expectedUpdatedAt: admitted.updatedAt })).toMatchObject({ success: true, lifecycle: 'retracted' });
    expect(await call('correct', { lessonId: admitted.lessonId, reason: 'corrected' })).toMatchObject({ success: true, action: 'already_deleted' });
    expect(await call('expand', { snapshotId: frozen.snapshot.id, lessonId: admitted.lessonId, level: 'raw' })).toMatchObject({ success: false, code: 'finding_inactive' });
    expect(await call('publish', { proposal })).toMatchObject({ success: false, code: 'finding_inactive' });
    expect((await snapshot()).snapshot.entries).toEqual([]);
  });

  it('supersedes with a newly admitted lesson and protects correction revisions', async () => {
    const old = await publish();
    proposal.check = { type: 'json-pointer-equals', sourceId: 'receipt', pointer: '/valid', expected: true };
    proposal.claim = deterministicClaim(proposal);
    const replacement = await publish();
    expect(await call('correct', { lessonId: old.lessonId, reason: 'new finding', expectedUpdatedAt: 'old', replacementLessonId: replacement.lessonId })).toMatchObject({ success: false, code: 'revision_conflict' });
    expect(await call('correct', { lessonId: old.lessonId, reason: 'new finding', expectedUpdatedAt: old.updatedAt, replacementLessonId: replacement.lessonId })).toMatchObject({ success: true, lifecycle: 'superseded' });
    expect((await snapshot()).snapshot.entries.map((entry: any) => entry.lessonId)).toEqual([replacement.lessonId]);
  });

  it('rejects conflicting evidence and tampered snapshot entries', async () => {
    const admitted = await publish();
    const frozen = await snapshot();
    const lesson = await kv.get<any>(KV.lessons, admitted.lessonId);
    lesson.contradictedByLessonIds = ['other'];
    await kv.set(KV.lessons, lesson.id, lesson);
    expect((await snapshot()).unavailable).toContainEqual({ lessonId: lesson.id, code: 'conflicting_evidence' });
    expect(await call('expand', { snapshotId: frozen.snapshot.id, lessonId: lesson.id, level: 'raw' })).toMatchObject({ success: false, code: 'conflicting_evidence' });
    const tampered = { ...frozen.snapshot, entries: [] };
    await kv.set(KV.lessonSnapshots, tampered.id, tampered);
    expect(await call('snapshot', { snapshotId: tampered.id })).toMatchObject({ success: false, code: 'snapshot_binding_mismatch' });
  });

  it('prepares unadmitted evidence and admits independently signed narrative support', async () => {
    proposal.check = { type: 'narrative' };
    proposal.claim = 'The fixed qualification receipt reports zero errors.';
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    policy.reviewers = [{ principalId: 'reviewer', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
    const prepared = await call('prepare', { proposal });
    expect(prepared).toMatchObject({ success: true, admitted: false });
    expect(await kv.list(KV.lessons)).toEqual([]);
    const unsigned = { reviewerId: 'reviewer', claimHash: prepared.review.claimHash, bindingHash: prepared.review.bindingHash,
      evidenceHash: prepared.review.evidenceHash, reviewedAt: new Date().toISOString(), verdict: 'supported' as const,
      rationale: 'The exact JSON supporting slice contains errors:0; claim is limited to that receipt.' };
    proposal.review = { ...unsigned, signature: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64') };
    expect(await call('publish', { proposal })).toMatchObject({ success: true, verification: { method: 'independent-review-ed25519-v1', authorId: 'alice', verifierId: 'reviewer' } });
    proposal.claim = 'The code is always correct.';
    expect(await call('publish', { proposal })).toMatchObject({ success: false });
  });

  it('uses authenticated REST whitelisting and bounded compact output', async () => {
    const denied = await sdk.trigger('api::finding-publish', { headers: { 'x-agentmemory-agent-id': 'alice' }, body: { view, proposal } });
    expect(denied).toMatchObject({ status_code: 401 });
    const result: any = await sdk.trigger('api::finding-publish', { headers: { 'x-agentmemory-caller-token': tokens.alice }, body: { view, proposal, accessContext: context('outsider'), verified: true } });
    expect(result).toMatchObject({ status_code: 200, body: { success: true, verification: { authorId: 'alice' } } });
    const compact = await call('snapshot', { limit: 1, maxBytes: 4096 });
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(4096);
    const { accounting, ...body } = compact;
    expect(accounting.utf8Bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(await call('snapshot', { limit: 33 })).toMatchObject({ success: false, code: 'invalid_request' });
    expect(await call('correct', { lessonId: 'lsn_ordinary', reason: 'wrong surface' })).toMatchObject({ success: false, code: 'access_denied' });
  });
});
