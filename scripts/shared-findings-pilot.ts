import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ISdk } from 'iii-sdk';
import { FindingClient, FindingClientError, type FindingResponse } from '../src/findings/client.js';
import {
  DETERMINISTIC_APPLICABILITY,
  deterministicClaim,
  reviewSigningPayload,
  sha256,
  type PreparedFindingReview,
} from '../src/findings/evidence.js';
import { registerFindingsFunctions } from '../src/findings/service.js';
import type {
  FindingPolicy,
  FindingProposal,
  FindingReview,
  FindingSnapshot,
  FindingSource,
  FindingView,
} from '../src/findings/types.js';
import type { LessonCallerPolicy } from '../src/functions/lesson-access.js';
import { StateKV } from '../src/state/kv.js';
import { registerFindingApi } from '../src/triggers/findings.js';

type Handler = (payload: unknown) => Promise<unknown>;
type HttpResult = { status_code: number; body: unknown };
type WireRecord = {
  principal: string;
  operation: string;
  status: number;
  requestUtf8Bytes: number;
  responseUtf8Bytes: number;
  estimatedRequestTokens: number;
  estimatedResponseTokens: number;
};

function isolatedEngineFixture() {
  const collections = new Map<string, Map<string, unknown>>();
  const functions = new Map<string, Handler>();
  const routes = new Map<string, string>();
  const operations: Record<string, number> = {};
  const sdk = {
    registerFunction(id: string | { id: string }, handler: Handler) {
      functions.set(typeof id === 'string' ? id : id.id, handler);
    },
    registerTrigger(trigger: { type: string; function_id: string; config: { api_path: string; http_method: string } }) {
      assert.equal(trigger.type, 'http');
      routes.set(`${trigger.config.http_method} ${trigger.config.api_path}`, trigger.function_id);
    },
    async trigger(input: { function_id: string; payload: unknown }): Promise<unknown> {
      const { function_id: operation, payload } = input;
      if (!operation.startsWith('state::')) {
        const handler = functions.get(operation);
        assert.ok(handler, 'fixture_function_not_registered');
        return handler(payload);
      }
      operations[operation] = (operations[operation] ?? 0) + 1;
      const data = payload as { scope: string; key: string; value: unknown };
      const collection = collections.get(data.scope);
      switch (operation) {
        case 'state::get': return structuredClone(collection?.get(data.key));
        case 'state::list': return structuredClone([...collection?.values() ?? []]);
        case 'state::list_groups': return { groups: [...collections.keys()] };
        case 'state::set': {
          const target = collection ?? new Map<string, unknown>();
          collections.set(data.scope, target);
          target.set(data.key, structuredClone(data.value));
          return structuredClone(data.value);
        }
        case 'state::delete': collection?.delete(data.key); return {};
        default: throw new Error('fixture_state_operation_not_supported');
      }
    },
  };
  return { sdk: sdk as unknown as ISdk, trigger: sdk.trigger, routes, operations };
}

