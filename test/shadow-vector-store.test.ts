import { describe, expect, it } from "vitest";
import { LocalVectorStore, type LocalVectorEntry } from "../src/state/vector-store.js";
import {
  ShadowVectorStore,
  type ShadowRemoteVectorStore,
} from "../src/state/shadow-vector-store.js";

class FakeRemote implements ShadowRemoteVectorStore {
  points = new Map<string, LocalVectorEntry>();
  failReset = false;
  resetGate: Promise<void> | null = null;
  searchGate: Promise<void> | null = null;
  upsertGate: Promise<void> | null = null;
  onUpsert: (() => void) | null = null;
  searches = 0;

  async search() {
    this.searches++;
    if (this.searchGate) await this.searchGate;
    return [...this.points.values()]
      .sort((a, b) => a.obsId.localeCompare(b.obsId))
      .map((entry, index) => ({
        obsId: entry.obsId,
        sessionId: entry.sessionId,
        score: 1 - index * 0.01,
        metadata: entry.metadata,
      }));
  }

  async upsertBatch(entries: readonly LocalVectorEntry[]) {
    this.onUpsert?.();
    if (this.upsertGate) await this.upsertGate;
    for (const entry of entries) {
      this.points.set(entry.obsId, {
        ...entry,
        embedding: new Float32Array(entry.embedding),
      });
    }
  }

  async deleteBatch(observationIds: readonly string[]) {
    for (const id of observationIds) this.points.delete(id);
  }

  async resetCollection() {
    if (this.resetGate) await this.resetGate;
    if (this.failReset) throw new Error("qdrant unavailable");
    this.points.clear();
  }
}

function vector(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe("ShadowVectorStore", () => {
  it("preserves local search and persistence when the remote is unavailable", async () => {
    const local = new LocalVectorStore();
    const remote = new FakeRemote();
    remote.failReset = true;
    const shadow = new ShadowVectorStore(local, remote, { retryMs: 0 });

    shadow.add("obs-local", "session-1", vector(1, 0));
    expect(await shadow.reconcile()).toBe(false);
    expect(shadow.search(vector(1, 0), { limit: 1 })[0].obsId).toBe("obs-local");
    expect(shadow.serialize()).toBe(local.serialize());
    expect(shadow.diagnostics()).toMatchObject({
      authority: "local",
      state: "degraded",
      needsReconcile: true,
      reconciliationFailures: 1,
    });
  });

  it("replaces stale remote state and replays a mutation arriving during reconciliation", async () => {
    const local = new LocalVectorStore();
    local.add("obs-before", "session-1", vector(1, 0));
    const remote = new FakeRemote();
    remote.points.set("stale", {
      obsId: "stale",
      sessionId: "old",
      embedding: vector(0, 1),
    });
    let releaseReset!: () => void;
    remote.resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const shadow = new ShadowVectorStore(local, remote, {
      reconcileBatchSize: 1,
      retryMs: 0,
      metadataResolver: async (entry) => ({
        canonicalRepoId: `repo/${entry.sessionId}`,
        isLatest: true,
      }),
    });

    const reconciliation = shadow.reconcile();
    await Promise.resolve();
    shadow.add("obs-during", "session-2", vector(0, 1));
    releaseReset();

    expect(await reconciliation).toBe(true);
    expect([...remote.points.keys()].sort()).toEqual(["obs-before", "obs-during"]);
    expect(remote.points.get("obs-during")?.metadata).toMatchObject({
      canonicalRepoId: "repo/session-2",
      isLatest: true,
    });
    expect(shadow.diagnostics()).toMatchObject({
      state: "healthy",
      needsReconcile: false,
      reconciliations: 1,
      pendingMutations: 0,
    });
  });

  it("does not lose a mutation when reconciliation overlaps an active drain", async () => {
    const local = new LocalVectorStore();
    const remote = new FakeRemote();
    const shadow = new ShadowVectorStore(local, remote, {
      reconcileBatchSize: 10,
      retryMs: 0,
    });
    expect(await shadow.reconcile()).toBe(true);

    let releaseUpsert!: () => void;
    remote.upsertGate = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    let markUpsertStarted!: () => void;
    const upsertStarted = new Promise<void>((resolve) => {
      markUpsertStarted = resolve;
    });
    remote.onUpsert = markUpsertStarted;

    shadow.add("obs-draining", "session-1", vector(1, 0));
    await upsertStarted;
    const reconciliation = shadow.reconcile();
    shadow.add("obs-during", "session-2", vector(0, 1));
    releaseUpsert();

    expect(await reconciliation).toBe(true);
    expect([...remote.points.keys()].sort()).toEqual([
      "obs-draining",
      "obs-during",
    ]);
    expect(shadow.diagnostics()).toMatchObject({
      state: "healthy",
      needsReconcile: false,
      pendingMutations: 0,
    });
  });

  it("returns local results before a sampled remote comparison completes", async () => {
    const local = new LocalVectorStore();
    local.add("obs-1", "session-1", vector(1, 0));
    const remote = new FakeRemote();
    const shadow = new ShadowVectorStore(local, remote, {
      sampleRate: 1,
      random: () => 0,
      retryMs: 0,
    });
    expect(await shadow.reconcile()).toBe(true);

    let releaseSearch!: () => void;
    remote.searchGate = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const result = shadow.search(vector(1, 0), { limit: 1 });
    expect(result.map((row) => row.obsId)).toEqual(["obs-1"]);
    expect(shadow.diagnostics().sampledSearches).toBe(1);
    expect(shadow.diagnostics().sampledSearchSuccesses).toBe(0);

    releaseSearch();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shadow.diagnostics()).toMatchObject({
      sampledSearches: 1,
      sampledSearchSuccesses: 1,
      meanOverlapAtK: 1,
    });
  });

  it("bounds mutation backlog and marks the derived mirror for reconciliation", () => {
    const shadow = new ShadowVectorStore(new LocalVectorStore(), new FakeRemote(), {
      pendingLimit: 1,
      retryMs: 0,
    });
    shadow.add("obs-1", "s", vector(1, 0));
    shadow.add("obs-2", "s", vector(0, 1));

    expect(shadow.size).toBe(2);
    expect(shadow.diagnostics()).toMatchObject({
      state: "degraded",
      needsReconcile: true,
      pendingMutations: 0,
    });
  });

  it("delegates restore and dimension validation to the local persistence contract", () => {
    const source = new LocalVectorStore();
    source.add("obs-1", "s", vector(1, 0, 0));
    const shadow = new ShadowVectorStore(new LocalVectorStore(), new FakeRemote(), {
      retryMs: 0,
    });
    shadow.restoreFrom(source);

    expect(shadow.serialize()).toBe(source.serialize());
    expect(shadow.validateDimensions(2).mismatches).toEqual([
      { obsId: "obs-1", dim: 3 },
    ]);
  });
});
