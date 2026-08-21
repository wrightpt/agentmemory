import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SEED,
  HELDOUT_SEED_SALT,
  VECTOR_DIMENSIONS,
  attemptRestore,
  attemptSerialization,
  evaluateQualityFixture,
  generatePerformanceRecords,
} from "../benchmark/cross-repo-institutional-memory.js";
import {
  calibrationFixture,
  heldoutFixture,
} from "../benchmark/cross-repo-quality-fixtures.js";

describe("cross-repo institutional-memory benchmark", () => {
  it("generates byte-stable corpus identity, timestamps, and 384-d vectors", () => {
    const first = generatePerformanceRecords(24, DEFAULT_SEED);
    const second = generatePerformanceRecords(24, DEFAULT_SEED);

    expect(first.map((row) => row.observation.id)).toEqual(
      second.map((row) => row.observation.id),
    );
    expect(first.map((row) => row.observation.timestamp)).toEqual(
      second.map((row) => row.observation.timestamp),
    );
    expect(first[0].embedding).toHaveLength(VECTOR_DIMENSIONS);
    expect(Array.from(first[17].embedding ?? [])).toEqual(
      Array.from(second[17].embedding ?? []),
    );
  });

  it("keeps calibration and held-out fixtures separate with explicit qrels", async () => {
    const calibration = await evaluateQualityFixture(calibrationFixture, DEFAULT_SEED);
    const heldout = await evaluateQualityFixture(
      heldoutFixture,
      DEFAULT_SEED ^ HELDOUT_SEED_SALT,
    );

    expect(calibration.fixture_digest_sha256).not.toBe(
      heldout.fixture_digest_sha256,
    );
    expect(calibrationFixture.queries.every((query) => Object.keys(query.qrels).length > 0)).toBe(true);
    expect(heldoutFixture.queries.every((query) => Object.keys(query.qrels).length > 0)).toBe(true);
    expect(new Set(heldoutFixture.queries.map((query) => query.category))).toEqual(
      new Set([
        "exact_symbol",
        "semantic_paraphrase",
        "cross_repo_architecture",
        "historical_bug",
        "current_repo_preference",
        "related_dependency",
      ]),
    );
  });

  it("produces deterministic ranks, finds the graph-only target, and suppresses stale rows", async () => {
    const seed = DEFAULT_SEED ^ HELDOUT_SEED_SALT;
    const first = await evaluateQualityFixture(heldoutFixture, seed);
    const second = await evaluateQualityFixture(heldoutFixture, seed);

    for (const mode of ["bm25", "vector", "dual", "triple"] as const) {
      expect(first.modes[mode].rank_digest_sha256).toBe(
        second.modes[mode].rank_digest_sha256,
      );
      expect(first.modes[mode].stale_intrusion_at_5).toBe(0);
      expect(
        first.modes[mode].per_query
          .find((query) => query.query_id === "hold_q_bug")
          ?.top_ids,
      ).not.toContain("hold_bug_old");
      expect(first.modes[mode].provenance_completeness).toBe(1);
      for (const [queryId, targetId] of [
        ["hold_q_semantic", "hold_semantic_target"],
        ["hold_q_bug", "hold_bug_target"],
        ["hold_q_local", "hold_local_target"],
        ["hold_q_related", "hold_related_target"],
      ] as const) {
        expect(
          first.modes[mode].per_query.find(
            (query) => query.query_id === queryId,
          )?.top_ids[0],
        ).toBe(targetId);
      }
    }

    const graphQuery = first.modes.triple.per_query.find(
      (query) => query.query_id === "hold_q_architecture",
    );
    const dualGraphQuery = first.modes.dual.per_query.find(
      (query) => query.query_id === "hold_q_architecture",
    );
    expect(graphQuery?.top_ids).toContain("hold_arch_target");
    expect(dualGraphQuery?.top_ids).not.toContain("hold_arch_target");
    expect(first.modes.bm25.exact_symbol_top_1).toBe(1);
  });

  it("reports serialization and restore failures without a large corpus", () => {
    const serializeTicks = [10, 13];
    const serialization = attemptSerialization(
      () => {
        throw new RangeError("Invalid string length");
      },
      () => serializeTicks.shift()!,
    );
    const skippedRestore = vi.fn();
    const skipped = attemptRestore(
      serialization.value,
      skippedRestore,
      () => 99,
    );

    expect(serialization).toEqual({
      value: null,
      elapsedMs: 3,
      error: "Invalid string length",
    });
    expect(skipped).toEqual({ value: null, elapsedMs: null, error: null });
    expect(skippedRestore).not.toHaveBeenCalled();

    const restoreTicks = [20];
    const restore = attemptRestore(
      "serialized-index",
      () => {
        throw new Error("corrupt index payload");
      },
      () => restoreTicks.shift()!,
    );
    expect(restore).toEqual({
      value: null,
      elapsedMs: null,
      error: "corrupt index payload",
    });
  });
});