export async function runSharedFindingsPilot() {
  const root = await mkdtemp(join(tmpdir(), 'agentmemory-findings-pilot-'));
  const previousMode = process.env.AGENTMEMORY_LESSON_ACCESS_MODE;
  const previousLedgerMode = process.env.AGENTMEMORY_LEDGER_WRITE_MODE;
  process.env.AGENTMEMORY_LESSON_ACCESS_MODE = 'enforce';
  process.env.AGENTMEMORY_LEDGER_WRITE_MODE = 'partitioned';
  const fixture = isolatedEngineFixture();
  const server = createServer(async (req, res) => {
    try {
      const functionId = fixture.routes.get(`${req.method} ${req.url}`);
      if (!functionId) { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        assert.ok(bytes <= 256 * 1024, 'fixture_request_too_large');
        chunks.push(buffer);
      }
      const result = await fixture.trigger({ function_id: functionId,
        payload: { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) },
      }) as HttpResult;
      res.writeHead(result.status_code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"success":false,"code":"fixture_request_failed"}');
    }
  });
  try {
    const project = 'shared-findings-pilot';
    const taskId = 'fixed-coding-data-qualification';
    const view: FindingView = { project, taskId, role: 'worker', phase: 'coding' };
    const scope = { ring: 'repo' as const, scopeId: 'repo:shared-findings-pilot' };
    const authorKey = generateKeyPairSync('ed25519');
    const reviewerKey = generateKeyPairSync('ed25519');
    const tokens = { 'pilot-worker-a': 'isolated-fixture-token-a', 'pilot-worker-b': 'isolated-fixture-token-b' };
    const callerPolicy: LessonCallerPolicy = {
      version: 1,
      principals: Object.entries(tokens).map(([principalId, token]) => ({
        principalId, principalKind: 'agent', tokenSha256: sha256(token),
        clearance: 'internal', scopes: [{ ...scope, access: 'write' }],
      })),
    };
    const sourceBytes = [
      { id: 'coding-retry', filename: 'retry.ts', raw: 'export const retryBudget = 2;\n' },
      { id: 'quality-receipt', filename: 'quality.json', raw: '{"rows":4,"missingReceiveTimestamps":0,"duplicateRows":0}\n' },
    ];
    await Promise.all(sourceBytes.map(source => writeFile(join(root, source.filename), source.raw, { mode: 0o600 })));
    const sources: FindingSource[] = sourceBytes.map(source => ({
      id: source.id, project, taskId, scope, sensitivity: 'internal', visibility: 'pre-outcome',
      uri: `urn:agentmemory:shared-findings-pilot:${source.id}:v1`, sha256: sha256(source.raw),
      revision: `sha256:${sha256(source.raw)}`, location: { type: 'artifact', path: join(root, source.filename) },
    }));
    const policy: FindingPolicy = {
      version: 1,
      grants: Object.keys(tokens).map(principalId => ({ principalId, ...view, publish: true })),
      sources,
      reviewers: [
        { principalId: 'pilot-worker-a', publicKey: authorKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        { principalId: 'pilot-reviewer', publicKey: reviewerKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      ],
    };
    registerFindingsFunctions(fixture.sdk, new StateKV(fixture.sdk), { policy: () => policy });
    registerFindingApi(fixture.sdk, req => req.headers?.authorization === 'Bearer isolated-fixture-api-secret'
      ? null : { status_code: 401, body: { success: false, code: 'fixture_unauthorized' } }, { callerPolicy });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string', 'fixture_listener_failed');
    const wire: WireRecord[] = [];
    const clientFor = (principal: keyof typeof tokens) => {
      const measuredFetch: typeof globalThis.fetch = async (input, init) => {
        const request = String(init?.body ?? '');
        const response = await fetch(input, init);
        const text = await response.clone().text();
        wire.push({ principal, operation: String(input).split('/').at(-1)!, status: response.status,
          requestUtf8Bytes: Buffer.byteLength(request), responseUtf8Bytes: Buffer.byteLength(text),
          estimatedRequestTokens: Math.ceil(request.length / 4), estimatedResponseTokens: Math.ceil(text.length / 4),
        });
        return response;
      };
      return new FindingClient({ url: `http://127.0.0.1:${address.port}`, fetch: measuredFetch,
        env: { AGENTMEMORY_CALLER_TOKEN: tokens[principal], AGENTMEMORY_SECRET: 'isolated-fixture-api-secret' },
      });
    };
    const workerA = clientFor('pilot-worker-a');
    const workerB = clientFor('pilot-worker-b');
    const counters = { producerTaskInvestigations: 0, consumerTaskInvestigations: 0,
      consumerFindingReuses: 0, fixtureTaskInvocationsSkipped: 0, duplicatePublicationsDeduplicated: 0 };
    const proposals: FindingProposal[] = [];
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      const raw = await readFile(join(root, sourceBytes[index].filename), 'utf8');
      counters.producerTaskInvestigations++;
      const proposal: FindingProposal = {
        project, taskId, kind: index === 0 ? 'coding' : 'data-quality', claim: '',
        applicability: [DETERMINISTIC_APPLICABILITY],
        sources: [{ sourceId: source.id, sha256: source.sha256, startLine: 1, endLine: 1, quote: raw.trimEnd() }],
        check: index === 0 ? { type: 'exact-quote', sourceId: source.id }
          : { type: 'json-pointer-equals', sourceId: source.id, pointer: '/duplicateRows', expected: 0 },
      };
      proposal.claim = deterministicClaim(proposal);
      proposals.push(proposal);
    }
    const rejected: string[] = [];
    async function reject(name: string, action: () => Promise<FindingResponse>) {
      await assert.rejects(action, error => error instanceof FindingClientError && error.code === 'finding_request_rejected');
      rejected.push(name);
    }
    await reject('fabricated-deterministic-claim', () => workerA.request('publish', {
      view, proposal: { ...proposals[0], claim: 'All retries are safe for production.' },
    }));
    const publications = await Promise.all(proposals.map(proposal => workerA.request('publish', { view, proposal })));
    assert.ok(publications.every(result => result.action === 'admitted'));
    const repeated = await workerA.request('publish', { view, proposal: proposals[0] });
    assert.equal(repeated.action, 'already_admitted');
    assert.equal(repeated.lessonId, publications[0].lessonId);
    counters.duplicatePublicationsDeduplicated++;
    const peerRepeated = await workerB.request('publish', { view, proposal: proposals[0] });
    assert.equal(peerRepeated.action, 'already_admitted');
    assert.equal(peerRepeated.lessonId, publications[0].lessonId);
    counters.duplicatePublicationsDeduplicated++;

    const snapshots = await Promise.all([workerA, workerB].map(worker => worker.request('snapshot', { view, limit: 8, maxBytes: 8192 })));
    const [snapshotA, snapshotB] = snapshots.map(result => result.snapshot as FindingSnapshot);
    assert.deepEqual(snapshotA.entries, snapshotB.entries);
    assert.equal(snapshotA.entries.length, 2);
    assert.notEqual(snapshotA.id, snapshotB.id);
    const reread = await workerA.request('snapshot', { view, snapshotId: snapshotA.id, maxBytes: 8192 });
    assert.deepEqual(reread.snapshot, snapshotA);
    await reject('cross-principal-snapshot', () => workerB.request('snapshot', { view, snapshotId: snapshotA.id }));
    for (const proposal of proposals) {
      const reused = snapshotB.entries.find(entry => entry.claim === proposal.claim);
      assert.ok(reused, 'fixture_reuse_missing');
      const expanded = await workerB.request('expand', { view, snapshotId: snapshotB.id, lessonId: reused.lessonId, level: 'evidence' });
      assert.equal(expanded.untrustedData, true);
      assert.ok(Array.isArray(expanded.evidence));
      counters.consumerFindingReuses++;
      counters.fixtureTaskInvocationsSkipped++;
    }
    const raw = await workerB.request('expand', { view, snapshotId: snapshotB.id,
      lessonId: publications[0].lessonId as string, level: 'raw', maxChars: 8192 });
    assert.equal(raw.raw, sourceBytes[0].raw);

    const narrative: FindingProposal = { ...proposals[1],
      claim: 'The fixture receipt reports four rows and no duplicate rows.',
      applicability: ['Only the supplied synthetic data-quality receipt.'], check: { type: 'narrative' },
    };
    await reject('unsigned-narrative', () => workerA.request('publish', { view, proposal: narrative }));
    const prepared = await workerA.request('prepare', { view, proposal: narrative });
    assert.equal(prepared.admitted, false);
    const hashes = prepared.review as PreparedFindingReview;
    const receipt = JSON.parse(hashes.evidence[0].raw) as Record<string, number>;
    assert.equal(receipt.rows, 4);
    assert.equal(receipt.duplicateRows, 0);
    const review = (reviewerId: string, key: KeyObject): FindingReview => {
      const unsigned: Omit<FindingReview, 'signature'> = {
        reviewerId, claimHash: hashes.claimHash, bindingHash: hashes.bindingHash, evidenceHash: hashes.evidenceHash,
        reviewedAt: '2026-01-01T00:00:00.000Z', verdict: 'supported',
        rationale: 'Fixture reviewer checked receipt.rows equals 4 and receipt.duplicateRows equals 0; no generalization is claimed.',
      };
      return { ...unsigned, signature: sign(null, Buffer.from(reviewSigningPayload(unsigned)), key).toString('base64') };
    };
    await reject('signed-self-review', () => workerA.request('publish', {
      view, proposal: { ...narrative, review: review('pilot-worker-a', authorKey.privateKey) },
    }));
    const reviewed = await workerA.request('publish', {
      view, proposal: { ...narrative, review: review('pilot-reviewer', reviewerKey.privateKey) },
    });
    assert.equal(reviewed.action, 'admitted');
    assert.equal((reviewed.verification as { method: string }).method, 'independent-review-ed25519-v1');
    const afterNarrative = await workerA.request('snapshot', { view });
    assert.equal((afterNarrative.snapshot as FindingSnapshot).entries.length, 3);
    const corrected = await workerA.request('correct', { view, lessonId: publications[0].lessonId as string,
      reason: 'Pilot verifies explicit retraction invalidates frozen views.', expectedUpdatedAt: publications[0].updatedAt as string });
    assert.equal(corrected.lifecycle, 'retracted');
    await reject('retracted-snapshot-read', () => workerB.request('snapshot', { view, snapshotId: snapshotB.id }));
    await reject('retracted-source-expansion', () => workerB.request('expand', {
      view, snapshotId: snapshotB.id, lessonId: publications[0].lessonId as string, level: 'raw',
    }));
    return {
      schemaVersion: 1,
      result: 'PASS',
      fixture: 'isolated HTTP integration; production API/functions/StateKV; mocked iii state::* handlers',
      liveEngineContacted: false, liveModelsCalled: false, researchExperimentsRun: 0,
      fixedTasks: ['coding retry constant', 'data-quality duplicate-row receipt'],
      workerViews: [snapshotA, snapshotB].map(snapshot => ({ principalId: snapshot.principalId,
        snapshotId: snapshot.id, snapshotHash: snapshot.hash, findingIds: snapshot.entries.map(entry => entry.lessonId) })),
      sharedAdmittedFindings: 2, independentSignedNarrativeAdmitted: 1, rejected, counters,
      accounting: {
        byteMethod: 'Exact UTF-8 bytes of serialized HTTP JSON request and response bodies; excludes headers.',
        tokenMethod: 'ceil(JSON UTF-16 code units / 4); estimate only, not tokenizer usage or billing.',
        totalRequestUtf8Bytes: wire.reduce((sum, record) => sum + record.requestUtf8Bytes, 0),
        totalResponseUtf8Bytes: wire.reduce((sum, record) => sum + record.responseUtf8Bytes, 0),
        estimatedRequestTokens: wire.reduce((sum, record) => sum + record.estimatedRequestTokens, 0),
        estimatedResponseTokens: wire.reduce((sum, record) => sum + record.estimatedResponseTokens, 0),
        requests: wire,
      },
      fixtureStateOperations: fixture.operations,
      limitations: [
        'Reuse counters measure programmed fixture task skips, not empirical model quality or savings.',
        'No iii WebSocket transport, file-adapter durability, crash recovery, or production activation was tested.',
        'Independent narrative signing uses a scripted fixture reviewer with ephemeral test keys.',
        'No timing claim is made; token counts are estimates.',
      ],
    };
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    if (previousMode === undefined) delete process.env.AGENTMEMORY_LESSON_ACCESS_MODE;
    else process.env.AGENTMEMORY_LESSON_ACCESS_MODE = previousMode;
    if (previousLedgerMode === undefined) delete process.env.AGENTMEMORY_LEDGER_WRITE_MODE;
    else process.env.AGENTMEMORY_LEDGER_WRITE_MODE = previousLedgerMode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await runSharedFindingsPilot(), null, 2)}\n`); }
  catch {
    process.stdout.write('{"schemaVersion":1,"result":"FAIL","code":"isolated_findings_pilot_failed"}\n');
    process.exitCode = 1;
  }
}
