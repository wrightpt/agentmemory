import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ISdk } from 'iii-sdk';
import type { StateKV } from '../state/kv.js';
import { fingerprintId, KV } from '../state/schema.js';
import type { Lesson } from '../types.js';
import { recordAudit } from '../functions/audit.js';
import { correctLesson } from '../functions/lessons.js';
import { withLessonMutationLock } from '../functions/lesson-locks.js';
import { canReadLesson, canWriteLessonScope, lessonAccessContextFromPayload, type LessonAccessContext } from '../functions/lesson-access.js';
import { canonicalJson, parseFindingPolicy, parseFindingProposal, prepareFinding, prepareFindingReview, sha256 } from './evidence.js';
import type { FindingEvidenceRecord, FindingPolicy, FindingProposal, FindingSnapshot, FindingSnapshotEntry, FindingSource, FindingView, PreparedFinding } from './types.js';

const MAX_SCOPE_FINDINGS = 512;
const MAX_SNAPSHOT_ENTRIES = 32;
const POLICY_LIMIT = 256 * 1024;

type Request = Record<string, unknown>;
type Authority = { access: LessonAccessContext; policy: FindingPolicy; view: FindingView };

function failure(code: string) { return { success: false as const, code }; }
function fail(code: string): never { throw new Error(code); }
function record(value: unknown): Request {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request');
  return value as Request;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_request');
  return value.trim();
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) fail('invalid_request');
  return value as number;
}
export function parseFindingView(value: unknown): FindingView {
  const input = record(value);
  const project = text(input.project, 128);
  const taskId = text(input.taskId, 128);
  const role = text(input.role);
  const phase = text(input.phase);
  if (!['worker', 'reviewer', 'generator', 'refiner', 'report'].includes(role) ||
      !['coding', 'pre-outcome', 'post-freeze'].includes(phase) ||
      (['generator', 'refiner'].includes(role) && phase !== 'pre-outcome')) fail('invalid_view');
  return { project, taskId, role, phase } as FindingView;
}
export function loadFindingPolicy(): FindingPolicy {
  const path = process.env.AGENTMEMORY_FINDINGS_POLICY_FILE;
  try {
    if (!path || !isAbsolute(path) || statSync(path).size > POLICY_LIMIT) fail('finding_policy_unavailable');
    return parseFindingPolicy(JSON.parse(readFileSync(path, 'utf8')));
  } catch { return fail('finding_policy_unavailable'); }
}
function authority(data: Request, policy: FindingPolicy, publish = false): Authority {
  const access = lessonAccessContextFromPayload(data.accessContext);
  if (access.mode !== 'enforce' || access.resolvedBy !== 'server-policy' || !access.authorizationProof) fail('access_denied');
  const view = parseFindingView(data.view);
  if (!policy.grants.some(grant => grant.principalId === access.principalId &&
    grant.project === view.project && grant.taskId === view.taskId && grant.role === view.role && grant.phase === view.phase &&
    (!publish || grant.publish))) fail('access_denied');
  return { access, policy, view };
}
function sourceLesson(source: Pick<FindingSource, 'scope' | 'sensitivity' | 'project'>): Lesson {
  return { id: 'scope-check', content: 'scope-check', context: '', confidence: 0, reinforcements: 0,
    source: 'manual', sourceIds: [], tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    decayRate: 0, project: source.project, scope: source.scope, sensitivity: source.sensitivity };
}
function canUseSource(source: FindingSource, auth: Authority, publish: boolean): boolean {
  return source.project === auth.view.project && source.taskId === auth.view.taskId &&
    (source.visibility !== 'post-freeze' || (auth.view.phase === 'post-freeze' && ['worker', 'reviewer', 'report'].includes(auth.view.role))) &&
    canReadLesson(sourceLesson(source), auth.access) && (!publish || canWriteLessonScope(source.scope, source.sensitivity, auth.access));
}
function authorizeProposal(proposal: FindingProposal, auth: Authority, publish: boolean): void {
  if (proposal.project !== auth.view.project || proposal.taskId !== auth.view.taskId ||
      (proposal.kind === 'evaluation' && auth.view.phase !== 'post-freeze')) fail('access_denied');
  for (const slice of proposal.sources) {
    const source = auth.policy.sources.find(item => item.id === slice.sourceId);
    if (!source) fail('unknown_source');
    if (!canUseSource(source, auth, publish)) fail('access_denied');
  }
}
function canUseLesson(lesson: Lesson, auth: Authority, publish = false): boolean {
  if (!lesson.sharedFinding || lesson.project !== auth.view.project ||
      lesson.sharedFinding.proposal?.taskId !== auth.view.taskId) return false;
  try {
    authorizeProposal(lesson.sharedFinding.proposal, auth, publish);
    return canReadLesson(sourceLesson({ project: lesson.project, scope: lesson.scope!, sensitivity: lesson.sensitivity! }), auth.access) &&
      (!publish || canWriteLessonScope(lesson.scope!, lesson.sensitivity!, auth.access));
  } catch { return false; }
}
function findingId(prepared: PreparedFinding): string {
  const { review: _review, ...proposal } = prepared.proposal;
  return fingerprintId('lsn_fnd', canonicalJson({ proposal, evidenceHash: prepared.verification.evidenceHash,
    scope: prepared.scope, sensitivity: prepared.sensitivity, visibility: prepared.visibility }));
}
function createLesson(prepared: PreparedFinding): Lesson {
  const { proposal, verification } = prepared;
  const id = findingId(prepared);
  return {
    id, identityKind: 'canonical', schemaVersion: 1, idAliases: [], content: proposal.claim, claim: proposal.claim,
    mechanismId: `shared-finding/${proposal.kind}`, claimType: 'descriptive', context: '', confidence: 0.5, reinforcements: 0, source: 'manual', sourceIds: [],
    project: proposal.project, tags: ['shared-finding', `kind:${proposal.kind}`], createdAt: verification.verifiedAt,
    updatedAt: verification.verifiedAt, decayRate: 0, lifecycle: 'active', evidenceVerdict: 'supported',
    applicabilityConditions: proposal.applicability, nonApplicabilityConditions: [], falsificationConditions: [],
    structuredFacets: {}, contradictedByLessonIds: [], scope: prepared.scope, sensitivity: prepared.sensitivity,
    evidenceRefs: prepared.evidence.map(item => ({ kind: 'shared-finding', projectId: proposal.project,
      provenance: { type: 'attestation', locator: item.source.uri, immutableId: item.source.revision, digest: `sha256:${item.source.sha256}` },
      recordedAt: verification.verifiedAt, verification: { state: 'verified', basis: 'explicit-review', verifiedBy: verification.verifierId, verifiedAt: verification.verifiedAt } })),
    sharedFinding: { version: 1, proposal, verification, evidenceId: fingerprintId('lev', verification.evidenceHash), visibility: prepared.visibility },
  };
}
function isActive(lesson: Lesson): boolean {
  return !lesson.deleted && lesson.lifecycle === 'active' && lesson.evidenceVerdict === 'supported';
}
async function verifiedLesson(kv: StateKV, lesson: Lesson, auth: Authority, all: Lesson[]): Promise<PreparedFinding> {
  if (!canUseLesson(lesson, auth)) fail('access_denied');
  if (!isActive(lesson)) fail('finding_inactive');
  if (lesson.reviewAfter && (!Number.isFinite(Date.parse(lesson.reviewAfter)) || Date.parse(lesson.reviewAfter) <= Date.now())) fail('finding_stale');
  if ((lesson.contradictedByLessonIds?.length ?? 0) > 0 || all.some(other =>
    !other.deleted && other.lifecycle !== 'retracted' && other.lifecycle !== 'superseded' && other.contradictedByLessonIds?.includes(lesson.id))) fail('conflicting_evidence');
  const shared = lesson.sharedFinding!;
  const prepared = await prepareFinding(shared.proposal, shared.verification.authorId, auth.policy);
  if (shared.version !== 1 || findingId(prepared) !== lesson.id ||
      prepared.verification.bindingHash !== shared.verification.bindingHash ||
      prepared.verification.claimHash !== shared.verification.claimHash ||
      prepared.verification.evidenceHash !== shared.verification.evidenceHash ||
      prepared.verification.method !== shared.verification.method ||
      prepared.verification.verifierId !== shared.verification.verifierId ||
      shared.visibility !== prepared.visibility || lesson.claim !== prepared.proposal.claim || lesson.content !== prepared.proposal.claim ||
      canonicalJson(lesson.scope) !== canonicalJson(prepared.scope) || lesson.sensitivity !== prepared.sensitivity ||
      canonicalJson(lesson.applicabilityConditions) !== canonicalJson(prepared.proposal.applicability) ||
      lesson.sourceIds.length !== 0 ||
      shared.evidenceId !== fingerprintId('lev', prepared.verification.evidenceHash)) fail('finding_binding_mismatch');
  const stored = await kv.get<FindingEvidenceRecord>(KV.lessonEvidence, shared.evidenceId);
  if (!stored || stored.id !== shared.evidenceId || stored.evidenceHash !== prepared.verification.evidenceHash ||
      canonicalJson(stored.evidence) !== canonicalJson(prepared.evidence)) fail('evidence_unavailable');
  return prepared;
}
function snapshotEntry(lesson: Lesson): FindingSnapshotEntry {
  const { proposal, verification } = lesson.sharedFinding!;
  return { lessonId: lesson.id, bindingHash: verification.bindingHash, evidenceHash: verification.evidenceHash,
    claim: proposal.claim, kind: proposal.kind, applicability: proposal.applicability };
}
function snapshotFor(auth: Authority, entries: FindingSnapshotEntry[]): FindingSnapshot {
  const material = { version: 1 as const, principalId: auth.access.principalId, view: auth.view,
    policyHash: sha256(canonicalJson(auth.policy)), entries };
  const hash = sha256(canonicalJson(material));
  return { ...material, id: fingerprintId('fsnap', hash), hash };
}
function accounting(value: unknown) {
  const serialized = JSON.stringify(value);
  return { utf8Bytes: Buffer.byteLength(serialized, 'utf8'), estimatedTokens: Math.ceil(serialized.length / 4), tokenMethod: 'ceil(JSON characters / 4); estimate, not tokenizer usage' };
}
async function loadSnapshot(kv: StateKV, id: string, auth: Authority): Promise<FindingSnapshot> {
  const snapshot = await kv.get<FindingSnapshot>(KV.lessonSnapshots, id);
  if (!snapshot) fail('snapshot_unavailable');
  if (snapshot.principalId !== auth.access.principalId || canonicalJson(snapshot.view) !== canonicalJson(auth.view)) fail('access_denied');
  if (snapshot.policyHash !== sha256(canonicalJson(auth.policy))) fail('snapshot_policy_changed');
  const expected = snapshotFor(auth, snapshot.entries);
  if (canonicalJson(snapshot) !== canonicalJson(expected) || expected.id !== id) fail('snapshot_binding_mismatch');
  return snapshot;
}
function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{1,70}$/.test(message) ? message : 'finding_operation_failed';
}
export function registerFindingsFunctions(sdk: ISdk, kv: StateKV, options: { policy?: () => FindingPolicy } = {}): void {
  const policy = options.policy ?? loadFindingPolicy;
  function register(name: string, handler: (data: Request, auth: Authority) => Promise<unknown>, publish = false) {
    sdk.registerFunction(`mem::finding-${name}`, async (raw: unknown) => {
      try {
        const data = record(raw);
        const auth = authority(data, policy(), publish);
        const result = await handler(data, auth);
        if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true) return result;
        const { accounting: _oldAccounting, ...payload } = result as Record<string, unknown>;
        const response = { findingSurface: 'verified-shared-findings-v1', ...payload };
        return { ...response, accounting: accounting(response) };
      } catch (error) { return failure(safeCode(error)); }
    });
  }
  register('prepare', async (data, auth) => {
    const proposal = parseFindingProposal(data.proposal);
    authorizeProposal(proposal, auth, true);
    const review = await prepareFindingReview(proposal, auth.access.principalId, auth.policy);
    return { success: true, admitted: false, untrustedData: true, review, accounting: accounting(review) };
  }, true);
  register('publish', async (data, auth) => {
    const proposal = parseFindingProposal(data.proposal);
    authorizeProposal(proposal, auth, true);
    return withLessonMutationLock(async () => {
      const prepared = await prepareFinding(proposal, auth.access.principalId, auth.policy);
      const lesson = createLesson(prepared);
      const existing = await kv.get<Lesson>(KV.lessons, lesson.id);
      if (existing) {
        await verifiedLesson(kv, existing, auth, await kv.list<Lesson>(KV.lessons));
        if (!existing.sharedFinding) fail('finding_binding_mismatch');
        return { success: true, action: 'already_admitted', lessonId: existing.id, verification: existing.sharedFinding.verification, updatedAt: existing.updatedAt };
      }
      const evidence: FindingEvidenceRecord = { id: lesson.sharedFinding!.evidenceId, evidenceHash: prepared.verification.evidenceHash, evidence: prepared.evidence };
      const oldEvidence = await kv.get<FindingEvidenceRecord>(KV.lessonEvidence, evidence.id);
      if (oldEvidence && canonicalJson(oldEvidence) !== canonicalJson(evidence)) fail('evidence_conflict');
      if (!oldEvidence) await kv.set(KV.lessonEvidence, evidence.id, evidence);
      if (canonicalJson(await kv.get(KV.lessonEvidence, evidence.id)) !== canonicalJson(evidence)) fail('evidence_unavailable');
      await recordAudit(kv, 'lesson_save', 'mem::finding-publish', [lesson.id], { actor: auth.access.principalId, bindingHash: prepared.verification.bindingHash, stage: 'admission_intent' });
      await kv.set(KV.lessons, lesson.id, lesson);
      const published = await kv.get<Lesson>(KV.lessons, lesson.id);
      if (!published || canonicalJson(published) !== canonicalJson(lesson)) fail('publication_unconfirmed');
      return { success: true, action: 'admitted', lessonId: lesson.id, verification: prepared.verification, updatedAt: lesson.updatedAt };
    });
  }, true);
  register('snapshot', async (data, auth) => withLessonMutationLock(async () => {
    const maxBytes = integer(data.maxBytes, 32768, 4096, 65536);
    const limit = integer(data.limit, 16, 1, MAX_SNAPSHOT_ENTRIES);
    const all = await kv.list<Lesson>(KV.lessons);
    const existing = data.snapshotId === undefined ? undefined : await loadSnapshot(kv, text(data.snapshotId), auth);
    const candidates = existing
      ? existing.entries.map(entry => all.find(lesson => lesson.id === entry.lessonId) ?? fail('snapshot_finding_unavailable'))
      : all.filter(lesson => canUseLesson(lesson, auth)).sort((a, b) => a.id.localeCompare(b.id));
    if (candidates.length > MAX_SCOPE_FINDINGS) fail('scope_too_large');
    const entries: FindingSnapshotEntry[] = [];
    const unavailable: Array<{ lessonId: string; code: string }> = [];
    let truncated = !existing && candidates.length > limit;
    for (const lesson of existing ? candidates : candidates.slice(0, limit)) {
      try {
        await verifiedLesson(kv, lesson, auth, all);
        const entry = snapshotEntry(lesson);
        if (existing && canonicalJson(existing.entries.find(item => item.lessonId === lesson.id)) !== canonicalJson(entry)) fail('snapshot_finding_changed');
        entries.push(entry);
      } catch (error) {
        if (existing) throw error;
        unavailable.push({ lessonId: lesson.id, code: safeCode(error) });
      }
    }
    let snapshot = existing ?? snapshotFor(auth, entries);
    const response = () => ({ success: true, snapshot, unavailable, truncated, untrustedData: true });
    while (Buffer.byteLength(JSON.stringify(response())) + 256 > maxBytes) {
      if (existing) fail('snapshot_budget_exceeded');
      if (entries.length > 0) entries.pop();
      else if (unavailable.length > 0) unavailable.pop();
      else fail('snapshot_budget_exceeded');
      truncated = true;
      snapshot = snapshotFor(auth, entries);
    }
    if (!existing) {
      const stored = await kv.get<FindingSnapshot>(KV.lessonSnapshots, snapshot.id);
      if (stored && canonicalJson(stored) !== canonicalJson(snapshot)) fail('snapshot_binding_mismatch');
      if (!stored) await kv.set(KV.lessonSnapshots, snapshot.id, snapshot);
      if (canonicalJson(await kv.get(KV.lessonSnapshots, snapshot.id)) !== canonicalJson(snapshot)) fail('snapshot_unavailable');
    }
    return { ...response(), accounting: accounting(response()) };
  }));
  register('expand', async (data, auth) => withLessonMutationLock(async () => {
    const snapshot = await loadSnapshot(kv, text(data.snapshotId), auth);
    const lessonId = text(data.lessonId);
    const entry = snapshot.entries.find(item => item.lessonId === lessonId);
    if (!entry) fail('snapshot_finding_unavailable');
    const lesson = await kv.get<Lesson>(KV.lessons, lessonId);
    if (!lesson) fail('snapshot_finding_unavailable');
    const prepared = await verifiedLesson(kv, lesson, auth, await kv.list<Lesson>(KV.lessons));
    if (canonicalJson(snapshotEntry(lesson)) !== canonicalJson(entry)) fail('snapshot_finding_changed');
    if (data.level === 'evidence') {
      const evidence = prepared.evidence.map(({ source, slice }) => ({ source, slice }));
      const result = { success: true, untrustedData: true, lessonId, snapshotId: snapshot.id, evidence,
        verification: lesson.sharedFinding!.verification, lifecycle: lesson.lifecycle, updatedAt: lesson.updatedAt };
      return { ...result, accounting: accounting(result) };
    }
    if (data.level !== 'raw') fail('invalid_request');
    const index = integer(data.sourceIndex, 0, 0, prepared.evidence.length - 1);
    const evidence = prepared.evidence[index];
    const offset = integer(data.offset, 0, 0, evidence.raw.length);
    const maxChars = integer(data.maxChars, 4096, 1, 8192);
    const end = Math.min(offset + maxChars, evidence.raw.length);
    const result = { success: true, untrustedData: true, lessonId, snapshotId: snapshot.id, source: evidence.source,
      offset, nextOffset: end < evidence.raw.length ? end : null, totalChars: evidence.raw.length, raw: evidence.raw.slice(offset, end) };
    return { ...result, accounting: accounting(result) };
  }));
  register('correct', async (data, auth) => {
    const lessonId = text(data.lessonId);
    const reason = text(data.reason, 1000);
    const replacementLessonId = data.replacementLessonId === undefined ? undefined : text(data.replacementLessonId);
    if (!lessonId.startsWith('lsn_fnd_') || (replacementLessonId && !replacementLessonId.startsWith('lsn_fnd_'))) fail('access_denied');
    const result = await correctLesson(kv, { lessonId, reason, replacementLessonId, project: auth.view.project,
      expectedUpdatedAt: data.expectedUpdatedAt === undefined ? undefined : text(data.expectedUpdatedAt), accessContext: auth.access },
      replacementLessonId ? 'supersede' : 'delete', async lesson => {
        if (!canUseLesson(lesson, auth, true)) return false;
        if (lesson.id === replacementLessonId) {
          await verifiedLesson(kv, lesson, auth, await kv.list<Lesson>(KV.lessons));
        }
        return true;
      });
    if (!result.success || !('lesson' in result)) return result;
    return { success: true, action: result.action, lessonId, lifecycle: result.lesson.lifecycle, updatedAt: result.lesson.updatedAt, replacementLessonId };
  }, true);
}
