import { randomBytes } from 'node:crypto';
import type { ISdk } from 'iii-sdk';
import type { StateKV } from '../state/kv.js';
import { generateId } from '../state/schema.js';
import { timingSafeCompare } from '../auth.js';
import { CloseoutGuardNative, processIncarnation, type NativeGuard, type NativeGuardFactory } from '../state/closeout-guard-native.js';
import { recoverActionStoreUnlocked, withActionStoreLock } from './action-store.js';
import { recordAudit } from './audit.js';
import { fingerprint } from './stale-cleanup-policy.js';
import { captureGuardSnapshot, closeoutAliases, CLOSEOUT_GUARD_PROTOCOL, CloseoutGuardError, parseGuardRequest,
  type CloseoutGuardRequest } from './closeout-guard-policy.js';

type Result = Record<string, unknown> & { success: boolean };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
interface Guard {
  id: string; key: string; request: CloseoutGuardRequest; capability: string; expiresAt: string;
  state: 'queued' | 'active' | 'draining' | 'released'; cancelled: boolean; audited: boolean;
  ready: ReturnType<typeof deferred<Result>>; done: ReturnType<typeof deferred<void>>;
  native?: NativeGuard; evidenceDigest?: string; failure?: string; timer?: ReturnType<typeof setTimeout>;
  revokeAudit?: Promise<void>;
}
export interface CloseoutGuardOptions {
  native: NativeGuardFactory;
  acquisitionMs?: number;
  lifetimeMs?: number;
  releaseWaitMs?: number;
}
const refusal = (error: string): Result => ({ success: false, protocol: CLOSEOUT_GUARD_PROTOCOL, error });
function errorCode(error: unknown): string {
  return error instanceof CloseoutGuardError ? error.code : 'closeout_guard_evidence_unavailable';
}
function provenDrain(native: NativeGuard): Promise<void> {
  return native.drained.catch(() => new Promise<void>(() => {}));
}

export class CloseoutGuardController {
  private active?: Guard;
  private history = new Map<string, Guard>();
  private acquisitionMs: number;
  private lifetimeMs: number;
  private releaseWaitMs: number;
  constructor(private kv: StateKV, private options: CloseoutGuardOptions) {
    this.acquisitionMs = options.acquisitionMs ?? 5000;
    this.lifetimeMs = options.lifetimeMs ?? 30_000;
    this.releaseWaitMs = options.releaseWaitMs ?? 1000;
  }
  initialize() { return this.options.native.initialize(); }

