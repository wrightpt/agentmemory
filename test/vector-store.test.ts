import { describe, expect, it } from "vitest";
import { VectorIndex } from "../src/state/vector-index.js";
import {
  LocalVectorStore,
  type PersistableLocalVectorStore,
  type VectorStore,
} from "../src/state/vector-store.js";

describe("VectorStore boundary", () => {
  it("exposes the existing exact cosine behavior through LocalVectorStore", async () => {
    const store: VectorStore = new LocalVectorStore();
    await store.add("obs_close", "ses_1", new Float32Array([1, 0, 0]));
    await store.add("obs_far", "ses_2", new Float32Array([0, 1, 0]));
    await store.add(
      "obs_medium",
      "ses_3",
      new Float32Array([0.7, 0.7, 0]),
    );

    const results = await store.search(new Float32Array([1, 0, 0]), {
      limit: 2,
    });

    expect(results.map((result) => result.obsId)).toEqual([
      "obs_close",
      "obs_medium",
    ]);
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it("keeps VectorIndex source-compatible, including numeric limits", () => {
    const index = new VectorIndex();
    index.add("obs_1", "ses_1", new Float32Array([1, 0]));
    index.add("obs_2", "ses_2", new Float32Array([0, 1]));

    expect(index).toBeInstanceOf(LocalVectorStore);
    expect(index.search(new Float32Array([1, 0]), 1)).toEqual([
      { obsId: "obs_1", sessionId: "ses_1", score: 1 },
    ]);
  });

  it("breaks exact-score ties by observation id independent of insertion order", () => {
    const first = new LocalVectorStore();
    const second = new LocalVectorStore();
    for (const id of ["obs_z", "obs_a", "obs_m"]) {
      first.add(id, "ses", new Float32Array([1, 0]));
    }
    for (const id of ["obs_m", "obs_a", "obs_z"]) {
      second.add(id, "ses", new Float32Array([1, 0]));
    }

    expect(first.search(new Float32Array([1, 0]), 2).map((row) => row.obsId))
      .toEqual(["obs_a", "obs_m"]);
    expect(second.search(new Float32Array([1, 0]), 2).map((row) => row.obsId))
      .toEqual(["obs_a", "obs_m"]);
  });

  it("preserves legacy snapshots and optional metadata through the local codec", () => {
    const legacy = JSON.stringify([
      [
        "obs_legacy",
        {
          embedding: Buffer.from(
            new Float32Array([1, 0]).buffer,
          ).toString("base64"),
          sessionId: "ses_legacy",
        },
      ],
    ]);
    const restored = LocalVectorStore.deserialize(legacy);
    expect(restored.search(new Float32Array([1, 0]), 1)[0]).toEqual({
      obsId: "obs_legacy",
      sessionId: "ses_legacy",
      score: 1,
    });

    const persistable: PersistableLocalVectorStore = new LocalVectorStore();
    persistable.add("obs_meta", "ses_meta", new Float32Array([0, 1]), {
      canonicalRepoId: "wrightpt/agentmemory",
    });
    const metadataRoundTrip = LocalVectorStore.deserialize(
      persistable.serialize(),
    );
    expect(metadataRoundTrip.search(new Float32Array([0, 1]), 1)[0].metadata)
      .toEqual({ canonicalRepoId: "wrightpt/agentmemory" });
  });

  it("retains dimension validation and defensive malformed-row migration", () => {
    const restored = LocalVectorStore.deserialize(
      JSON.stringify([
        ["bad"],
        [
          "good",
          {
            embedding: Buffer.from(
              new Float32Array([1, 0, 0]).buffer,
            ).toString("base64"),
            sessionId: "ses_1",
          },
        ],
      ]),
    );

    expect(restored.size).toBe(1);
    expect(restored.validateDimensions(2)).toEqual({
      mismatches: [{ obsId: "good", dim: 3 }],
      seenDimensions: new Set([3]),
    });
  });
});
