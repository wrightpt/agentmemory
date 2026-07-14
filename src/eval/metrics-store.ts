import type { FunctionMetrics } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

type FunctionOutcome =
  | "success"
  | "failure"
  | "skipped_disabled"
  | "skipped_unavailable";

type SkipReason = "llm_tools_disabled" | "no_llm_provider";

export class MetricsStore {
  private cache = new Map<string, FunctionMetrics>();
  private qualityCallCounts = new Map<string, number>();

  constructor(private kv: StateKV) {}

  private normalize(metric: FunctionMetrics): FunctionMetrics {
    return {
      ...metric,
      skippedCount: metric.skippedCount ?? 0,
    };
  }

  private async load(functionId: string): Promise<FunctionMetrics> {
    const cached = this.cache.get(functionId);
    if (cached) return this.normalize(cached);
    const stored = await this.kv.get<FunctionMetrics>(KV.metrics, functionId);
    return this.normalize(
      stored ?? {
        functionId,
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        skippedCount: 0,
        avgLatencyMs: 0,
        avgQualityScore: 0,
      },
    );
  }

  private async recordOutcome(
    functionId: string,
    latencyMs: number,
    outcome: FunctionOutcome,
    qualityScore?: number,
    skipReason?: SkipReason,
  ): Promise<void> {
    await withKeyedLock(`metrics:${functionId}`, async () => {
      const previous = await this.load(functionId);
      const metric: FunctionMetrics = { ...previous };
      const previousCalls = metric.totalCalls;
      metric.totalCalls += 1;
      metric.avgLatencyMs =
        (metric.avgLatencyMs * previousCalls + latencyMs) / metric.totalCalls;
      metric.lastOutcome = outcome;
      if (outcome === "success") metric.successCount += 1;
      if (outcome === "failure") metric.failureCount += 1;
      if (outcome === "skipped_disabled" || outcome === "skipped_unavailable") {
        metric.skippedCount += 1;
        metric.lastSkipReason = skipReason;
      }
      if (qualityScore !== undefined) {
        const previousQualityCalls = this.qualityCallCounts.get(functionId) || 0;
        metric.avgQualityScore =
          (metric.avgQualityScore * previousQualityCalls + qualityScore) /
          (previousQualityCalls + 1);
        this.qualityCallCounts.set(functionId, previousQualityCalls + 1);
      }

      this.cache.set(functionId, metric);
      await this.kv.set(KV.metrics, functionId, metric).catch(() => {});
    });
  }

  async record(
    functionId: string,
    latencyMs: number,
    success: boolean,
    qualityScore?: number,
  ): Promise<void> {
    await this.recordOutcome(
      functionId,
      latencyMs,
      success ? "success" : "failure",
      qualityScore,
    );
  }

  async recordSkipped(
    functionId: string,
    latencyMs: number,
    reason: SkipReason,
  ): Promise<void> {
    await this.recordOutcome(
      functionId,
      latencyMs,
      reason === "llm_tools_disabled"
        ? "skipped_disabled"
        : "skipped_unavailable",
      undefined,
      reason,
    );
  }

  async get(functionId: string): Promise<FunctionMetrics | null> {
    const metric =
      this.cache.get(functionId) ??
      (await this.kv.get<FunctionMetrics>(KV.metrics, functionId));
    return metric ? this.normalize(metric) : null;
  }

  async getAll(): Promise<FunctionMetrics[]> {
    const kvMetrics = await this.kv
      .list<FunctionMetrics>(KV.metrics)
      .catch(() => []);
    const merged = new Map<string, FunctionMetrics>();
    for (const m of kvMetrics) merged.set(m.functionId, this.normalize(m));
    for (const [id, m] of this.cache) merged.set(id, this.normalize(m));
    return Array.from(merged.values());
  }
}