  async acquire(input: unknown): Promise<Result> {
    let request: CloseoutGuardRequest;
    try { request = parseGuardRequest(input); } catch (error) { return refusal(errorCode(error)); }
    const key = fingerprint(request), previous = this.history.get(request.requestId);
    if (previous) {
      if (previous.key !== key) return refusal('closeout_guard_request_conflict');
      if (previous.state === 'released' || previous.cancelled) return refusal('closeout_guard_request_used');
      return previous.ready.promise;
    }
    if (this.active) return refusal('closeout_guard_busy');
    const cell: Guard = { id: generateId('cgd'), key, request, capability: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + this.lifetimeMs).toISOString(), state: 'queued', cancelled: false,
      audited: false, ready: deferred<Result>(), done: deferred<void>() };
    this.active = cell;
    this.history.set(request.requestId, cell);
    while (this.history.size > 128) this.history.delete(this.history.keys().next().value!);
    cell.timer = setTimeout(() => {
      cell.cancelled = true;
      cell.failure = 'closeout_guard_acquire_expired';
      cell.ready.resolve(refusal(cell.failure));
      cell.native?.revoke();
    }, this.acquisitionMs);
    // This promise outlives its HTTP/iii acquire invocation and owns both locks.
    void this.run(cell);
    return cell.ready.promise;
  }

  private async run(cell: Guard) {
    try {
      await withActionStoreLock(async () => {
        if (cell.cancelled) return;
        const state = await recoverActionStoreUnlocked(this.kv);
        if (cell.cancelled) return;
        const revision = this.kv.maintenanceBarrier.snapshot();
        const committed = await this.kv.maintenanceBarrier.tryCommit(revision, async invalidate => {
          try {
            cell.native = await this.options.native.begin(cell.expiresAt);
            const snapshot = await captureGuardSnapshot(this.kv, cell.request, state.revision, Date.now());
            if (cell.cancelled || Date.now() >= Date.parse(cell.expiresAt)) throw new CloseoutGuardError('closeout_guard_acquire_expired');
            cell.evidenceDigest = fingerprint(snapshot);
            try { await this.audit(cell, 'acquired'); }
            catch { throw new CloseoutGuardError('closeout_guard_audit_failed'); }
            cell.audited = true;
            if (cell.cancelled || Date.now() >= Date.parse(cell.expiresAt)) throw new CloseoutGuardError('closeout_guard_acquire_expired');
            const { file, pid, fd, dev, ino, startTicks } = cell.native.lock;
            cell.native.activate({ protocol: CLOSEOUT_GUARD_PROTOCOL, guardId: cell.id, requestId: cell.request.requestId,
              session: cell.request.session, evidenceDigest: cell.evidenceDigest, expiresAt: cell.expiresAt,
              engine: processIncarnation(), lock: { file, pid, fd, dev, ino, startTicks } });
            clearTimeout(cell.timer);
            cell.timer = setTimeout(() => this.revoke(cell), Math.max(0, Date.parse(cell.expiresAt) - Date.now()));
            cell.state = 'active';
            cell.ready.resolve({ success: true, protocol: CLOSEOUT_GUARD_PROTOCOL, guardId: cell.id,
              requestId: cell.request.requestId, session: cell.request.session, capability: cell.capability,
              expiresAt: cell.expiresAt, snapshot, evidenceDigest: cell.evidenceDigest,
              lock: cell.native.lock, liveFile: cell.native.liveFile });
            await provenDrain(cell.native);
          } catch (error) {
            cell.failure = errorCode(error);
            cell.ready.resolve(refusal(cell.failure));
          }
          cell.state = 'draining';
          clearTimeout(cell.timer);
          if (cell.native) {
            this.revoke(cell);
            // A failed/uncertain drain never rejects this promise. tryCommit's
            // finally must not run while an inherited native FD can act.
            await provenDrain(cell.native);
          }
          await cell.revokeAudit;
          for (const alias of closeoutAliases(cell.request.session)) invalidate(alias);
          try { await this.audit(cell, cell.failure ? 'refused' : 'drained'); }
          catch { cell.failure = 'closeout_guard_audit_failed'; }
        });
        if (!committed.committed) cell.failure = 'closeout_guard_concurrent_write';
      });
    } catch (error) { cell.failure = errorCode(error); }
    finally {
      clearTimeout(cell.timer);
      cell.state = 'released';
      if (this.active === cell) this.active = undefined;
      cell.ready.resolve(refusal(cell.failure || 'closeout_guard_acquire_expired'));
      cell.done.resolve();
    }
  }

  private audit(cell: Guard, phase: string) {
    return recordAudit(this.kv, 'closeout_guard', 'mem::closeout-guard', [cell.request.session], {
      phase, guardId: cell.id, requestId: cell.request.requestId, session: cell.request.session,
      projectIds: cell.request.projectIds, evidenceDigest: cell.evidenceDigest ?? null, reason: cell.failure ?? null,
    });
  }

  private revoke(cell: Guard) {
    if (cell.state === 'released') return;
    cell.cancelled = true;
    cell.state = 'draining';
    try { cell.native?.revoke(); } catch { cell.failure = 'closeout_guard_drain_uncertain'; }
    cell.revokeAudit ??= this.audit(cell, 'revoked').then(() => {}, () => { cell.failure = 'closeout_guard_audit_failed'; });
  }

  async release(input: unknown): Promise<Result> {
    const row = input as Record<string, unknown> | null;
    if (!row || row.protocol !== CLOSEOUT_GUARD_PROTOCOL || typeof row.guardId !== 'string'
        || typeof row.capability !== 'string' || !/^[a-f0-9]{64}$/.test(row.capability)) return refusal('closeout_guard_invalid_release');
    const cell = [...this.history.values()].find(g => g.id === row.guardId);
    if (!cell || !timingSafeCompare(cell.capability, row.capability)) return refusal('closeout_guard_invalid_release');
    this.revoke(cell);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([cell.done.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, this.releaseWaitMs); })]);
    clearTimeout(timer);
    if (cell.state !== 'released') return { ...refusal('closeout_guard_draining'), guardId: cell.id, status: 'draining', released: false };
    return { success: !cell.failure, protocol: CLOSEOUT_GUARD_PROTOCOL, guardId: cell.id,
      status: 'released', released: true, ...(cell.failure ? { error: cell.failure } : {}) };
  }
}

export function registerCloseoutGuardFunctions(sdk: ISdk, controller: CloseoutGuardController) {
  sdk.registerFunction('mem::closeout-guard-acquire', input => controller.acquire(input));
  sdk.registerFunction('mem::closeout-guard-release', input => controller.release(input));
}
export function createCloseoutGuardController(kv: StateKV, dataDir: string) {
  return new CloseoutGuardController(kv, { native: new CloseoutGuardNative(dataDir) });
}
