import { describe, expect, it } from "vitest";
import { MetricsStore } from "../src/eval/metrics-store.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

describe("MetricsStore outcomes", () => {
  it("normalizes legacy rows and records disabled calls as skipped", async () => {
    const kv = mockKV();
    await kv.set(KV.metrics, "mem::summarize", {
      functionId: "mem::summarize",
      totalCalls: 4,
      successCount: 1,
      failureCount: 3,
      avgLatencyMs: 10,
      avgQualityScore: 80,
    });
    const metrics = new MetricsStore(kv as never);

    await metrics.recordSkipped(
      "mem::summarize",
      2,
      "llm_tools_disabled",
    );

    expect(await metrics.get("mem::summarize")).toMatchObject({
      totalCalls: 5,
      successCount: 1,
      failureCount: 3,
      skippedCount: 1,
      lastOutcome: "skipped_disabled",
      lastSkipReason: "llm_tools_disabled",
    });
  });

  it("serializes concurrent updates so skipped counts are not lost", async () => {
    const metrics = new MetricsStore(mockKV() as never);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        metrics.recordSkipped(
          "mem::compress",
          1,
          "no_llm_provider",
        ),
      ),
    );

    expect(await metrics.get("mem::compress")).toMatchObject({
      totalCalls: 20,
      successCount: 0,
      failureCount: 0,
      skippedCount: 20,
      lastOutcome: "skipped_unavailable",
      lastSkipReason: "no_llm_provider",
    });
  });
});
