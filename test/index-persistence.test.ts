import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  IndexPersistence,
  shouldRebuildPersistedIndexes,
} from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { LocalVectorStore } from "../src/state/vector-store.js";
import type { CompressedObservation } from "../src/types.js";

const BM25_SCOPE = "mem:index:bm25";
const BM25_LEGACY_KEY = "data";
const BM25_MANIFEST_KEY = "data:manifest";
const REBUILD_BARRIER_KEY = "rebuild:in-progress";
const VECTOR_LEGACY_KEY = "vectors";
const VECTOR_MANIFEST_KEY = "vectors:manifest";
const VECTOR_FALLBACK_MANIFEST_KEY = "vectors:fallback-manifest";

type TestIndexShardManifest = {
  v: 1;
  generation?: string;
  shards: Array<{ scope: string; key: string; chars: number }>;
  chars: number;
};

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
    listGroups: async (): Promise<string[]> => Array.from(store.keys()),
    scopeNames: (): string[] => Array.from(store.keys()),
  };
}

type MockKV = ReturnType<typeof mockKV>;

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

function makeBm25(id: string, title: string): SearchIndex {
  const bm25 = new SearchIndex();
  bm25.add(makeObs({ id, title, narrative: `${title} narrative` }));
  return bm25;
}

function makeVector(id = "obs_1"): VectorIndex {
  const vector = new VectorIndex();
  vector.add(id, "ses_1", new Float32Array([0.1, 0.2, 0.3]));
  return vector;
}

async function getBm25Manifest(kv: MockKV): Promise<TestIndexShardManifest> {
  const manifest = await kv.get<TestIndexShardManifest>(
    BM25_SCOPE,
    BM25_MANIFEST_KEY,
  );
  expect(manifest).not.toBeNull();
  return manifest!;
}

async function getVectorManifest(
  kv: MockKV,
  key = VECTOR_MANIFEST_KEY,
): Promise<TestIndexShardManifest> {
  const manifest = await kv.get<TestIndexShardManifest>(BM25_SCOPE, key);
  expect(manifest).not.toBeNull();
  return manifest!;
}

function generationSequence(...generations: string[]): () => string {
  let index = 0;
  return () => {
    const generation = generations[index++];
    if (!generation) throw new Error("test generation sequence exhausted");
    return generation;
  };
}

