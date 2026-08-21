import { performance } from "node:perf_hooks";
import type {
  LocalVectorEntry,
  PersistableLocalVectorStore,
  VectorDimensionValidation,
  VectorMetadata,
  VectorSearchOptions,
  VectorSearchResult,
} from "./vector-store.js";

export interface ShadowRemoteVectorStore {
  search(
    query: Float32Array,
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;
  upsertBatch(entries: readonly LocalVectorEntry[]): Promise<void>;
  deleteBatch(observationIds: readonly string[]): Promise<void>;
  resetCollection(): Promise<void>;
}

export type VectorShadowState =
  | "awaiting_reconcile"
  | "reconciling"
  | "healthy"
  | "degraded"
  | "stopped";

export interface VectorShadowDiagnostics {
  enabled: true;
  authority: "local";
  backend: "qdrant";
  state: VectorShadowState;
  needsReconcile: boolean;
  pendingMutations: number;
  localSize: number;
  reconciliations: number;
  reconciliationFailures: number;
  mirroredUpserts: number;
  mirroredDeletes: number;
  mutationFailures: number;
  metadataFailures: number;
  sampledSearches: number;
  sampledSearchSuccesses: number;
  sampledSearchFailures: number;
  meanOverlapAtK: number | null;
  meanRemoteLatencyMs: number | null;
  lastReconciledAt: string | null;
  lastRemoteSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
}

export interface ShadowVectorStoreOptions {
  sampleRate?: number;
  pendingLimit?: number;
  reconcileBatchSize?: number;
  retryMs?: number;
  random?: () => number;
  metadataResolver?: (
    entry: LocalVectorEntry,
  ) => Promise<VectorMetadata | undefined>;
}

type Mutation =
  | { kind: "upsert"; entry: LocalVectorEntry }
  | { kind: "delete"; obsId: string }
  | { kind: "clear" };

const DEFAULT_SAMPLE_RATE = 0.05;
const DEFAULT_PENDING_LIMIT = 10_000;
const DEFAULT_RECONCILE_BATCH_SIZE = 256;
const DEFAULT_RETRY_MS = 30_000;
const MAX_FAILURE_CHARS = 300;

function boundedFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, MAX_FAILURE_CHARS);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.floor(value!)
    : fallback;
}

function validSampleRate(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_SAMPLE_RATE;
}

function cloneEntry(entry: LocalVectorEntry): LocalVectorEntry {
  return {
    obsId: entry.obsId,
    sessionId: entry.sessionId,
    embedding: new Float32Array(entry.embedding),
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
  };
}

export class ShadowVectorStore implements PersistableLocalVectorStore {
  readonly persistenceFormat = "agentmemory-local-vector-v1" as const;

  private readonly sampleRate: number;
  private readonly pendingLimit: number;
  private readonly reconcileBatchSize: number;
  private readonly retryMs: number;
  private readonly random: () => number;
  private readonly metadataResolver?: ShadowVectorStoreOptions["metadataResolver"];
  private state: VectorShadowState = "awaiting_reconcile";
  private needsReconcile = true;
  private pending: Mutation[] = [];
  private drainPromise: Promise<void> | null = null;
  private reconcilePromise: Promise<boolean> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private reconciliations = 0;
  private reconciliationFailures = 0;
  private mirroredUpserts = 0;
  private mirroredDeletes = 0;
  private mutationFailures = 0;
  private metadataFailures = 0;
  private sampledSearches = 0;
  private sampledSearchSuccesses = 0;
  private sampledSearchFailures = 0;
  private overlapSum = 0;
  private remoteLatencySumMs = 0;
  private lastReconciledAt: string | null = null;
  private lastRemoteSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;

  constructor(
    private readonly local: PersistableLocalVectorStore,
    private readonly remote: ShadowRemoteVectorStore,
    options: ShadowVectorStoreOptions = {},
  ) {
    this.sampleRate = validSampleRate(options.sampleRate);
    this.pendingLimit = positiveInteger(options.pendingLimit, DEFAULT_PENDING_LIMIT);
    this.reconcileBatchSize = positiveInteger(
      options.reconcileBatchSize,
      DEFAULT_RECONCILE_BATCH_SIZE,
    );
    this.retryMs = options.retryMs === 0
      ? 0
      : positiveInteger(options.retryMs, DEFAULT_RETRY_MS);
    this.random = options.random ?? Math.random;
    this.metadataResolver = options.metadataResolver;
  }

  add(
    observationId: string,
    sessionId: string,
    embedding: Float32Array,
    metadata?: VectorMetadata,
  ): void {
    this.local.add(observationId, sessionId, embedding, metadata);
    this.enqueue({
      kind: "upsert",
      entry: cloneEntry({
        obsId: observationId,
        sessionId,
        embedding,
        ...(metadata === undefined ? {} : { metadata }),
      }),
    });
  }

  remove(observationId: string): void {
    this.local.remove(observationId);
    this.enqueue({ kind: "delete", obsId: observationId });
  }

