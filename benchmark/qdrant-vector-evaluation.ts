/**
 * Isolated Qdrant decision-gate benchmark for AgentMemory's VectorStore seam.
 *
 * This is an evaluation harness, not a production backend. It refuses remote
 * endpoints and non-benchmark collection names unless explicitly overridden.
 * The caller owns container lifecycle so startup/restore and container RSS can
 * be measured independently from this Node process.
 *
 * Fresh run:
 *   QDRANT_URL=http://127.0.0.1:6333 \
 *   QDRANT_COLLECTION=agentmemory_eval_10000 BENCH_N=10000 \
 *   BENCH_OUT=/tmp/qdrant-10000.json \
 *   node --expose-gc --import tsx benchmark/qdrant-vector-evaluation.ts
 *
 * Post-restart probe against the retained collection:
 *   BENCH_REUSE=1 ...same variables...
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  VectorMetadata,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from "../src/state/vector-store.js";
import { pXX } from "./lib/percentiles.js";
import {
  DEFAULT_SEED,
  HELDOUT_SEED_SALT,
  VECTOR_DIMENSIONS,
  deterministicEmbedding,
  evaluateQualityFixture,
  generatePerformanceRecords,
} from "./cross-repo-institutional-memory.js";
import { heldoutFixture } from "./cross-repo-quality-fixtures.js";

const CANDIDATE_LIMIT = 100;
const DEFAULT_BATCH_SIZE = 256;
const DEFAULT_QUERY_COUNT = 1_000;
const DEFAULT_CONCURRENCY = [1, 4, 8, 16];
const DEFAULT_READY_TIMEOUT_MS = 15 * 60_000;

interface QdrantPoint {
  id: number;
  vector: number[];
  payload: Record<string, unknown>;
}

interface QdrantQueryPoint {
  id: number | string;
  score: number;
  payload?: Record<string, unknown>;
}

interface LatencySummary {
  samples: number;
  errors: number;
  wall_ms: number;
  throughput_per_sec: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
}

interface Config {
  url: string;
  collection: string;
  size: number;
  queryCount: number;
  concurrency: number[];
  batchSize: number;
  seed: number;
  outputPath: string;
  overwrite: boolean;
  reuse: boolean;
  cleanup: boolean;
}

function rounded(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : value;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveIntegerList(
  raw: string | undefined,
  fallback: number[],
): number[] {
  const values = raw
    ? raw.split(",").map((part) => Number(part.trim()))
    : fallback;
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error("BENCH_CONCURRENCY must contain positive integers");
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function readConfig(): Config {
  const url = new URL(process.env.QDRANT_URL ?? "");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!loopback && process.env.QDRANT_ALLOW_REMOTE !== "1") {
    throw new Error(
      "QDRANT_URL must be loopback for this isolated benchmark; " +
        "set QDRANT_ALLOW_REMOTE=1 only for a dedicated benchmark endpoint",
    );
  }
  const collection = process.env.QDRANT_COLLECTION?.trim() ?? "";
  if (
    !/^agentmemory_eval_[A-Za-z0-9_-]+$/.test(collection) &&
    process.env.QDRANT_ALLOW_NON_BENCH_COLLECTION !== "1"
  ) {
    throw new Error(
      "QDRANT_COLLECTION must match agentmemory_eval_[A-Za-z0-9_-]+",
    );
  }
  const output = process.env.BENCH_OUT?.trim();
  if (!output) throw new Error("BENCH_OUT is required");
  const seed = Number(process.env.BENCH_SEED ?? DEFAULT_SEED);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("BENCH_SEED must be an unsigned 32-bit integer");
  }
  return {
    url: url.toString().replace(/\/$/, ""),
    collection,
    size: positiveInteger(process.env.BENCH_N, 10_000, "BENCH_N"),
    queryCount: positiveInteger(
      process.env.BENCH_QUERIES,
      DEFAULT_QUERY_COUNT,
      "BENCH_QUERIES",
    ),
    concurrency: positiveIntegerList(
      process.env.BENCH_CONCURRENCY,
      DEFAULT_CONCURRENCY,
    ),
    batchSize: positiveInteger(
      process.env.BENCH_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      "BENCH_BATCH_SIZE",
    ),
    seed,
    outputPath: resolve(output),
    overwrite: process.env.BENCH_OVERWRITE === "1",
    reuse: process.env.BENCH_REUSE === "1",
    cleanup: process.env.BENCH_CLEANUP === "1",
  };
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 120_000,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`,
    );
  }
  return (text ? JSON.parse(text) : null) as T;
}

async function collectionExists(
  baseUrl: string,
  collection: string,
): Promise<boolean> {
  const response = await fetch(`${baseUrl}/collections/${collection}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `GET collection -> ${response.status}: ${await response.text()}`,
    );
  }
  return true;
}

function qdrantFilter(
  canonicalRepoId?: string,
): Record<string, unknown> | undefined {
  return canonicalRepoId
    ? {
        must: [
          {
            key: "canonicalRepoId",
            match: { value: canonicalRepoId },
          },
        ],
      }
    : undefined;
}

class QdrantEvaluationStore implements VectorStore {
  private pending: QdrantPoint[] = [];
  private ids = new Map<string, number>();
  private nextId = 1;
  private pointCount = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly collection: string,
    private readonly batchSize: number,
  ) {}

  async create(): Promise<{ create_ms: number; payload_index_ms: number }> {
    if (await collectionExists(this.baseUrl, this.collection)) {
      throw new Error(
        `benchmark collection already exists: ${this.collection}`,
      );
    }
    const createStart = performance.now();
    await requestJson(this.baseUrl, `/collections/${this.collection}`, {
      method: "PUT",
      body: JSON.stringify({
        vectors: { size: VECTOR_DIMENSIONS, distance: "Cosine" },
      }),
    });
    const createMs = performance.now() - createStart;

    const indexStart = performance.now();
    for (const field of ["canonicalRepoId", "missionId", "agentId"]) {
      await requestJson(
        this.baseUrl,
        `/collections/${this.collection}/index?wait=true`,
        {
          method: "PUT",
          body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
        },
      );
    }
    return {
      create_ms: rounded(createMs),
      payload_index_ms: rounded(performance.now() - indexStart),
    };
  }

  async attach(): Promise<void> {
    const info = await this.info();
    this.pointCount = Number(info.points_count ?? 0);
    this.nextId = this.pointCount + 1;
  }

  async add(
    observationId: string,
    sessionId: string,
    embedding: Float32Array,
    metadata?: VectorMetadata,
  ): Promise<void> {
    if (embedding.length !== VECTOR_DIMENSIONS) {
      throw new Error(
        `Qdrant evaluation dimension mismatch: expected ${VECTOR_DIMENSIONS}, ` +
          `got ${embedding.length}`,
      );
    }
    const id = this.ids.get(observationId) ?? this.nextId++;
    this.ids.set(observationId, id);
    this.pending.push({
      id,
      vector: Array.from(embedding),
      payload: { obsId: observationId, sessionId, ...(metadata ?? {}) },
    });
    this.pointCount = Math.max(this.pointCount, this.ids.size);
    if (this.pending.length >= this.batchSize) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const points = this.pending;
    this.pending = [];
    try {
      await requestJson(
        this.baseUrl,
        `/collections/${this.collection}/points?wait=true`,
        { method: "PUT", body: JSON.stringify({ points }) },
        180_000,
      );
    } catch (error) {
      this.pending = points.concat(this.pending);
      throw error;
    }
  }

  async remove(observationId: string): Promise<void> {
    await this.flush();
    const id = this.ids.get(observationId);
    if (id === undefined) return;
    await requestJson(
      this.baseUrl,
      `/collections/${this.collection}/points/delete?wait=true`,
      { method: "POST", body: JSON.stringify({ points: [id] }) },
    );
    this.ids.delete(observationId);
    this.pointCount--;
  }

  async search(
    query: Float32Array,
    options: VectorSearchOptions = {},
  ): Promise<VectorSearchResult[]> {
    return this.searchFiltered(query, options.limit ?? 20);
  }

  async searchFiltered(
    query: Float32Array,
    limit: number,
    canonicalRepoId?: string,
  ): Promise<VectorSearchResult[]> {
    await this.flush();
    const response = await requestJson<{
      result: { points: QdrantQueryPoint[] };
    }>(this.baseUrl, `/collections/${this.collection}/points/query`, {
      method: "POST",
      body: JSON.stringify({
        query: Array.from(query),
        limit,
        with_payload: true,
        ...(canonicalRepoId ? { filter: qdrantFilter(canonicalRepoId) } : {}),
      }),
    });
    return response.result.points.map((point) => ({
      obsId: String(point.payload?.obsId ?? point.id),
      sessionId: String(point.payload?.sessionId ?? ""),
      score: point.score,
      ...(point.payload === undefined ? {} : { metadata: point.payload }),
    }));
  }

  get size(): number {
    return this.pointCount;
  }

  async clear(): Promise<void> {
    this.pending = [];
    this.ids.clear();
    this.pointCount = 0;
    if (await collectionExists(this.baseUrl, this.collection)) {
      await requestJson(this.baseUrl, `/collections/${this.collection}`, {
        method: "DELETE",
      });
    }
  }

  async info(): Promise<Record<string, unknown>> {
    const response = await requestJson<{ result: Record<string, unknown> }>(
      this.baseUrl,
      `/collections/${this.collection}`,
    );
    return response.result;
  }
}

function summarizeLatencies(
  samples: number[],
  errors: number,
  wallMs: number,
): LatencySummary {
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    samples: sorted.length,
    errors,
    wall_ms: rounded(wallMs),
    throughput_per_sec:
      wallMs > 0 ? rounded(sorted.length / (wallMs / 1_000)) : 0,
    min_ms: rounded(sorted[0] ?? Number.NaN),
    p50_ms: rounded(pXX(sorted, 50)),
    p95_ms: rounded(pXX(sorted, 95)),
    p99_ms: rounded(pXX(sorted, 99)),
    max_ms: rounded(sorted.at(-1) ?? Number.NaN),
  };
}

function topicForQuery(index: number): string {
  return `Topic${String(index % 64).padStart(2, "0")}`;
}

function repoForQuery(index: number): string {
  return `synthetic/repo-${String(index % 16).padStart(2, "0")}`;
}

async function measureLatency(
  store: QdrantEvaluationStore,
  queryCount: number,
  concurrency: number,
  seed: number,
  filtered: boolean,
): Promise<LatencySummary> {
  const samples: number[] = [];
  let errors = 0;
  let next = 0;
  const wallStart = performance.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= queryCount) return;
      const query = deterministicEmbedding(topicForQuery(index), "query", seed);
      const start = performance.now();
      try {
        await store.searchFiltered(
          query,
          CANDIDATE_LIMIT,
          filtered ? repoForQuery(index) : undefined,
        );
        samples.push(performance.now() - start);
      } catch {
        errors++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return summarizeLatencies(samples, errors, performance.now() - wallStart);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function measureExactRecall(
  store: QdrantEvaluationStore,
  records: ReturnType<typeof generatePerformanceRecords>,
  seed: number,
): Promise<{
  queries: number;
  recall_at_10: number;
  exact_match_queries: number;
  qdrant_rank_digest_sha256: string;
}> {
  const perTopic = new Map<string, typeof records>();
  for (const record of records) {
    const rows = perTopic.get(record.semanticKey) ?? [];
    rows.push(record);
    perTopic.set(record.semanticKey, rows);
  }
  const queryCount = 16;
  let overlap = 0;
  let exactMatches = 0;
  const ranks: string[] = [];
  for (let index = 0; index < queryCount; index++) {
    const topic = topicForQuery(index);
    const query = deterministicEmbedding(topic, "query", seed);
    const exact = (perTopic.get(topic) ?? [])
      .map((record) => ({
        id: record.observation.id,
        score: cosine(query, record.embedding!),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 10)
      .map((row) => row.id);
    const actual = (await store.searchFiltered(query, 10)).map(
      (row) => row.obsId,
    );
    const expected = new Set(exact);
    overlap += actual.filter((id) => expected.has(id)).length;
    if (actual.join(",") === exact.join(",")) exactMatches++;
    ranks.push(`${topic}:${actual.join(",")}`);
  }
  return {
    queries: queryCount,
    recall_at_10: rounded(overlap / (queryCount * 10)),
    exact_match_queries: exactMatches,
    qdrant_rank_digest_sha256: createHash("sha256")
      .update(ranks.join("\n"))
      .digest("hex"),
  };
}

async function measureDeterminism(
  store: QdrantEvaluationStore,
  seed: number,
): Promise<{ queries: number; identical_rankings: number }> {
  const queryCount = 20;
  let identical = 0;
  for (let index = 0; index < queryCount; index++) {
    const query = deterministicEmbedding(topicForQuery(index), "query", seed);
    const first = (await store.searchFiltered(query, 10)).map(
      (row) => row.obsId,
    );
    const second = (await store.searchFiltered(query, 10)).map(
      (row) => row.obsId,
    );
    if (first.join(",") === second.join(",")) identical++;
  }
  return { queries: queryCount, identical_rankings: identical };
}

async function waitReady(
  store: QdrantEvaluationStore,
  expectedPoints: number,
): Promise<{ wait_ms: number; info: Record<string, unknown> }> {
  const start = performance.now();
  while (performance.now() - start < DEFAULT_READY_TIMEOUT_MS) {
    const info = await store.info();
    const optimizer = info.optimizer_status;
    const optimizerOk = optimizer === "ok" || optimizer == null;
    if (
      info.status === "green" &&
      optimizerOk &&
      Number(info.points_count ?? 0) === expectedPoints
    ) {
      return { wait_ms: rounded(performance.now() - start), info };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Qdrant collection did not become ready within ${DEFAULT_READY_TIMEOUT_MS}ms`,
  );
}

async function qdrantMetrics(baseUrl: string): Promise<Record<string, number>> {
  const response = await fetch(`${baseUrl}/metrics`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GET /metrics -> ${response.status}`);
  const metrics: Record<string, number> = {};
  const wanted =
    /(?:memory|resident|virtual|cpu|open_fds|collections_total|vectors_total)/i;
  for (const line of (await response.text()).split("\n")) {
    if (!line || line.startsWith("#") || !wanted.test(line)) continue;
    const match = line.match(/^([^\s{]+)(?:\{[^}]*\})?\s+(-?[\d.eE+]+)$/);
    if (!match) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) metrics[match[1]] = value;
  }
  return metrics;
}

async function main(): Promise<void> {
  const config = readConfig();
  const startedAt = new Date().toISOString();
  const welcome = await requestJson<Record<string, unknown>>(config.url, "/");
  const store = new QdrantEvaluationStore(
    config.url,
    config.collection,
    config.batchSize,
  );

  let setup: Record<string, unknown> = { reuse: true };
  const generationStart = performance.now();
  const records = generatePerformanceRecords(config.size, config.seed);
  const generationMs = performance.now() - generationStart;

  if (config.reuse) {
    if (!(await collectionExists(config.url, config.collection))) {
      throw new Error(`reuse collection does not exist: ${config.collection}`);
    }
    await store.attach();
  } else {
    const created = await store.create();
    const populationStart = performance.now();
    for (const record of records) {
      await store.add(
        record.observation.id,
        record.observation.sessionId,
        record.embedding!,
        {
          canonicalRepoId: record.provenance.canonicalRepoId,
          project: record.provenance.project,
          missionId: record.provenance.missionId,
          agentId: record.provenance.agent,
          stale: record.provenance.stale,
        },
      );
    }
    await store.flush();
    const populationMs = performance.now() - populationStart;
    const ready = await waitReady(store, config.size);
    setup = {
      reuse: false,
      ...created,
      corpus_generation_ms: rounded(generationMs),
      upsert_applied_ms: rounded(populationMs),
      optimizer_ready_wait_ms: ready.wait_ms,
      population_to_ready_ms: rounded(populationMs + ready.wait_ms),
      collection_info: ready.info,
    };
  }

  const latency: Record<string, LatencySummary> = {};
  for (const concurrency of config.concurrency) {
    latency[`vector_c${concurrency}`] = await measureLatency(
      store,
      config.queryCount,
      concurrency,
      config.seed,
      false,
    );
  }
  latency.filtered_current_repo_c1 = await measureLatency(
    store,
    Math.min(config.queryCount, 250),
    1,
    config.seed,
    true,
  );

  const exactRecall = await measureExactRecall(store, records, config.seed);
  const determinism = await measureDeterminism(store, config.seed);

  let heldoutQuality: unknown = null;
  let qualityCollection: QdrantEvaluationStore | null = null;
  if (!config.reuse) {
    qualityCollection = new QdrantEvaluationStore(
      config.url,
      `${config.collection}_quality`,
      config.batchSize,
    );
    if (await collectionExists(config.url, `${config.collection}_quality`)) {
      await qualityCollection.clear();
    }
    await qualityCollection.create();
    heldoutQuality = await evaluateQualityFixture(
      heldoutFixture,
      config.seed ^ HELDOUT_SEED_SALT,
      qualityCollection,
    );
  }

  const report = {
    schema_version: 1,
    benchmark: "agentmemory-qdrant-vector-evaluation",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    qdrant: welcome,
    config: {
      endpoint: config.url,
      collection: config.collection,
      corpus_size: config.size,
      dimensions: VECTOR_DIMENSIONS,
      distance: "Cosine",
      batch_size: config.batchSize,
      query_candidate_limit: CANDIDATE_LIMIT,
      queries_per_latency_cell: config.queryCount,
      concurrency: config.concurrency,
      seed: config.seed,
      reuse_after_restart: config.reuse,
      payload_indexes: ["canonicalRepoId", "missionId", "agentId"],
    },
    setup,
    attached_point_count: store.size,
    latency,
    exact_recall: exactRecall,
    deterministic_ranking: determinism,
    heldout_quality: heldoutQuality,
    metrics: await qdrantMetrics(config.url),
  };

  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: config.overwrite ? "w" : "wx",
  });
  console.log(`[qdrant-evaluation] raw report: ${config.outputPath}`);

  if (qualityCollection) await qualityCollection.clear();
  if (config.cleanup) await store.clear();
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