describe("IndexPersistence", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.useFakeTimers();
    kv = mockKV();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds when configured vectors are absent or restored from fallback", () => {
    expect(
      shouldRebuildPersistedIndexes({
        bm25Size: 10,
        vectorConfigured: true,
        vectorLoaded: false,
        vectorFallbackUsed: false,
      }),
    ).toBe(true);
    expect(
      shouldRebuildPersistedIndexes({
        bm25Size: 10,
        vectorConfigured: true,
        vectorLoaded: true,
        vectorFallbackUsed: true,
      }),
    ).toBe(true);
    expect(
      shouldRebuildPersistedIndexes({
        bm25Size: 10,
        vectorConfigured: true,
        vectorLoaded: true,
        vectorFallbackUsed: false,
      }),
    ).toBe(false);
    expect(
      shouldRebuildPersistedIndexes({
        bm25Size: 10,
        vectorConfigured: false,
        vectorLoaded: false,
        vectorFallbackUsed: false,
      }),
    ).toBe(false);
  });

  it("saves and loads BM25 index round-trip", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));

    const persistence = new IndexPersistence(kv as never, bm25, null);
    await persistence.save();

    const loaded = await persistence.load();
    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.size).toBe(1);
    const results = loaded.bm25!.search("auth");
    expect(results.length).toBe(1);
  });

  it("saves BM25 index shards outside the BM25 metadata scope", async () => {
    const bm25 = new SearchIndex();
    bm25.add(
      makeObs({
        id: "obs_1",
        title: "auth handler ".repeat(40),
        narrative: "JWT middleware validation ".repeat(40),
      }),
    );

    const persistence = new IndexPersistence(kv as never, bm25, null, {
      shardChars: 80,
      createGeneration: () => "gen_bm25",
    });
    await persistence.save();

    const manifest = await getBm25Manifest(kv);
    expect(manifest.generation).toBe("gen_bm25");
    expect(manifest.shards.length).toBeGreaterThan(1);
    expect(manifest.shards[0].scope).toContain(":gen_bm25:");
    await expect(kv.get(BM25_SCOPE, BM25_LEGACY_KEY)).resolves.toBeNull();
    await expect(
      kv.get(manifest.shards[0].scope, manifest.shards[0].key),
    ).resolves.toEqual(expect.any(String));

    const loaded = await persistence.load();
    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.search("auth").length).toBe(1);
  });

  it("bounds default BM25 shard scopes to two alternating banks", async () => {
    const bm25 = makeBm25("obs_1", "bounded generation snapshot");
    const persistence = new IndexPersistence(kv as never, bm25, null, {
      shardChars: 80,
    });

    const generations: string[] = [];
    for (let save = 0; save < 6; save++) {
      persistence.scheduleSave();
      await persistence.save();
      generations.push((await getBm25Manifest(kv)).generation!);
    }

    expect(generations).toEqual([
      "bank-a",
      "bank-b",
      "bank-a",
      "bank-b",
      "bank-a",
      "bank-b",
    ]);
    const shardScopes = kv
      .scopeNames()
      .filter((scope) => scope.startsWith("mem:index:bm25:bm25:"));
    expect(
      new Set(
        shardScopes.map((scope) => scope.split(":").at(-2)),
      ),
    ).toEqual(new Set(["bank-a", "bank-b"]));
  });

  it("records the previous bank as retired and consumes it on the next save", async () => {
    const persistence = new IndexPersistence(kv as never, null, null, {
      shardChars: 80,
    });
    void persistence;

    const first = new IndexPersistence(kv as never, makeBm25("obs_1", "one ".repeat(60)), null, {
      shardChars: 80,
    });
    await first.save();
    const second = new IndexPersistence(kv as never, makeBm25("obs_2", "two ".repeat(60)), null, {
      shardChars: 80,
    });
    await second.save();

    const manifest2 = await getBm25Manifest(kv);
    expect(manifest2.generation).toBe("bank-b");
    expect(manifest2.retired?.map((r) => r.generation)).toEqual(["bank-a"]);

    const third = new IndexPersistence(kv as never, makeBm25("obs_3", "three ".repeat(30)), null, {
      shardChars: 80,
    });
    await third.save();
    const manifest3 = await getBm25Manifest(kv);
    expect(manifest3.generation).toBe("bank-a");
    // The carried bank-a entry is fully consumed by this save (same scopes
    // rewritten); the freshly retired bank-b becomes the single carried ref.
    expect(manifest3.retired?.map((r) => r.generation)).toEqual(["bank-b"]);
    expect(
      kv.scopeNames().filter((s) => s.includes(":bank-a:") || s.includes(":bank-b:")).length,
    ).toBeLessThanOrEqual(
      (manifest3.shards.length + manifest2.shards.length) * 2,
    );
    const loaded = await new IndexPersistence(kv as never, new SearchIndex(), null, {
      shardChars: 80,
    }).load();
    expect(loaded.bm25?.search("three")[0]?.obsId).toBe("obs_3");
  });

  it("retries retired-bank shard deletes that were rejected on the previous save", async () => {
    const big = new IndexPersistence(kv as never, makeBm25("obs_big", "payload ".repeat(400)), null, {
      shardChars: 60,
    });
    await big.save(); // bank-a, several shards

    const flip = new IndexPersistence(kv as never, makeBm25("obs_flip", "flip ".repeat(400)), null, {
      shardChars: 60,
    });
    await flip.save(); // bank-b
    const manifest2 = await getBm25Manifest(kv);
    expect(manifest2.generation).toBe("bank-b");

    const smallTarget = "mem:index:bm25:bm25:bank-a:00001";
    const rejectingKv = {
      ...kv,
      delete: vi.fn(async (scope: string, key: string) => {
        if (scope === smallTarget) throw new Error("delete unavailable");
        return kv.delete(scope, key);
      }),
    };
    const small = new IndexPersistence(rejectingKv as never, makeBm25("obs_small", "tiny"), null, {
      shardChars: 4000,
    });
    await small.save(); // bank-a rewritten tiny: cannot touch 00000 tail scopes

    const manifest3 = await getBm25Manifest(kv);
    const bankARef = manifest3.retired?.find((r) => r.generation === "bank-a");
    expect(manifest3.generation).toBe("bank-a");
    expect(bankARef?.shards.some((s) => s.scope === smallTarget)).toBe(true);

    await new IndexPersistence(kv as never, makeBm25("obs_next", "next ".repeat(400)), null, {
      shardChars: 60,
    }).save(); // bank-b: retries the rejected delete
    expect(await kv.get(smallTarget, "data")).toBeNull();
    const manifest4 = await getBm25Manifest(kv);
    expect(manifest4.retired?.map((r) => r.generation)).toEqual(["bank-a"]);
    const bankARetryRef = manifest4.retired!.find((r) => r.generation === "bank-a")!;
    void bankARetryRef;
  });

  it("does not attach retired generations to vector manifests", async () => {
    const v1 = new IndexPersistence(kv as never, new SearchIndex(), makeVector("obs_v1"), {
      shardChars: 80,
    });
    await v1.save();
    const v2 = new IndexPersistence(kv as never, new SearchIndex(), makeVector("obs_v2"), {
      shardChars: 80,
    });
    await v2.save();
    expect((await getVectorManifest(kv)).retired).toBeUndefined();
  });

  it("reclaims unreferenced BM25 and vector shard scopes after load", async () => {
    await new IndexPersistence(
      kv as never,
      makeBm25("obs_old", "old persisted snapshot"),
      makeVector("obs_old"),
      {
        shardChars: 80,
        createGeneration: generationSequence("bm25_old", "vector_old"),
      },
    ).save();
    await new IndexPersistence(
      kv as never,
      makeBm25("obs_current", "current persisted snapshot"),
      makeVector("obs_current"),
      {
        shardChars: 80,
        createGeneration: generationSequence("bm25_current", "vector_current"),
      },
    ).save();

    const bm25Manifest = await getBm25Manifest(kv);
    const vectorManifest = await getVectorManifest(kv);
    const fallbackManifest = await getVectorManifest(
      kv,
      VECTOR_FALLBACK_MANIFEST_KEY,
    );
    const orphanBm25 = "mem:index:bm25:bm25:orphaned:00000";
    const orphanVector = "mem:index:bm25:vectors:orphaned:00000";
    await kv.set(orphanBm25, "data", "orphaned BM25 data");
    await kv.set(orphanVector, "data", "orphaned vector data");

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25?.search("current")[0]?.obsId).toBe("obs_current");
    await expect(kv.get(orphanBm25, "data")).resolves.toBeNull();
    await expect(kv.get(orphanVector, "data")).resolves.toBeNull();
    for (const manifest of [bm25Manifest, vectorManifest, fallbackManifest]) {
      const shard = manifest.shards[0];
      await expect(kv.get(shard.scope, shard.key)).resolves.toEqual(
        expect.any(String),
      );
    }
  });

  it("keeps orphaned shards when a manifest is malformed", async () => {
    const orphan = "mem:index:bm25:bm25:manual-recovery:00000";
    await kv.set(orphan, "data", "recoverable shard");
    await kv.set(BM25_SCOPE, BM25_MANIFEST_KEY, {
      v: 1,
      chars: 20,
      shards: "not-an-array",
    });

    await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    await expect(kv.get(orphan, "data")).resolves.toBe("recoverable shard");
  });

  it("keeps orphaned shards when a manifest read fails", async () => {
    const baseKv = mockKV();
    const orphan = "mem:index:bm25:bm25:manual-recovery:00000";
    await baseKv.set(orphan, "data", "recoverable shard");
    const failingKv = {
      ...baseKv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === BM25_SCOPE && key === BM25_MANIFEST_KEY) {
          throw new Error("manifest backend unavailable");
        }
        return baseKv.get<T>(scope, key);
      }),
    };

    await new IndexPersistence(
      failingKv as never,
      new SearchIndex(),
      null,
    ).load();

    await expect(baseKv.get(orphan, "data")).resolves.toBe(
      "recoverable shard",
    );
  });

  it("bounds concurrent orphan shard deletions", async () => {
    const baseKv = mockKV();
    for (let index = 0; index < 5; index++) {
      await baseKv.set(
        "mem:index:bm25:bm25:orphaned:" + String(index).padStart(5, "0"),
        "data",
        "orphan " + index,
      );
    }
    let active = 0;
    let maxActive = 0;
    const guardedKv = {
      ...baseKv,
      delete: vi.fn(async (scope: string, key: string): Promise<void> => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        try {
          await baseKv.delete(scope, key);
        } finally {
          active--;
        }
      }),
    };

    await new IndexPersistence(
      guardedKv as never,
      new SearchIndex(),
      null,
      { shardIoConcurrency: 2 },
    ).load();

    expect(maxActive).toBe(2);
    expect(guardedKv.delete).toHaveBeenCalledTimes(5);
  });

  it("audits one generation write instead of one row per shard", async () => {
    const bm25 = makeBm25(
      "obs_audit",
      "generation-level audit ".repeat(80),
    );
    await new IndexPersistence(kv as never, bm25, null, {
      shardChars: 80,
    }).save();

    const entries = await kv.list<{
      functionId: string;
      details: { action?: string; shards?: number };
    }>("mem:audit");
    const indexEntries = entries.filter(
      (entry) => entry.functionId === "mem::index-persistence",
    );
    expect(
      indexEntries.filter(
        (entry) => entry.details.action === "generation_write",
      ),
    ).toHaveLength(1);
    expect(
      indexEntries.some((entry) => entry.details.action === "shard_write"),
    ).toBe(false);
    expect(
      indexEntries.find(
        (entry) => entry.details.action === "generation_write",
      )?.details.shards,
    ).toBeGreaterThan(1);
  });

  it("bounds concurrent shard writes and reads", async () => {
    const baseKv = mockKV();
    let active = 0;
    let maxActive = 0;
    const track = async <T>(operation: () => Promise<T>): Promise<T> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      try {
        return await operation();
      } finally {
        active--;
      }
    };
    const guardedKv = {
      ...baseKv,
      get: async <T>(scope: string, key: string): Promise<T | null> =>
        scope.startsWith("mem:index:bm25:bm25:")
          ? track(() => baseKv.get<T>(scope, key))
          : baseKv.get<T>(scope, key),
      set: async <T>(scope: string, key: string, data: T): Promise<T> =>
        scope.startsWith("mem:index:bm25:bm25:")
          ? track(() => baseKv.set(scope, key, data))
          : baseKv.set(scope, key, data),
    };
    const persistence = new IndexPersistence(
      guardedKv as never,
      makeBm25("obs_io", "bounded shard input output ".repeat(80)),
      null,
      {
        shardChars: 80,
        shardIoConcurrency: 2,
        createGeneration: () => "gen_io",
      },
    );

    await persistence.save();
    expect(maxActive).toBe(2);

    active = 0;
    maxActive = 0;
    const loaded = await persistence.load();
    expect(loaded.bm25?.size).toBe(1);
    expect(maxActive).toBe(2);
  });

  it("keeps the active bank loadable when the inactive bank write fails", async () => {
    const first = makeBm25("obs_first", "first bank snapshot");
    await new IndexPersistence(kv as never, first, null).save();
    const second = makeBm25("obs_second", "second bank snapshot");
    await new IndexPersistence(kv as never, second, null).save();
    expect((await getBm25Manifest(kv)).generation).toBe("bank-b");

    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope.startsWith("mem:index:bm25:bm25:bank-a:")) {
          throw new Error("inactive bank unavailable");
        }
        return kv.set(scope, key, data);
      }),
    };
    await new IndexPersistence(
      failingKv as never,
      makeBm25("obs_failed", "failed bank snapshot"),
      null,
    ).save();

    expect((await getBm25Manifest(kv)).generation).toBe("bank-b");
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25?.search("second")[0]?.obsId).toBe("obs_second");
    expect(loaded.bm25?.search("failed")).toEqual([]);
  });

  it("loads legacy monolithic BM25 and vector snapshots", async () => {
    const bm25 = makeBm25("obs_1", "legacy auth handler");
    const vector = makeVector("obs_1");
    await kv.set(BM25_SCOPE, BM25_LEGACY_KEY, bm25.serialize());
    await kv.set(BM25_SCOPE, VECTOR_LEGACY_KEY, vector.serialize());

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.search("legacy").length).toBe(1);
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(1);
  });

  it("fails closed instead of falling back when manifest reads fail", async () => {
    const legacy = makeBm25("obs_legacy", "legacy stale snapshot");
    await kv.set(BM25_SCOPE, BM25_LEGACY_KEY, legacy.serialize());
    const failingKv = {
      ...kv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === BM25_SCOPE && key === BM25_MANIFEST_KEY) {
          throw new Error("manifest backend unavailable");
        }
        return kv.get(scope, key);
      }),
    };

    const loaded = await new IndexPersistence(
      failingKv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
  });

  it("fails closed when legacy snapshot reads fail", async () => {
    const failingKv = {
      ...kv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === BM25_SCOPE && key === BM25_LEGACY_KEY) {
          throw new Error("legacy backend unavailable");
        }
        return kv.get(scope, key);
      }),
    };

    const loaded = await new IndexPersistence(
      failingKv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
  });

  it("loads sharded manifests that omit optional generation metadata", async () => {
    const bm25 = makeBm25("obs_1", "deterministic shard auth");
    const serialized = bm25.serialize();
    const chunks = [serialized.slice(0, 50), serialized.slice(50)];
    await kv.set("mem:index:bm25:bm25:00000", "data", chunks[0]);
    await kv.set("mem:index:bm25:bm25:00001", "data", chunks[1]);
    await kv.set<TestIndexShardManifest>(BM25_SCOPE, BM25_MANIFEST_KEY, {
      v: 1,
      chars: serialized.length,
      shards: [
        {
          scope: "mem:index:bm25:bm25:00000",
          key: "data",
          chars: chunks[0].length,
        },
        {
          scope: "mem:index:bm25:bm25:00001",
          key: "data",
          chars: chunks[1].length,
        },
      ],
    });

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).not.toBeNull();
    expect(loaded.bm25!.search("deterministic").length).toBe(1);
  });

  it("saves and loads vector index round-trip", async () => {
    const bm25 = new SearchIndex();
    const vector = makeVector();

    const persistence = new IndexPersistence(kv as never, bm25, vector);
    await persistence.save();

    const loaded = await persistence.load();
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(1);
  });

  it("persists the default LocalVectorStore through the existing codec", async () => {
    const vector = new LocalVectorStore();
    vector.add("obs_local", "ses_local", new Float32Array([1, 0, 0]));
    const persistence = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      vector,
    );

    await persistence.save();
    const loaded = await persistence.load();

    expect(loaded.vector).toBeInstanceOf(LocalVectorStore);
    expect(loaded.vector?.search(new Float32Array([1, 0, 0]), 1)[0].obsId)
      .toBe("obs_local");
  });

  it("saves vector index shards outside the BM25 scope", async () => {
    const bm25 = new SearchIndex();
    const vector = new VectorIndex();
    vector.add(
      "obs_1",
      "ses_1",
      new Float32Array(Array.from({ length: 32 }, (_, i) => i)),
    );

    const persistence = new IndexPersistence(kv as never, bm25, vector, {
      shardChars: 40,
      createGeneration: () => "gen_vector",
    });
    await persistence.save();

    const manifest = await kv.get<TestIndexShardManifest>(
      BM25_SCOPE,
      VECTOR_MANIFEST_KEY,
    );
    expect(manifest).not.toBeNull();
    expect(manifest!.generation).toBe("gen_vector");
    expect(manifest!.shards.length).toBeGreaterThan(1);
    expect(manifest!.shards[0].scope).toContain(":gen_vector:");
    await expect(kv.get(BM25_SCOPE, VECTOR_LEGACY_KEY)).resolves.toBeNull();
    await expect(
      kv.get(manifest!.shards[0].scope, manifest!.shards[0].key),
    ).resolves.toEqual(expect.any(String));

    const loaded = await persistence.load();
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(1);
  });

  it("retains one previous vector generation and cleans the grandparent", async () => {
    await new IndexPersistence(
      kv as never,
      makeBm25("obs_1", "first snapshot"),
      makeVector("obs_1"),
      { createGeneration: generationSequence("bm25_1", "vector_1") },
    ).save();
    const vector1 = await getVectorManifest(kv);

    await new IndexPersistence(
      kv as never,
      makeBm25("obs_2", "second snapshot"),
      makeVector("obs_2"),
      { createGeneration: generationSequence("bm25_2", "vector_2") },
    ).save();
    const vector2 = await getVectorManifest(kv);
    const fallback2 = await getVectorManifest(kv, VECTOR_FALLBACK_MANIFEST_KEY);
    expect(vector2.generation).toBe("vector_2");
    expect(fallback2).toEqual(vector1);
    await expect(
      kv.get(vector1.shards[0].scope, vector1.shards[0].key),
    ).resolves.toEqual(expect.any(String));

    await new IndexPersistence(
      kv as never,
      makeBm25("obs_3", "third snapshot"),
      makeVector("obs_3"),
      { createGeneration: generationSequence("bm25_3", "vector_3") },
    ).save();
    const fallback3 = await getVectorManifest(kv, VECTOR_FALLBACK_MANIFEST_KEY);
    expect(fallback3).toEqual(vector2);
    await expect(
      kv.get(vector1.shards[0].scope, vector1.shards[0].key),
    ).resolves.toBeNull();
    await expect(
      kv.get(vector2.shards[0].scope, vector2.shards[0].key),
    ).resolves.toEqual(expect.any(String));
  });

  it("restores the previous vector generation when current shards are missing", async () => {
    await new IndexPersistence(
      kv as never,
      makeBm25("obs_old", "previous snapshot"),
      makeVector("obs_old"),
      { createGeneration: generationSequence("bm25_old", "vector_old") },
    ).save();
    await new IndexPersistence(
      kv as never,
      makeBm25("obs_new", "current snapshot"),
      makeVector("obs_new"),
      { createGeneration: generationSequence("bm25_new", "vector_new") },
    ).save();
    const current = await getVectorManifest(kv);
    await kv.delete(current.shards[0].scope, current.shards[0].key);

    const persistence = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    );
    const loaded = await persistence.load();

    expect(persistence.usedVectorFallback).toBe(true);
    expect(loaded.vector?.size).toBe(1);
    expect(
      loaded.vector?.search(new Float32Array([0.1, 0.2, 0.3]))[0]?.obsId,
    ).toBe("obs_old");
  });

  it("persists empty vector snapshots so cleared vectors do not reload", async () => {
    const previousBm25 = makeBm25("obs_old", "alpha previous snapshot");
    const previousVector = makeVector("obs_old");
    await new IndexPersistence(kv as never, previousBm25, previousVector, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();

    const nextBm25 = makeBm25("obs_new", "bravo new snapshot");
    const emptyVector = new VectorIndex();
    await new IndexPersistence(kv as never, nextBm25, emptyVector, {
      shardChars: 80,
      createGeneration: () => "gen_empty",
    }).save();

    const vectorManifest = await kv.get<TestIndexShardManifest>(
      BM25_SCOPE,
      VECTOR_MANIFEST_KEY,
    );
    expect(vectorManifest).not.toBeNull();
    expect(vectorManifest!.generation).toBe("gen_empty");
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("bravo").length).toBe(1);
    expect(loaded.vector).not.toBeNull();
    expect(loaded.vector!.size).toBe(0);
  });

  it("avoids one oversized state::set string payload for persisted indexes", async () => {
    const maxStringPayloadChars = 80;
    const bm25 = new SearchIndex();
    bm25.add(
      makeObs({
        id: "obs_1",
        title: "large persisted snapshot ".repeat(40),
        narrative: "oversized state set reproduction ".repeat(40),
      }),
    );
    const vector = new VectorIndex();
    vector.add(
      "obs_1",
      "ses_1",
      new Float32Array(Array.from({ length: 64 }, (_, i) => i / 10)),
    );
    const guardedKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (
          typeof data === "string" &&
          data.length > maxStringPayloadChars
        ) {
          throw new Error(`oversized state::set payload: ${scope}/${key}`);
        }
        return kv.set(scope, key, data);
      }),
    };

    await new IndexPersistence(guardedKv as never, bm25, vector, {
      shardChars: maxStringPayloadChars,
      createGeneration: () => "gen_payload_limit",
    }).save();

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("oversized").length).toBe(1);
    expect(loaded.vector!.size).toBe(1);
  });

  it("falls back to the default shard size for fractional values below one", async () => {
    const bm25 = makeBm25("obs_fraction", "fractional shard config");
    let newShardWrites = 0;
    const guardedKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope.includes(":gen_fraction:")) {
          newShardWrites += 1;
          if (newShardWrites > 3) {
            throw new Error("fractional shard size caused zero-width shards");
          }
        }
        return kv.set(scope, key, data);
      }),
    };

    await new IndexPersistence(guardedKv as never, bm25, null, {
      shardChars: 0.5,
      createGeneration: () => "gen_fraction",
    }).save();

    const manifest = await getBm25Manifest(kv);
    expect(manifest.generation).toBe("gen_fraction");
    expect(manifest.shards.length).toBe(1);
    expect(newShardWrites).toBe(1);
  });

  it("keeps the previous generation when a shard write fails before manifest commit", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();
    const previousManifest = await getBm25Manifest(kv);

    let newShardWrites = 0;
    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope.includes(":gen_new:")) {
          newShardWrites += 1;
          if (newShardWrites === 2) throw new Error("shard write failed");
        }
        return kv.set(scope, key, data);
      }),
    };

    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(failingKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toEqual(
      previousManifest,
    );
    await expect(
      kv.get("mem:index:bm25:bm25:gen_new:00000", "data"),
    ).resolves.toBeNull();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("alpha").length).toBe(1);
    expect(loaded.bm25!.search("bravo").length).toBe(0);
  });

  it("keeps the previous generation when manifest set rejects before commit", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();
    const previousManifest = await getBm25Manifest(kv);

    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === BM25_SCOPE && key === BM25_MANIFEST_KEY) {
          throw new Error("manifest write failed");
        }
        return kv.set(scope, key, data);
      }),
    };

    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(failingKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toEqual(
      previousManifest,
    );
    await expect(
      kv.get("mem:index:bm25:bm25:gen_new:00000", "data"),
    ).resolves.toBeNull();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("alpha").length).toBe(1);
    expect(loaded.bm25!.search("bravo").length).toBe(0);
  });

  it("keeps a generation loadable when manifest set commits before rejecting", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();

    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === BM25_SCOPE && key === BM25_MANIFEST_KEY) {
          await kv.set(scope, key, data);
          throw new Error("manifest write timed out after commit");
        }
        return kv.set(scope, key, data);
      }),
    };

    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(failingKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    const manifest = await getBm25Manifest(kv);
    expect(manifest.generation).toBe("gen_new");
    await expect(
      kv.get("mem:index:bm25:bm25:gen_new:00000", "data"),
    ).resolves.toEqual(expect.any(String));
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("bravo").length).toBe(1);
  });

  it("continues to vector publication after a committed BM25 manifest timeout", async () => {
    await new IndexPersistence(
      kv as never,
      makeBm25("obs_old", "alpha previous snapshot"),
      makeVector("obs_old"),
      { createGeneration: generationSequence("bm25_old", "vector_old") },
    ).save();

    const timeoutAfterCommitKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === BM25_SCOPE && key === BM25_MANIFEST_KEY) {
          await kv.set(scope, key, data);
          throw new Error("BM25 manifest timed out after commit");
        }
        return kv.set(scope, key, data);
      }),
    };
    await new IndexPersistence(
      timeoutAfterCommitKv as never,
      makeBm25("obs_new", "bravo current snapshot"),
      makeVector("obs_new"),
      { createGeneration: generationSequence("bm25_new", "vector_new") },
    ).save();

    const vectorManifest = await getVectorManifest(kv);
    expect(vectorManifest.generation).toBe("vector_new");
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25?.search("bravo")[0]?.obsId).toBe("obs_new");
    expect(
      loaded.vector?.search(new Float32Array([0.1, 0.2, 0.3]))[0]?.obsId,
    ).toBe("obs_new");
  });

  it("deletes a shard that committed before set rejected", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();
    const previousManifest = await getBm25Manifest(kv);

    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === "mem:index:bm25:bm25:gen_new:00000") {
          await kv.set(scope, key, data);
          throw new Error("state::set timed out after commit");
        }
        return kv.set(scope, key, data);
      }),
    };

    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(failingKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toEqual(
      previousManifest,
    );
    await expect(
      kv.get("mem:index:bm25:bm25:gen_new:00000", "data"),
    ).resolves.toBeNull();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("alpha").length).toBe(1);
    expect(loaded.bm25!.search("bravo").length).toBe(0);
  });

  it("loads the new generation even when old generation cleanup fails", async () => {
    const previous = makeBm25("obs_old", "alpha previous snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();

    const cleanupKv = {
      ...kv,
      delete: vi.fn(async () => {
        throw new Error("cleanup failed");
      }),
    };
    const next = makeBm25("obs_new", "bravo new snapshot");
    await new IndexPersistence(cleanupKv as never, next, null, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    const manifest = await getBm25Manifest(kv);
    expect(manifest.generation).toBe("gen_new");
    expect(cleanupKv.delete).toHaveBeenCalled();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("bravo").length).toBe(1);
    expect(loaded.bm25!.search("alpha").length).toBe(0);
  });

  it("keeps the previous vector generation when vector save fails after BM25 publish", async () => {
    const previousBm25 = makeBm25("obs_old", "alpha previous snapshot");
    const previousVector = makeVector("obs_old");
    await new IndexPersistence(kv as never, previousBm25, previousVector, {
      shardChars: 80,
      createGeneration: () => "gen_old",
    }).save();

    const failingKv = {
      ...kv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === BM25_SCOPE && key === VECTOR_MANIFEST_KEY) {
          throw new Error("vector manifest write failed");
        }
        return kv.set(scope, key, data);
      }),
    };
    const nextBm25 = makeBm25("obs_new", "bravo new snapshot");
    const nextVector = new VectorIndex();
    nextVector.add("obs_new", "ses_1", new Float32Array([0.4, 0.5, 0.6]));

    await new IndexPersistence(failingKv as never, nextBm25, nextVector, {
      shardChars: 80,
      createGeneration: () => "gen_new",
    }).save();

    await expect(
      kv.get("mem:index:bm25:vectors:gen_new:00000", "data"),
    ).resolves.toBeNull();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25!.search("bravo").length).toBe(1);
    expect(loaded.vector!.size).toBe(1);
    expect(
      loaded.vector!.search(new Float32Array([0.1, 0.2, 0.3]))[0]?.obsId,
    ).toBe("obs_old");
  });

  it("fails closed when a manifest shard is missing", async () => {
    const bm25 = makeBm25("obs_1", "alpha sharded snapshot");
    await new IndexPersistence(kv as never, bm25, null, {
      shardChars: 80,
      createGeneration: () => "gen_missing",
    }).save();
    const manifest = await getBm25Manifest(kv);
    await kv.delete(manifest.shards[0].scope, manifest.shards[0].key);

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
  });

  it("fails closed when a manifest shard length mismatches", async () => {
    const bm25 = makeBm25("obs_1", "alpha sharded snapshot");
    await new IndexPersistence(kv as never, bm25, null, {
      shardChars: 80,
      createGeneration: () => "gen_mismatch",
    }).save();
    const manifest = await getBm25Manifest(kv);
    const firstShard = manifest.shards[0];
    const chunk = await kv.get<string>(firstShard.scope, firstShard.key);
    await kv.set(firstShard.scope, firstShard.key, `${chunk}x`);

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
  });

  it("fails closed before reading invalid shard descriptors", async () => {
    await kv.set<TestIndexShardManifest>(BM25_SCOPE, BM25_MANIFEST_KEY, {
      v: 1,
      chars: 10,
      shards: [{ scope: "", key: "data", chars: 10 }],
    });
    const guardedKv = {
      ...kv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === "") {
          throw new Error("invalid shard descriptor was read");
        }
        return kv.get(scope, key);
      }),
    };

    const loaded = await new IndexPersistence(
      guardedKv as never,
      new SearchIndex(),
      null,
    ).load();

    expect(loaded.bm25).toBeNull();
    expect(guardedKv.get).not.toHaveBeenCalledWith("", "data");
  });

  it("scheduleSave debounces multiple calls", async () => {
    const bm25 = new SearchIndex();
    const persistence = new IndexPersistence(kv as never, bm25, null, {
      debounceMs: 5_000,
    });

    persistence.scheduleSave();
    persistence.scheduleSave();
    persistence.scheduleSave();

    await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toBeNull();

    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync();

    const saved = await kv.get<string>(BM25_SCOPE, BM25_MANIFEST_KEY);
    expect(saved).not.toBeNull();
  });

  it("waits for the default quiet period before snapshotting", async () => {
    const bm25 = makeBm25("obs_quiet", "quiet period snapshot");
    const persistence = new IndexPersistence(kv as never, bm25, null);

    persistence.scheduleSave();

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(kv.get(BM25_SCOPE, BM25_MANIFEST_KEY)).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(55_000);
    await expect(
      kv.get(BM25_SCOPE, BM25_MANIFEST_KEY),
    ).resolves.not.toBeNull();
  });

  it("suppresses snapshots and loads while a rebuild barrier is active", async () => {
    const previous = makeBm25("obs_previous", "previous complete snapshot");
    await new IndexPersistence(kv as never, previous, null, {
      createGeneration: () => "gen_previous",
      debounceMs: 10,
    }).save();

    const rebuilding = new IndexPersistence(
      kv as never,
      makeBm25("obs_rebuilt", "rebuilt snapshot"),
      null,
      { createGeneration: () => "gen_rebuilt", debounceMs: 10 },
    );
    await rebuilding.beginRebuild();
    rebuilding.scheduleSave();
    await rebuilding.save();
    await vi.advanceTimersByTimeAsync(20);

    const manifest = await getBm25Manifest(kv);
    expect(manifest.generation).toBe("gen_previous");
    await expect(
      kv.get(BM25_SCOPE, REBUILD_BARRIER_KEY),
    ).resolves.toMatchObject({ v: 1 });
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded).toEqual({ bm25: null, vector: null });
  });

  it("fails closed when the rebuild barrier cannot be read", async () => {
    const previous = makeBm25("obs_previous", "previous complete snapshot");
    await new IndexPersistence(kv as never, previous, null).save();
    const guardedKv = {
      ...kv,
      get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
        if (scope === BM25_SCOPE && key === REBUILD_BARRIER_KEY) {
          throw new Error("barrier backend unavailable");
        }
        return kv.get<T>(scope, key);
      }),
    };

    const loaded = await new IndexPersistence(
      guardedKv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded).toEqual({ bm25: null, vector: null });
    expect(guardedKv.get).not.toHaveBeenCalledWith(
      BM25_SCOPE,
      BM25_MANIFEST_KEY,
    );
  });

  it("publishes rebuilt indexes before clearing the durable barrier", async () => {
    const bm25 = makeBm25("obs_rebuilt", "complete rebuilt snapshot");
    const vector = makeVector("obs_rebuilt");
    const persistence = new IndexPersistence(kv as never, bm25, vector, {
      createGeneration: (() => {
        let generation = 0;
        return () => `gen_complete_${++generation}`;
      })(),
    });

    await persistence.beginRebuild();
    await expect(persistence.completeRebuild()).resolves.toBe(true);
    await expect(
      kv.get(BM25_SCOPE, REBUILD_BARRIER_KEY),
    ).resolves.toBeNull();

    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25?.search("complete")[0]?.obsId).toBe("obs_rebuilt");
    expect(loaded.vector?.size).toBe(1);
  });

  it("accepts a rebuild-barrier delete that committed before timing out", async () => {
    const baseKv = mockKV();
    const timeoutAfterCommitKv = {
      ...baseKv,
      delete: vi.fn(async (scope: string, key: string): Promise<void> => {
        await baseKv.delete(scope, key);
        if (scope === BM25_SCOPE && key === REBUILD_BARRIER_KEY) {
          throw new Error("delete timed out after commit");
        }
      }),
    };
    const persistence = new IndexPersistence(
      timeoutAfterCommitKv as never,
      makeBm25("obs_committed", "delete committed snapshot"),
      null,
    );

    await persistence.beginRebuild();
    await expect(persistence.completeRebuild()).resolves.toBe(true);
    const loaded = await new IndexPersistence(
      baseKv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.bm25?.size).toBe(1);
  });

  it("leaves the rebuild barrier active when either snapshot fails", async () => {
    const baseKv = mockKV();
    const failingKv = {
      ...baseKv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === BM25_SCOPE && key === VECTOR_MANIFEST_KEY) {
          throw new Error("vector manifest unavailable");
        }
        return baseKv.set(scope, key, data);
      }),
    };
    const persistence = new IndexPersistence(
      failingKv as never,
      makeBm25("obs_partial", "must not be restored"),
      makeVector("obs_partial"),
      {
        createGeneration: (() => {
          let generation = 0;
          return () => `gen_failed_${++generation}`;
        })(),
      },
    );

    await persistence.beginRebuild();
    await expect(persistence.completeRebuild()).resolves.toBe(false);
    await expect(
      baseKv.get(BM25_SCOPE, REBUILD_BARRIER_KEY),
    ).resolves.toMatchObject({ v: 1 });
    const loaded = await new IndexPersistence(
      baseKv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded).toEqual({ bm25: null, vector: null });
  });

  it("coalesces writes arriving during rebuild publication into a follow-up", async () => {
    const baseKv = mockKV();
    const generations: string[] = [];
    let queuedFollowUp = false;
    let persistence!: IndexPersistence;
    const guardedKv = {
      ...baseKv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope.includes(":bm25:gen_1:") && !queuedFollowUp) {
          queuedFollowUp = true;
          persistence.scheduleSave();
        }
        return baseKv.set(scope, key, data);
      }),
    };
    persistence = new IndexPersistence(
      guardedKv as never,
      makeBm25("obs_followup", "follow-up snapshot"),
      null,
      {
        createGeneration: () => {
          const generation = `gen_${generations.length + 1}`;
          generations.push(generation);
          return generation;
        },
        debounceMs: 10,
      },
    );

    await persistence.beginRebuild();
    await expect(persistence.completeRebuild()).resolves.toBe(true);
    expect(generations).toEqual(["gen_1"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(generations).toEqual(["gen_1", "gen_2"]);
  });

  it("serializes overlapping explicit saves and coalesces a follow-up generation", async () => {
    const baseKv = mockKV();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let firstShardBlocked = false;
    const guardedKv = {
      ...baseKv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope.includes(":bm25:gen_1:") && !firstShardBlocked) {
          firstShardBlocked = true;
          markFirstStarted();
          await firstBlocked;
        }
        return baseKv.set(scope, key, data);
      }),
    };
    const generations: string[] = [];
    const persistence = new IndexPersistence(
      guardedKv as never,
      makeBm25("obs_serial", "single flight snapshot"),
      null,
      {
        createGeneration: () => {
          const generation = `gen_${generations.length + 1}`;
          generations.push(generation);
          return generation;
        },
      },
    );

    const first = persistence.save();
    await firstStarted;
    const second = persistence.save();
    await Promise.resolve();

    expect(generations).toEqual(["gen_1"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(generations).toEqual(["gen_1", "gen_2"]);
    const loaded = await persistence.load();
    expect(loaded.bm25?.size).toBe(1);
  });

  it("returns from an explicit save when writes continue during snapshots", async () => {
    const baseKv = mockKV();
    const generations: string[] = [];
    const scheduledDuring = new Set<string>();
    let persistence!: IndexPersistence;
    const guardedKv = {
      ...baseKv,
      set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
        const generation = scope.match(/:bm25:(gen_\d+):/)?.[1];
        if (generation && !scheduledDuring.has(generation)) {
          scheduledDuring.add(generation);
          persistence.scheduleSave();
        }
        return baseKv.set(scope, key, data);
      }),
    };
    persistence = new IndexPersistence(
      guardedKv as never,
      makeBm25("obs_bounded", "bounded explicit snapshot"),
      null,
      {
        createGeneration: () => {
          const generation = `gen_${generations.length + 1}`;
          generations.push(generation);
          return generation;
        },
        debounceMs: 10,
      },
    );

    await persistence.save();
    expect(generations).toEqual(["gen_1"]);

    await vi.advanceTimersByTimeAsync(10);
    expect(generations).toEqual(["gen_1", "gen_2"]);
  });

  it("stop clears the pending timer", async () => {
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(kv as never, bm25, null, {
      debounceMs: 5_000,
    });

    persistence.scheduleSave();
    persistence.stop();

    vi.advanceTimersByTime(10000);
    const saved = await kv.get<string>(BM25_SCOPE, BM25_MANIFEST_KEY);
    expect(saved).toBeNull();
  });

  it("returns null indexes when nothing has been saved", async () => {
    const bm25 = new SearchIndex();
    const persistence = new IndexPersistence(kv as never, bm25, null);

    const loaded = await persistence.load();
    expect(loaded.bm25).toBeNull();
    expect(loaded.vector).toBeNull();
  });

  it("scheduled save swallows kv.set rejection without unhandledRejection (#204)", async () => {
    const failingKv = {
      ...mockKV(),
      set: vi.fn(async () => {
        const err = new Error(
          "TIMEOUT: invocation timed out after 30000ms",
        ) as Error & { code?: string; function_id?: string };
        err.code = "TIMEOUT";
        err.function_id = "state::set";
        throw err;
      }),
    };
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(failingKv as never, bm25, null, {
      debounceMs: 5_000,
    });

    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      persistence.scheduleSave();
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();
      // give microtasks a chance to flush
      await Promise.resolve();
      expect(failingKv.set).toHaveBeenCalled();
      expect(unhandled).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("save() does not throw when kv.set rejects (#204)", async () => {
    const failingKv = {
      ...mockKV(),
      set: vi.fn(async () => {
        throw new Error("TIMEOUT");
      }),
    };
    const bm25 = new SearchIndex();
    bm25.add(makeObs({ id: "obs_1", title: "auth handler" }));
    const persistence = new IndexPersistence(failingKv as never, bm25, null);

    await expect(persistence.save()).resolves.toBeUndefined();
  });

  // #797: first run after upgrading to 0.9.25 crashed with
  // 'TypeError: Cannot read properties of undefined (reading "v")'
  // because some iii-state adapters return `undefined` (not `null`)
  // for a missing key. The load path's `value !== null` check passed
  // undefined to loadManifestData, which then read `undefined.v`.
  it("load() returns null instead of crashing when kv.get returns undefined for the manifest (#797)", async () => {
    const undefinedKv = {
      ...mockKV(),
      get: vi.fn(async () => undefined),
    };
    const persistence = new IndexPersistence(
      undefinedKv as never,
      new SearchIndex(),
      null,
    );

    const loaded = await persistence.load();
    expect(loaded.bm25).toBeNull();
    expect(loaded.vector).toBeNull();
  });

  it("load() does not crash when a manifest row value is the wrong shape (#797)", async () => {
    const wrongShapeKv = {
      ...mockKV(),
      get: vi.fn(async () => "not-a-manifest"),
    };
    const persistence = new IndexPersistence(
      wrongShapeKv as never,
      new SearchIndex(),
      null,
    );

    await expect(persistence.load()).resolves.toBeDefined();
  });
});