  search(
    query: Float32Array,
    options: VectorSearchOptions | number = {},
  ): VectorSearchResult[] {
    const normalized = typeof options === "number" ? { limit: options } : options;
    const localResults = this.local.search(query, normalized) as VectorSearchResult[];
    if (
      !this.stopped &&
      (this.state === "healthy" ||
        (this.state === "degraded" && !this.needsReconcile)) &&
      this.random() < this.sampleRate
    ) {
      const queryCopy = new Float32Array(query);
      const localCopy = localResults.map((result) => ({ ...result }));
      void this.compareSearch(queryCopy, normalized, localCopy).catch(() => {});
    }
    return localResults;
  }

  get size(): number {
    return this.local.size;
  }

  clear(): void {
    this.local.clear();
    this.enqueue({ kind: "clear" });
  }

  serialize(): string {
    return this.local.serialize();
  }

  restoreFrom(other: PersistableLocalVectorStore): void {
    this.local.restoreFrom(other);
  }

  validateDimensions(expected: number): VectorDimensionValidation {
    return this.local.validateDimensions(expected);
  }

  entries(): IterableIterator<LocalVectorEntry> {
    return this.local.entries();
  }

  private enqueue(mutation: Mutation): void {
    if (this.stopped) return;
    if (this.pending.length >= this.pendingLimit) {
      this.pending = [];
      this.needsReconcile = true;
      this.state = "degraded";
      this.recordFailure("shadow mutation queue limit exceeded; reconciliation required");
      this.scheduleRetry();
      return;
    }
    this.pending.push(mutation);
    if (
      !this.needsReconcile &&
      this.state !== "awaiting_reconcile" &&
      this.state !== "reconciling"
    ) {
      this.scheduleDrain();
    }
  }

  private scheduleDrain(): void {
    if (this.drainPromise || this.stopped || this.needsReconcile) return;
    this.drainPromise = this.drainLoop()
      .catch((error) => {
        this.mutationFailures++;
        this.needsReconcile = true;
        this.state = "degraded";
        this.recordFailure(error);
        this.scheduleRetry();
      })
      .finally(() => {
        this.drainPromise = null;
        if (this.pending.length > 0 && !this.needsReconcile && !this.stopped) {
          this.scheduleDrain();
        }
      });
  }

  private async drainLoop(): Promise<void> {
    while (this.pending.length > 0 && !this.needsReconcile && !this.stopped) {
      await this.applyPendingBatch();
    }
  }

  private async resolveMetadata(entry: LocalVectorEntry): Promise<LocalVectorEntry> {
    if (!this.metadataResolver) return entry;
    try {
      const metadata = await this.metadataResolver(entry);
      return {
        ...entry,
        ...(metadata === undefined ? {} : { metadata }),
      };
    } catch {
      this.metadataFailures++;
      return { ...entry, metadata: { isLatest: true, attributed: false } };
    }
  }

  private async applyMutations(batch: readonly Mutation[]): Promise<void> {
    const lastClear = batch.reduce(
      (latest, mutation, index) => (mutation.kind === "clear" ? index : latest),
      -1,
    );
    const effective = batch.slice(lastClear + 1);
    if (lastClear >= 0) await this.remote.resetCollection();

    const latestById = new Map<string, Mutation>();
    for (const mutation of effective) {
      if (mutation.kind === "upsert") latestById.set(mutation.entry.obsId, mutation);
      if (mutation.kind === "delete") latestById.set(mutation.obsId, mutation);
    }
    const rawUpserts: LocalVectorEntry[] = [];
    const deletes: string[] = [];
    for (const [obsId, mutation] of [...latestById].sort(([a], [b]) => a.localeCompare(b))) {
      if (mutation.kind === "upsert") {
        rawUpserts.push(mutation.entry);
      } else if (mutation.kind === "delete") {
        deletes.push(obsId);
      }
    }
    const upserts = await Promise.all(
      rawUpserts.map((entry) => this.resolveMetadata(entry)),
    );
    if (upserts.length > 0) {
      await this.remote.upsertBatch(upserts);
      this.mirroredUpserts += upserts.length;
    }
    if (deletes.length > 0) {
      await this.remote.deleteBatch(deletes);
      this.mirroredDeletes += deletes.length;
    }
    this.lastRemoteSuccessAt = new Date().toISOString();
  }

  private async applyPendingBatch(): Promise<void> {
    const batch = this.pending.slice(0, this.reconcileBatchSize);
    if (batch.length === 0) return;
    await this.applyMutations(batch);
    this.pending.splice(0, batch.length);
  }

