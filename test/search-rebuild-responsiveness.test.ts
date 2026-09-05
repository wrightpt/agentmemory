import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSearchIndex,
  rebuildIndex,
  setEmbeddingProvider,
  setVectorIndex,
} from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import { VectorIndex } from "../src/state/vector-index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  setEmbeddingProvider(null);
  setVectorIndex(null);
  getSearchIndex().clear();
});

describe("rebuild responsiveness", () => {
  it.each([
    { provider: "local", override: undefined, sizes: [1, 1, 1, 1, 1] },
    { provider: "local", override: "invalid", sizes: [1, 1, 1, 1, 1] },
    { provider: "local", override: "2", sizes: [2, 2, 1] },
    { provider: "openai", override: undefined, sizes: [5] },
  ])("bounds $provider batches with override $override and services pending I/O", async ({ provider, override, sizes }) => {
    vi.stubEnv("REBUILD_EMBED_BATCH_SIZE", override);
    const memories = Array.from({ length: 5 }, (_, n) => ({
      id: `memory_${n}`,
      title: `Durable decision ${n}`,
      content: "Preserve the authoritative records during rebuilding.",
      isLatest: true,
      sessionIds: [],
      tags: [],
      concepts: [],
      files: [],
      createdAt: "2026-09-05T00:00:00Z",
      updatedAt: "2026-09-05T00:00:00Z",
    }));
    const kv = {
      list: async (scope: string) => scope === KV.memories ? memories : [],
      listGroups: async () => [],
    };
    let serviced = false;
    const servicedBeforeBatch: boolean[] = [];
    let heartbeat: ReturnType<typeof setImmediate> | undefined;
    const embedBatch = vi.fn(async (texts: string[]) => {
      servicedBeforeBatch.push(serviced);
      // A native provider can resolve without giving the event loop a turn.
      // Simulate a health request becoming runnable during the first batch.
      if (servicedBeforeBatch.length === 1) {
        heartbeat = setImmediate(() => { serviced = true; });
      }
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
    });
    setEmbeddingProvider({
      name: provider,
      dimensions: 3,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
      embedBatch,
    });
    setVectorIndex(new VectorIndex());
    try {
      await expect(rebuildIndex(kv as never)).resolves.toBe(5);
      expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual(sizes);
      expect(serviced).toBe(true);
      expect(servicedBeforeBatch).toEqual(sizes.map((_, n) => n > 0));
    } finally {
      if (heartbeat) clearImmediate(heartbeat);
    }
  });
});
