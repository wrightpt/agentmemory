import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  rebuildIndex,
  setEmbeddingProvider,
  setIndexPersistence,
  setVectorStore,
  vectorIndexAddGuarded,
  vectorIndexRemove,
} from "../src/functions/search.js";
import type { VectorStore } from "../src/state/vector-store.js";

describe("VectorStore search singleton integration", () => {
  afterEach(() => {
    setVectorStore(null);
    setEmbeddingProvider(null);
    setIndexPersistence(null);
  });

  it("awaits asynchronous adds before scheduling persistence", async () => {
    const events: string[] = [];
    const store: VectorStore = {
      add: async () => {
        await Promise.resolve();
        events.push("added");
      },
      remove: async () => {},
      search: async () => [],
      size: 0,
      clear: async () => {},
    };
    setVectorStore(store);
    setEmbeddingProvider({
      name: "async-store-test",
      dimensions: 2,
      embed: async () => new Float32Array([1, 0]),
      embedBatch: async (texts) =>
        texts.map(() => new Float32Array([1, 0])),
    });
    setIndexPersistence({
      scheduleSave: () => events.push("scheduled"),
      save: async () => {},
    });

    await expect(
      vectorIndexAddGuarded("obs_1", "ses_1", "test", {
        kind: "observation",
        logId: "obs_1",
      }),
    ).resolves.toBe(true);
    expect(events).toEqual(["added", "scheduled"]);
  });

  it("awaits asynchronous removals and soft-fails backend errors", async () => {
    let removed = false;
    const remove = vi
      .fn()
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        removed = true;
      })
      .mockRejectedValueOnce(new Error("backend unavailable"));
    const store: VectorStore = {
      add: async () => {},
      remove,
      search: async () => [],
      size: 1,
      clear: async () => {},
    };
    setVectorStore(store);

    await expect(vectorIndexRemove("obs_1")).resolves.toBe(true);
    expect(removed).toBe(true);
    await expect(vectorIndexRemove("obs_2")).resolves.toBe(false);
  });

  it("awaits an asynchronous clear before rebuilding", async () => {
    const events: string[] = [];
    const store: VectorStore = {
      add: async () => {},
      remove: async () => {},
      search: async () => [],
      size: 1,
      clear: async () => {
        await Promise.resolve();
        events.push("cleared");
      },
    };
    setVectorStore(store);
    const kv = {
      list: async () => {
        events.push("listed");
        return [];
      },
    };

    await expect(rebuildIndex(kv as never)).resolves.toBe(0);
    expect(events[0]).toBe("cleared");
  });
});