  async compareSearch(
    query: Float32Array,
    options: VectorSearchOptions = {},
    localResults?: VectorSearchResult[],
  ): Promise<{ local: VectorSearchResult[]; remote: VectorSearchResult[]; overlapAtK: number }> {
    const local = localResults ?? (this.local.search(query, options) as VectorSearchResult[]);
    this.sampledSearches++;
    const started = performance.now();
    try {
      const remote = await this.remote.search(query, options);
      const latency = performance.now() - started;
      const limit = Math.max(1, Math.floor(options.limit ?? 20));
      const expected = new Set(local.slice(0, limit).map((result) => result.obsId));
      const overlap = remote
        .slice(0, limit)
        .filter((result) => expected.has(result.obsId)).length;
      const denominator = Math.max(1, Math.min(limit, local.length));
      const overlapAtK = overlap / denominator;
      this.sampledSearchSuccesses++;
      this.overlapSum += overlapAtK;
      this.remoteLatencySumMs += latency;
      this.lastRemoteSuccessAt = new Date().toISOString();
      if (!this.needsReconcile) this.state = "healthy";
      return { local, remote, overlapAtK };
    } catch (error) {
      this.sampledSearchFailures++;
      if (!this.needsReconcile) this.state = "degraded";
      this.recordFailure(error);
      throw error;
    }
  }

  async reconcile(): Promise<boolean> {
    if (this.reconcilePromise) return this.reconcilePromise;
    if (this.stopped) return false;
    this.reconcilePromise = this.performReconcile().finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  private async performReconcile(): Promise<boolean> {
    this.clearRetry();
    this.state = "reconciling";
    // Stop the drain loop and let any in-flight batch finish before replacing
    // the queue. Otherwise that batch can splice mutations appended after the
    // reconciliation boundary and silently drop their mirror updates.
    this.needsReconcile = true;
    if (this.drainPromise) {
      await this.drainPromise.catch(() => {});
    }
    this.needsReconcile = false;
    // Every queued mutation before this synchronous boundary is represented in
    // the local iterator below. Later mutations remain queued for replay.
    this.pending = [];
    try {
      await this.remote.resetCollection();
      let batch: LocalVectorEntry[] = [];
      for (const entry of this.local.entries()) {
        batch.push(entry);
        if (batch.length >= this.reconcileBatchSize) {
          const resolved = await Promise.all(
            batch.map((candidate) => this.resolveMetadata(candidate)),
          );
          await this.remote.upsertBatch(resolved);
          this.mirroredUpserts += resolved.length;
          batch = [];
        }
      }
      if (batch.length > 0) {
        const resolved = await Promise.all(
          batch.map((candidate) => this.resolveMetadata(candidate)),
        );
        await this.remote.upsertBatch(resolved);
        this.mirroredUpserts += resolved.length;
      }
      while (this.pending.length > 0) await this.applyPendingBatch();
      this.reconciliations++;
      this.lastReconciledAt = new Date().toISOString();
      this.lastRemoteSuccessAt = this.lastReconciledAt;
      this.lastFailure = null;
      this.needsReconcile = false;
      this.state = "healthy";
      return true;
    } catch (error) {
      this.reconciliationFailures++;
      this.needsReconcile = true;
      this.state = "degraded";
      this.recordFailure(error);
      this.scheduleRetry();
      return false;
    }
  }

  private recordFailure(error: unknown): void {
    this.lastFailureAt = new Date().toISOString();
    this.lastFailure = boundedFailure(error);
  }

  private scheduleRetry(): void {
    if (this.retryMs <= 0 || this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile();
    }, this.retryMs);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async flush(timeoutMs = 2_000): Promise<boolean> {
    if (this.needsReconcile || this.state === "awaiting_reconcile") return false;
    this.scheduleDrain();
    const active = this.drainPromise;
    if (!active) return this.pending.length === 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    });
    const completed = active.then(() => true, () => false);
    const result = await Promise.race([completed, timedOut]);
    if (timer) clearTimeout(timer);
    return result && this.pending.length === 0;
  }

  async shutdown(timeoutMs = 2_000): Promise<void> {
    await this.flush(timeoutMs);
    this.stopped = true;
    this.clearRetry();
    this.state = "stopped";
  }

  diagnostics(): VectorShadowDiagnostics {
    return {
      enabled: true,
      authority: "local",
      backend: "qdrant",
      state: this.state,
      needsReconcile: this.needsReconcile,
      pendingMutations: this.pending.length,
      localSize: this.local.size,
      reconciliations: this.reconciliations,
      reconciliationFailures: this.reconciliationFailures,
      mirroredUpserts: this.mirroredUpserts,
      mirroredDeletes: this.mirroredDeletes,
      mutationFailures: this.mutationFailures,
      metadataFailures: this.metadataFailures,
      sampledSearches: this.sampledSearches,
      sampledSearchSuccesses: this.sampledSearchSuccesses,
      sampledSearchFailures: this.sampledSearchFailures,
      meanOverlapAtK: this.sampledSearchSuccesses > 0
        ? this.overlapSum / this.sampledSearchSuccesses
        : null,
      meanRemoteLatencyMs: this.sampledSearchSuccesses > 0
        ? this.remoteLatencySumMs / this.sampledSearchSuccesses
        : null,
      lastReconciledAt: this.lastReconciledAt,
      lastRemoteSuccessAt: this.lastRemoteSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailure: this.lastFailure,
    };
  }
}
