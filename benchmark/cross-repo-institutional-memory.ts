/**
 * Deterministic, isolated benchmark for cross-repository institutional memory.
 *
 * Safety properties:
 * - in-process only: no fetch, sockets, daemon, or external embedding service;
 * - requires an explicit BENCH_OUT path and refuses to overwrite by default;
 * - uses fixed PRNG seeds, timestamps, 384-dimensional precomputed vectors,
 *   hand-authored qrels, and deterministic id tie-breaks;
 * - BENCH_N and BENCH_QUERIES permit a small smoke run before the decision run.
 *
 * Decision run:
 *   BENCH_OUT=/tmp/agentmemory-institutional-memory.json \
 *   npm run bench:institutional-memory
 *
 * Smoke run:
 *   BENCH_N=1000 BENCH_QUERIES=12 BENCH_CONCURRENCY=1,4 \
 *   BENCH_OUT=/tmp/agentmemory-institutional-memory-smoke.json \
 *   npm run bench:institutional-memory
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { KV } from "../src/state/schema.js";
import { applyRetrievalPolicy } from "../src/state/retrieval-policy.js";
import type {
  CompressedObservation,
  GraphEdge,
  GraphNode,
  RetrievalProvenance,
} from "../src/types.js";
import type { VectorSearchResult } from "../src/state/vector-store.js";
import { pXX } from "./lib/percentiles.js";
import {
  calibrationFixture,
  heldoutFixture,
  type QualityCategory,
  type QualityDocumentFixture,
  type QualityFixture,
  type QualityQueryFixture,
} from "./cross-repo-quality-fixtures.js";

export const VECTOR_DIMENSIONS = 384;
export const DEFAULT_CORPUS_SIZES = [10_000, 50_000, 100_000, 250_000];
export const DEFAULT_QUERY_COUNT = 1_000;
export const DEFAULT_CONCURRENCY = [1, 4, 8, 16];
export const DEFAULT_SEED = 0x5eedc0de;
export const HELDOUT_SEED_SALT = 0x51ed270b;

const FIXED_EPOCH_MS = Date.parse("2025-01-01T00:00:00.000Z");
const RRF_K = 60;
const RESULT_LIMIT = 10;
const CANDIDATE_LIMIT = 100;
const QUALITY_CANDIDATE_LIMIT = 5;
const PERFORMANCE_REPO_COUNT = 16;
const PERFORMANCE_TOPIC_COUNT = 64;

type SearchMode = "bm25" | "vector" | "dual" | "triple";

export interface BenchmarkProvenance {
  project: string;
  canonicalRepoId: string;
  sessionId: string;
  agent: string;
  missionId: string;
  worktree: string;
  branch: string;
  commitSha: string;
  files: string[];
  timestamp: string;
  observationId: string;
  memoryType: string;
  confidence: number;
  importance: number;
  global: boolean;
  stale: boolean;
  supersededBy?: string;
  supersedes: string[];
}

interface PerformanceRecord {
  observation: CompressedObservation;
  provenance: BenchmarkProvenance;
  embedding: Float32Array | null;
  semanticKey: string;
}

interface SearchContext {
  currentRepo: string;
  missionId: string;
  relatedRepos: string[];
}

interface BenchmarkQuery extends SearchContext {
  id: string;
  text: string;
  embedding: Float32Array;
  entities: string[];
}

interface RankedResult {
  obsId: string;
  sessionId: string;
  score: number;
  provenance: BenchmarkProvenance;
}

interface ChannelResult {
  obsId: string;
  sessionId: string;
  score: number;
}

interface SearchRuntime {
  bm25: SearchIndex;
  vector: VectorIndex;
  graph: GraphRetrieval;
  provenance: Map<string, BenchmarkProvenance>;
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

interface MemorySnapshot {
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  process_max_rss_bytes: number;
}

interface QualityMetrics {
  queries: number;
  ndcg_at_5: number;
  ndcg_at_10: number;
  mrr: number;
  recall_at_5: number;
  recall_at_10: number;
  exact_symbol_top_1: number | null;
  current_repo_top_1: number | null;
  related_repo_recall_at_5: number | null;
  unrelated_intrusion_at_5: number;
  stale_intrusion_at_5: number;
  provenance_completeness: number;
  rank_digest_sha256: string;
  per_query: Array<{
    query_id: string;
    category: QualityCategory;
    top_ids: string[];
    qrels: Record<string, number>;
    ndcg_at_5: number;
    ndcg_at_10: number;
    reciprocal_rank: number;
    recall_at_5: number;
    recall_at_10: number;
  }>;
}

interface QualityReport {
  name: string;
  fixture_digest_sha256: string;
  documents: number;
  queries: number;
  modes: Record<SearchMode, QualityMetrics>;
}

interface BenchmarkConfig {
  sizes: number[];
  queryCount: number;
  concurrency: number[];
  seed: number;
  outputPath: string;
  overwrite: boolean;
}

export interface SerializationAttempt {
  value: string | null;
  elapsedMs: number;
  error: string | null;
}

export interface RestoreAttempt<T> {
  value: T | null;
  elapsedMs: number | null;
  error: string | null;
}

type MonotonicClock = () => number;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bounded seam for benchmark persistence failure reporting. The operation and
 * clock are injected so unit tests do not need a large corpus or wall time.
 * Serialization duration is reported even on failure, matching the benchmark
 * receipt contract.
 */
export function attemptSerialization(
  serialize: () => string,
  now: MonotonicClock = () => performance.now(),
): SerializationAttempt {
  const start = now();
  let value: string | null = null;
  let error: string | null = null;
  try {
    value = serialize();
  } catch (cause) {
    error = errorMessage(cause);
  }
  return { value, elapsedMs: now() - start, error };
}

/**
 * Restore is skipped when serialization produced no payload. Failed restore
 * duration remains null, matching the receipt's "successful restore time"
 * semantics.
 */
export function attemptRestore<T>(
  serialized: string | null,
  restore: (payload: string) => T,
  now: MonotonicClock = () => performance.now(),
): RestoreAttempt<T> {
  if (serialized === null) {
    return { value: null, elapsedMs: null, error: null };
  }

  const start = now();
  try {
    const value = restore(serialized);
    return { value, elapsedMs: now() - start, error: null };
  } catch (cause) {
    return { value: null, elapsedMs: null, error: errorMessage(cause) };
  }
}

class InMemoryKV {
  private readonly scopes = new Map<string, Map<string, unknown>>();

  put<T>(scope: string, key: string, value: T): void {
    let entries = this.scopes.get(scope);
    if (!entries) {
      entries = new Map();
      this.scopes.set(scope, entries);
    }
    entries.set(key, value);
  }

  async get<T>(scope: string, key: string): Promise<T | null> {
    return (this.scopes.get(scope)?.get(key) as T | undefined) ?? null;
  }

  async set<T>(scope: string, key: string, value: T): Promise<T> {
    this.put(scope, key, value);
    return value;
  }

  async delete(scope: string, key: string): Promise<void> {
    this.scopes.get(scope)?.delete(key);
  }

  async list<T>(scope: string): Promise<T[]> {
    return Array.from(this.scopes.get(scope)?.values() ?? []) as T[];
  }
}

function fnv1a(text: string, seed = DEFAULT_SEED): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const prototypeCache = new Map<string, Float32Array>();

function semanticPrototype(key: string, seed = DEFAULT_SEED): Float32Array {
  const cacheKey = `${seed}:${key}`;
  const cached = prototypeCache.get(cacheKey);
  if (cached) return cached;

  const rng = mulberry32(fnv1a(key, seed));
  const vector = new Float32Array(VECTOR_DIMENSIONS);
  let squaredNorm = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = rng() * 2 - 1;
    vector[i] = value;
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  prototypeCache.set(cacheKey, vector);
  return vector;
}

/** Deterministic unit vector clustered around a semantic prototype. */
export function deterministicEmbedding(
  semanticKey: string,
  variant: string,
  seed = DEFAULT_SEED,
): Float32Array {
  const prototype = semanticPrototype(semanticKey, seed);
  if (variant === "query") return new Float32Array(prototype);

  const rng = mulberry32(fnv1a(`${semanticKey}:${variant}`, seed ^ 0x9e3779b9));
  const vector = new Float32Array(VECTOR_DIMENSIONS);
  let squaredNorm = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = prototype[i] * 0.97 + (rng() * 2 - 1) * 0.03;
    vector[i] = value;
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

function oppositeEmbedding(semanticKey: string, seed: number): Float32Array {
  const vector = deterministicEmbedding(semanticKey, "query", seed);
  for (let i = 0; i < vector.length; i++) vector[i] *= -1;
  return vector;
}

function fixedTimestamp(index: number): string {
  const offsetMinutes = index % (365 * 24 * 60);
  return new Date(FIXED_EPOCH_MS - offsetMinutes * 60_000).toISOString();
}

function deterministicSha(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function performanceRepo(index: number): string {
  return `synthetic/repo-${String(index).padStart(2, "0")}`;
}

function performanceTopic(index: number): string {
  return `Topic${String(index).padStart(2, "0")}`;
}

export function generatePerformanceRecords(
  count: number,
  seed = DEFAULT_SEED,
): PerformanceRecord[] {
  const records = new Array<PerformanceRecord>(count);
  for (let i = 0; i < count; i++) {
    const id = `perf_obs_${String(i).padStart(7, "0")}`;
    // Keep repository and topic axes independent: every sufficiently large
    // corpus contains the same topic in current, related, and unrelated repos.
    const repoIndex = Math.floor(i / PERFORMANCE_TOPIC_COUNT) % PERFORMANCE_REPO_COUNT;
    const topicIndex = i % PERFORMANCE_TOPIC_COUNT;
    const repo = performanceRepo(repoIndex);
    const topic = performanceTopic(topicIndex);
    const sessionId = `perf_session_${String(Math.floor(i / 8)).padStart(7, "0")}`;
    const timestamp = fixedTimestamp(i);
    const stale = i > 0 && i % 997 === 0;
    const observation: CompressedObservation = {
      id,
      sessionId,
      timestamp,
      type: i % 5 === 0 ? "decision" : "discovery",
      title: `${topic} institutional decision ${i}`,
      subtitle: `Repository ${repo}`,
      facts: [
        `${topic} contract variant ${i % 23}`,
        `Repository ownership group ${repoIndex}`,
      ],
      narrative:
        `Agent ${i % 4} recorded why ${topic} uses deterministic boundary ` +
        `${i % 31} in ${repo}; this is synthetic institutional memory, not source code.`,
      concepts: [topic, "institutional-memory", `boundary-${i % 31}`],
      files: [`src/topic-${topicIndex}/decision-${i % 17}.ts`],
      importance: 5 + (i % 6),
      confidence: 0.7 + (i % 4) * 0.075,
      agentId: ["codex", "kimi", "pi", "claude"][i % 4],
    };
    const provenance: BenchmarkProvenance = {
      project: `repo-${String(repoIndex).padStart(2, "0")}`,
      canonicalRepoId: repo,
      sessionId,
      agent: observation.agentId ?? "unknown",
      missionId: `mission-${String(i % 8).padStart(2, "0")}`,
      worktree: `/synthetic/worktrees/repo-${repoIndex}/task-${i % 7}`,
      branch: `agent/topic-${topicIndex}-${i % 7}`,
      commitSha: deterministicSha(id),
      files: observation.files,
      timestamp,
      observationId: id,
      memoryType: observation.type,
      confidence: observation.confidence ?? 0,
      importance: observation.importance,
      global: repoIndex === PERFORMANCE_REPO_COUNT - 1 && i % 11 === 0,
      stale,
      ...(stale ? { supersededBy: `perf_obs_${String(i - 1).padStart(7, "0")}` } : {}),
      supersedes: [],
    };
    records[i] = {
      observation,
      provenance,
      embedding: deterministicEmbedding(topic, id, seed),
      semanticKey: topic,
    };
  }
  return records;
}

function qualityObservation(doc: QualityDocumentFixture): CompressedObservation {
  return {
    id: doc.id,
    sessionId: doc.sessionId,
    timestamp: doc.timestamp,
    type: doc.memoryType === "bug" ? "error" : doc.memoryType === "fact" ? "discovery" : "decision",
    title: doc.title,
    narrative: doc.narrative,
    facts: doc.facts,
    concepts: doc.concepts,
    files: doc.files,
    importance: doc.importance,
    confidence: doc.confidence,
    agentId: doc.agent,
  };
}

function qualityProvenance(doc: QualityDocumentFixture): BenchmarkProvenance {
  return {
    project: doc.project,
    canonicalRepoId: doc.canonicalRepoId,
    sessionId: doc.sessionId,
    agent: doc.agent,
    missionId: doc.missionId,
    worktree: doc.worktree,
    branch: doc.branch,
    commitSha: doc.commitSha,
    files: doc.files,
    timestamp: doc.timestamp,
    observationId: doc.id,
    memoryType: doc.memoryType,
    confidence: doc.confidence,
    importance: doc.importance,
    global: doc.global ?? false,
    stale: doc.stale ?? false,
    ...(doc.supersededBy === undefined ? {} : { supersededBy: doc.supersededBy }),
    supersedes: doc.supersedes ?? [],
  };
}

function maybeGc(): void {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
}

function memorySnapshot(): MemorySnapshot {
  maybeGc();
  const memory = process.memoryUsage();
  return {
    rss_bytes: memory.rss,
    heap_used_bytes: memory.heapUsed,
    heap_total_bytes: memory.heapTotal,
    external_bytes: memory.external,
    array_buffers_bytes: memory.arrayBuffers,
    process_max_rss_bytes: process.resourceUsage().maxRSS * 1024,
  };
}

function rounded(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : value;
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
    throughput_per_sec: wallMs > 0 ? rounded(sorted.length / (wallMs / 1_000)) : 0,
    min_ms: rounded(sorted[0] ?? Number.NaN),
    p50_ms: rounded(pXX(sorted, 50)),
    p95_ms: rounded(pXX(sorted, 95)),
    p99_ms: rounded(pXX(sorted, 99)),
    max_ms: rounded(sorted.at(-1) ?? Number.NaN),
  };
}

async function vectorSearch(
  vector: VectorIndex,
  query: Float32Array,
  limit: number,
): Promise<VectorSearchResult[]> {
  return await vector.search(query, { limit });
}

function retrievalProvenance(provenance: BenchmarkProvenance): RetrievalProvenance {
  return {
    project: provenance.global ? "global" : provenance.project,
    canonicalRepoId: provenance.canonicalRepoId,
    worktree: provenance.worktree,
    branch: provenance.branch,
    commitSha: provenance.commitSha,
    sessionId: provenance.sessionId,
    missionId: provenance.missionId,
    agentId: provenance.agent,
    files: provenance.files,
    timestamp: provenance.timestamp,
    observationId: provenance.observationId,
    memoryType: provenance.memoryType as RetrievalProvenance["memoryType"],
    confidence: provenance.confidence,
    importance: provenance.importance,
    isLatest: !provenance.stale && !provenance.supersededBy,
    supersedes: provenance.supersedes,
    attributed: true,
  };
}

function fuseChannels(
  channels: Array<{ weight: number; results: ChannelResult[] }>,
  provenance: Map<string, BenchmarkProvenance>,
  context: SearchContext,
  limit: number,
): RankedResult[] {
  const totalWeight = channels.reduce((sum, channel) => sum + channel.weight, 0) || 1;
  const fused = new Map<string, { score: number; sessionId: string }>();
  for (const channel of channels) {
    const normalizedWeight = channel.weight / totalWeight;
    channel.results.forEach((result, index) => {
      const existing = fused.get(result.obsId) ?? { score: 0, sessionId: result.sessionId };
      existing.score += normalizedWeight / (RRF_K + index + 1);
      if (!existing.sessionId) existing.sessionId = result.sessionId;
      fused.set(result.obsId, existing);
    });
  }

  const candidates = [];
  for (const [obsId, result] of fused) {
    const metadata = provenance.get(obsId);
    if (!metadata) continue;
    candidates.push({
      id: obsId,
      baseScore: result.score,
      value: { sessionId: metadata.sessionId || result.sessionId, metadata },
      provenance: retrievalProvenance(metadata),
    });
  }

  return applyRetrievalPolicy(candidates, {
    currentRepoId: context.currentRepo,
    currentMissionId: context.missionId,
    relatedRepoIds: context.relatedRepos,
    includeRelatedProjects: true,
    includeGlobal: true,
    includeCrossRepo: true,
  })
    .map((candidate): RankedResult => ({
      obsId: candidate.id,
      sessionId: candidate.value.sessionId,
      score: candidate.adjustedScore,
      provenance: candidate.value.metadata,
    }))
    .slice(0, limit);
}

async function searchRuntime(
  runtime: SearchRuntime,
  query: BenchmarkQuery,
  mode: SearchMode,
  limit = RESULT_LIMIT,
  candidateLimit = CANDIDATE_LIMIT,
): Promise<RankedResult[]> {
  const bm25Results =
    mode === "vector" ? [] : runtime.bm25.search(query.text, candidateLimit);
  const vectorResults =
    mode === "bm25"
      ? []
      : await vectorSearch(runtime.vector, query.embedding, candidateLimit);
  const graphResults =
    mode === "triple" && query.entities.length > 0
      ? await runtime.graph.searchByEntities(query.entities, 2, candidateLimit)
      : [];

  const channels: Array<{ weight: number; results: ChannelResult[] }> = [];
  if (mode !== "vector") channels.push({ weight: mode === "bm25" ? 1 : 0.4, results: bm25Results });
  if (mode !== "bm25") channels.push({ weight: mode === "vector" ? 1 : 0.6, results: vectorResults });
  if (mode === "triple") channels.push({ weight: 0.3, results: graphResults });
  return fuseChannels(channels, runtime.provenance, query, limit);
}

function addPerformanceGraph(
  records: PerformanceRecord[],
  kv: InMemoryKV,
): { nodes: number; edges: number } {
  const createdAt = new Date(FIXED_EPOCH_MS).toISOString();
  for (let topic = 0; topic < PERFORMANCE_TOPIC_COUNT; topic++) {
    const node: GraphNode = {
      id: `perf_topic_node_${topic}`,
      type: "concept",
      name: performanceTopic(topic),
      properties: {},
      sourceObservationIds: [],
      createdAt,
    };
    kv.put(KV.graphNodes, node.id, node);
  }

  const auxiliaryCount = Math.max(PERFORMANCE_TOPIC_COUNT, Math.ceil(records.length / 250));
  for (let i = 0; i < auxiliaryCount; i++) {
    const record = records[(i * 251) % records.length];
    const topic = (i * 251) % PERFORMANCE_TOPIC_COUNT;
    const node: GraphNode = {
      id: `perf_aux_node_${i}`,
      type: "pattern",
      name: `Pattern${String(i).padStart(5, "0")}`,
      properties: {},
      sourceObservationIds: [record.observation.id],
      createdAt,
    };
    const edge: GraphEdge = {
      id: `perf_edge_${i}`,
      type: "related_to",
      sourceNodeId: `perf_topic_node_${topic}`,
      targetNodeId: node.id,
      weight: 0.7 + (i % 4) * 0.075,
      sourceObservationIds: [record.observation.id],
      createdAt,
      tcommit: createdAt,
      version: 1,
      isLatest: true,
    };
    kv.put(KV.graphNodes, node.id, node);
    kv.put(KV.graphEdges, edge.id, edge);
  }
  return { nodes: PERFORMANCE_TOPIC_COUNT + auxiliaryCount, edges: auxiliaryCount };
}

function performanceQueries(count: number, seed: number): BenchmarkQuery[] {
  const rng = mulberry32(seed ^ 0xa5a5a5a5);
  const queries = new Array<BenchmarkQuery>(count);
  for (let i = 0; i < count; i++) {
    const topicIndex = Math.floor(rng() * PERFORMANCE_TOPIC_COUNT);
    const repoIndex = Math.floor(rng() * PERFORMANCE_REPO_COUNT);
    const topic = performanceTopic(topicIndex);
    queries[i] = {
      id: `perf_query_${String(i).padStart(5, "0")}`,
      text: `${topic} institutional architecture decision boundary`,
      embedding: deterministicEmbedding(topic, "query", seed),
      entities: [topic],
      currentRepo: performanceRepo(repoIndex),
      missionId: `mission-${String(i % 8).padStart(2, "0")}`,
      relatedRepos: [performanceRepo((repoIndex + 1) % PERFORMANCE_REPO_COUNT)],
    };
  }
  return queries;
}

async function measureSequential(
  runtime: SearchRuntime,
  queries: BenchmarkQuery[],
  mode: SearchMode,
): Promise<LatencySummary> {
  const warmups = Math.min(100, Math.max(5, Math.ceil(queries.length / 10)));
  for (let i = 0; i < warmups; i++) {
    await searchRuntime(runtime, queries[i % queries.length], mode);
  }

  const latencies: number[] = [];
  let errors = 0;
  const wallStart = performance.now();
  for (const query of queries) {
    const start = performance.now();
    try {
      await searchRuntime(runtime, query, mode);
      latencies.push(performance.now() - start);
    } catch {
      errors++;
    }
  }
  return summarizeLatencies(latencies, errors, performance.now() - wallStart);
}

/**
 * Burst C searches at once. Each latency begins before setImmediate enqueue,
 * so synchronous exact-cosine work includes event-loop queue delay.
 */
async function measureConcurrentHybrid(
  runtime: SearchRuntime,
  queries: BenchmarkQuery[],
  concurrency: number,
): Promise<LatencySummary> {
  const latencies: number[] = [];
  let errors = 0;
  const wallStart = performance.now();
  for (let offset = 0; offset < queries.length; offset += concurrency) {
    const batch = queries.slice(offset, offset + concurrency);
    const pending = batch.map(
      (query) =>
        new Promise<void>((resolvePromise) => {
          const enqueuedAt = performance.now();
          setImmediate(() => {
            searchRuntime(runtime, query, "triple")
              .then(() => latencies.push(performance.now() - enqueuedAt))
              .catch(() => {
                errors++;
              })
              .finally(resolvePromise);
          });
        }),
    );
    await Promise.all(pending);
  }
  return summarizeLatencies(latencies, errors, performance.now() - wallStart);
}

async function benchmarkScale(size: number, config: BenchmarkConfig) {
  maybeGc();
  const memoryBefore = memorySnapshot();
  const totalStart = performance.now();

  const generationStart = performance.now();
  const records = generatePerformanceRecords(size, config.seed);
  const generationMs = performance.now() - generationStart;

  let bm25 = new SearchIndex();
  const bm25Start = performance.now();
  for (const record of records) bm25.add(record.observation);
  const bm25PopulationMs = performance.now() - bm25Start;

  let vector = new VectorIndex();
  const vectorStart = performance.now();
  for (const record of records) {
    const embedding = record.embedding;
    if (!embedding) throw new Error(`missing precomputed embedding for ${record.observation.id}`);
    const result = vector.add(record.observation.id, record.observation.sessionId, embedding, {
      canonicalRepoId: record.provenance.canonicalRepoId,
    }) as unknown as Promise<void> | undefined;
    if (result && typeof result.then === "function") await result;
    record.embedding = null;
  }
  const vectorPopulationMs = performance.now() - vectorStart;

  const kv = new InMemoryKV();
  const provenance = new Map<string, BenchmarkProvenance>();
  const kvStart = performance.now();
  for (const record of records) {
    kv.put(KV.observations(record.observation.sessionId), record.observation.id, record.observation);
    provenance.set(record.observation.id, record.provenance);
  }
  const kvPopulationMs = performance.now() - kvStart;
  const graphStart = performance.now();
  const graphSize = addPerformanceGraph(records, kv);
  const graphPopulationMs = performance.now() - graphStart;
  const populationTotalMs = performance.now() - totalStart;
  const memoryAfterPopulation = memorySnapshot();

  const bm25Serialization = attemptSerialization(() => bm25.serialize());
  const vectorSerialization = attemptSerialization(() => vector.serialize());
  const bm25Serialized = bm25Serialization.value;
  const vectorSerialized = vectorSerialization.value;
  const memoryAfterSerialize = memorySnapshot();

  maybeGc();

  const bm25Restoration = attemptRestore(bm25Serialized, (payload) => {
    const restored = SearchIndex.deserialize(payload);
    bm25.clear();
    bm25 = restored;
    return restored;
  });
  const vectorRestoration = attemptRestore(vectorSerialized, (payload) => {
    const restored = VectorIndex.deserialize(payload);
    vector.clear();
    vector = restored;
    return restored;
  });
  maybeGc();
  const memoryAfterRestore = memorySnapshot();

  const runtime: SearchRuntime = {
    bm25,
    vector,
    graph: new GraphRetrieval(kv as never),
    provenance,
  };
  const queries = performanceQueries(config.queryCount, config.seed ^ size);
  const latency = {} as Record<SearchMode, LatencySummary>;
  for (const mode of ["bm25", "vector", "dual", "triple"] as const) {
    latency[mode] = await measureSequential(runtime, queries, mode);
  }

  const concurrency: Record<string, LatencySummary> = {};
  for (const value of config.concurrency) {
    concurrency[String(value)] =
      value === 1
        ? latency.triple
        : await measureConcurrentHybrid(runtime, queries, value);
  }

  return {
    corpus_size: size,
    dimensions: VECTOR_DIMENSIONS,
    graph: graphSize,
    population_ms: {
      generation: rounded(generationMs),
      bm25_add: rounded(bm25PopulationMs),
      vector_add_precomputed: rounded(vectorPopulationMs),
      kv_add: rounded(kvPopulationMs),
      graph_add: rounded(graphPopulationMs),
      total: rounded(populationTotalMs),
    },
    persistence: {
      bm25_bytes:
        bm25Serialized === null ? null : Buffer.byteLength(bm25Serialized),
      vector_bytes:
        vectorSerialized === null ? null : Buffer.byteLength(vectorSerialized),
      total_bytes:
        bm25Serialized === null || vectorSerialized === null
          ? null
          : Buffer.byteLength(bm25Serialized) + Buffer.byteLength(vectorSerialized),
      bm25_serialize_ms: rounded(bm25Serialization.elapsedMs),
      vector_serialize_ms: rounded(vectorSerialization.elapsedMs),
      ...(bm25Serialization.error
        ? { bm25_serialize_error: bm25Serialization.error }
        : {}),
      ...(vectorSerialization.error
        ? { vector_serialize_error: vectorSerialization.error }
        : {}),
      bm25_restore_ms:
        bm25Restoration.elapsedMs === null
          ? null
          : rounded(bm25Restoration.elapsedMs),
      vector_restore_ms:
        vectorRestoration.elapsedMs === null
          ? null
          : rounded(vectorRestoration.elapsedMs),
      total_restore_ms:
        bm25Restoration.elapsedMs === null ||
        vectorRestoration.elapsedMs === null
          ? null
          : rounded(
              bm25Restoration.elapsedMs + vectorRestoration.elapsedMs,
            ),
      ...(bm25Restoration.error
        ? { bm25_restore_error: bm25Restoration.error }
        : {}),
      ...(vectorRestoration.error
        ? { vector_restore_error: vectorRestoration.error }
        : {}),
      restored_bm25_size: bm25.size,
      restored_vector_size: vector.size,
    },
    memory: {
      before: memoryBefore,
      after_population: memoryAfterPopulation,
      after_serialize: memoryAfterSerialize,
      after_restore: memoryAfterRestore,
    },
    latency_ms: latency,
    concurrent_triple_search: concurrency,
  };
}

function addQualityGraph(fixture: QualityFixture, kv: InMemoryKV): void {
  const createdAt = "2025-01-01T00:00:00.000Z";
  for (const source of fixture.graphNodes) {
    const node: GraphNode = {
      id: source.id,
      name: source.name,
      type: source.type,
      properties: {},
      sourceObservationIds: source.observationIds,
      createdAt,
    };
    kv.put(KV.graphNodes, node.id, node);
  }
  for (const source of fixture.graphEdges) {
    const edge: GraphEdge = {
      id: source.id,
      type: source.type,
      sourceNodeId: source.sourceNodeId,
      targetNodeId: source.targetNodeId,
      weight: source.weight,
      sourceObservationIds: [],
      createdAt,
      tcommit: createdAt,
      version: 1,
      isLatest: true,
    };
    kv.put(KV.graphEdges, edge.id, edge);
  }
}

function fixtureDigest(fixture: QualityFixture): string {
  return createHash("sha256").update(JSON.stringify(fixture)).digest("hex");
}

async function buildQualityRuntime(
  fixture: QualityFixture,
  seed: number,
): Promise<SearchRuntime> {
  const bm25 = new SearchIndex();
  const vector = new VectorIndex();
  const kv = new InMemoryKV();
  const provenance = new Map<string, BenchmarkProvenance>();
  for (const document of fixture.documents) {
    const observation = qualityObservation(document);
    bm25.add(observation);
    await vector.add(
      observation.id,
      observation.sessionId,
      document.antiSemanticKey
        ? oppositeEmbedding(document.antiSemanticKey, seed)
        : deterministicEmbedding(document.semanticKey, document.id, seed),
      { canonicalRepoId: document.canonicalRepoId },
    );
    kv.put(KV.observations(observation.sessionId), observation.id, observation);
    provenance.set(observation.id, qualityProvenance(document));
  }
  addQualityGraph(fixture, kv);
  return { bm25, vector, graph: new GraphRetrieval(kv as never), provenance };
}

function qualityQuery(query: QualityQueryFixture, seed: number): BenchmarkQuery {
  return {
    id: query.id,
    text: query.query,
    embedding: deterministicEmbedding(query.semanticKey, "query", seed),
    entities: query.entities,
    currentRepo: query.currentRepo,
    missionId: query.missionId,
    relatedRepos: query.relatedRepos,
  };
}

function dcg(ids: string[], qrels: Record<string, number>, k: number): number {
  let total = 0;
  ids.slice(0, k).forEach((id, index) => {
    const relevance = qrels[id] ?? 0;
    total += (2 ** relevance - 1) / Math.log2(index + 2);
  });
  return total;
}

function ndcg(ids: string[], qrels: Record<string, number>, k: number): number {
  const ideal = Object.values(qrels)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, relevance, index) => sum + (2 ** relevance - 1) / Math.log2(index + 2), 0);
  return ideal === 0 ? 0 : dcg(ids, qrels, k) / ideal;
}

function recall(ids: string[], qrels: Record<string, number>, k: number): number {
  const relevant = new Set(Object.entries(qrels).filter(([, grade]) => grade > 0).map(([id]) => id));
  if (relevant.size === 0) return 0;
  const hits = ids.slice(0, k).filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

function reciprocalRank(ids: string[], qrels: Record<string, number>): number {
  const rank = ids.findIndex((id) => (qrels[id] ?? 0) > 0);
  return rank < 0 ? 0 : 1 / (rank + 1);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function provenanceComplete(provenance: BenchmarkProvenance): boolean {
  return Boolean(
    provenance.project &&
      provenance.canonicalRepoId &&
      provenance.sessionId &&
      provenance.agent &&
      provenance.missionId &&
      provenance.worktree &&
      provenance.branch &&
      /^[a-f0-9]{40}$/i.test(provenance.commitSha) &&
      provenance.files.length > 0 &&
      provenance.timestamp &&
      provenance.observationId &&
      provenance.memoryType &&
      Number.isFinite(provenance.confidence) &&
      Number.isFinite(provenance.importance),
  );
}

async function evaluateQualityMode(
  fixture: QualityFixture,
  runtime: SearchRuntime,
  mode: SearchMode,
  seed: number,
): Promise<QualityMetrics> {
  const rows: QualityMetrics["per_query"] = [];
  const topResults = new Map<string, RankedResult[]>();
  for (const query of fixture.queries) {
    const ranked = await searchRuntime(
      runtime,
      qualityQuery(query, seed),
      mode,
      10,
      QUALITY_CANDIDATE_LIMIT,
    );
    topResults.set(query.id, ranked);
    const ids = ranked.map((result) => result.obsId);
    rows.push({
      query_id: query.id,
      category: query.category,
      top_ids: ids,
      qrels: query.qrels,
      ndcg_at_5: rounded(ndcg(ids, query.qrels, 5)),
      ndcg_at_10: rounded(ndcg(ids, query.qrels, 10)),
      reciprocal_rank: rounded(reciprocalRank(ids, query.qrels)),
      recall_at_5: rounded(recall(ids, query.qrels, 5)),
      recall_at_10: rounded(recall(ids, query.qrels, 10)),
    });
  }

  const exactRows = rows.filter((row) => row.category === "exact_symbol");
  const localRows = rows.filter((row) => row.category === "current_repo_preference");
  const relatedRecall: number[] = [];
  let unrelatedIntrusions = 0;
  let topFiveCount = 0;
  let staleIntrusions = 0;
  let completeProvenance = 0;
  let provenanceCount = 0;

  for (const query of fixture.queries) {
    const ranked = topResults.get(query.id) ?? [];
    const topFive = ranked.slice(0, 5);
    const relatedGold = Object.entries(query.qrels)
      .filter(([, grade]) => grade > 0)
      .map(([id]) => runtime.provenance.get(id))
      .filter(
        (value): value is BenchmarkProvenance =>
          Boolean(value && query.relatedRepos.includes(value.canonicalRepoId)),
      );
    if (relatedGold.length > 0) {
      const relatedGoldIds = new Set(relatedGold.map((value) => value.observationId));
      relatedRecall.push(topFive.filter((value) => relatedGoldIds.has(value.obsId)).length / relatedGoldIds.size);
    }
    for (const result of topFive) {
      topFiveCount++;
      provenanceCount++;
      if (provenanceComplete(result.provenance)) completeProvenance++;
      if (result.provenance.stale || result.provenance.supersededBy) staleIntrusions++;
      const repoRelevant =
        result.provenance.canonicalRepoId === query.currentRepo ||
        query.relatedRepos.includes(result.provenance.canonicalRepoId) ||
        result.provenance.global;
      if (!repoRelevant && (query.qrels[result.obsId] ?? 0) === 0) unrelatedIntrusions++;
    }
  }

  const rankDigest = createHash("sha256")
    .update(rows.map((row) => `${row.query_id}:${row.top_ids.join(",")}`).join("\n"))
    .digest("hex");
  const topOneRelevant = (row: QualityMetrics["per_query"][number]) =>
    row.top_ids.length > 0 && (row.qrels[row.top_ids[0]] ?? 0) > 0 ? 1 : 0;
  return {
    queries: rows.length,
    ndcg_at_5: rounded(mean(rows.map((row) => row.ndcg_at_5))),
    ndcg_at_10: rounded(mean(rows.map((row) => row.ndcg_at_10))),
    mrr: rounded(mean(rows.map((row) => row.reciprocal_rank))),
    recall_at_5: rounded(mean(rows.map((row) => row.recall_at_5))),
    recall_at_10: rounded(mean(rows.map((row) => row.recall_at_10))),
    exact_symbol_top_1: exactRows.length === 0 ? null : rounded(mean(exactRows.map(topOneRelevant))),
    current_repo_top_1: localRows.length === 0 ? null : rounded(mean(localRows.map(topOneRelevant))),
    related_repo_recall_at_5: relatedRecall.length === 0 ? null : rounded(mean(relatedRecall)),
    unrelated_intrusion_at_5: topFiveCount === 0 ? 0 : rounded(unrelatedIntrusions / topFiveCount),
    stale_intrusion_at_5: topFiveCount === 0 ? 0 : rounded(staleIntrusions / topFiveCount),
    provenance_completeness: provenanceCount === 0 ? 0 : rounded(completeProvenance / provenanceCount),
    rank_digest_sha256: rankDigest,
    per_query: rows,
  };
}

export async function evaluateQualityFixture(
  fixture: QualityFixture,
  seed = DEFAULT_SEED,
): Promise<QualityReport> {
  const runtime = await buildQualityRuntime(fixture, seed);
  const modes = {} as Record<SearchMode, QualityMetrics>;
  for (const mode of ["bm25", "vector", "dual", "triple"] as const) {
    modes[mode] = await evaluateQualityMode(fixture, runtime, mode, seed);
  }
  return {
    name: fixture.name,
    fixture_digest_sha256: fixtureDigest(fixture),
    documents: fixture.documents.length,
    queries: fixture.queries.length,
    modes,
  };
}

function parsePositiveIntegers(raw: string | undefined, defaults: number[]): number[] {
  const values = raw
    ? raw.split(",").map((part) => Number(part.trim()))
    : defaults;
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error(`expected comma-separated positive integers, received ${raw ?? ""}`);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function readConfig(): BenchmarkConfig {
  const output = process.env.BENCH_OUT?.trim();
  if (!output) {
    throw new Error("BENCH_OUT is required; choose an explicit JSON output path");
  }
  const queryCount = Number(process.env.BENCH_QUERIES ?? DEFAULT_QUERY_COUNT);
  if (!Number.isSafeInteger(queryCount) || queryCount <= 0) {
    throw new Error("BENCH_QUERIES must be a positive integer");
  }
  const seed = Number(process.env.BENCH_SEED ?? DEFAULT_SEED);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("BENCH_SEED must be an unsigned 32-bit integer");
  }
  return {
    sizes: parsePositiveIntegers(process.env.BENCH_N, DEFAULT_CORPUS_SIZES),
    queryCount,
    concurrency: parsePositiveIntegers(process.env.BENCH_CONCURRENCY, DEFAULT_CONCURRENCY),
    seed,
    outputPath: resolve(output),
    overwrite: process.env.BENCH_OVERWRITE === "1",
  };
}

async function gitSha(): Promise<string | null> {
  // Avoid spawning git or touching the network. CI can provide either variable.
  return process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA ?? null;
}

async function main(): Promise<void> {
  const config = readConfig();
  const startedAt = new Date().toISOString();
  const scale = [];
  for (const size of config.sizes) {
    console.log(`[institutional-memory] corpus=${size.toLocaleString()} queries=${config.queryCount}`);
    scale.push(await benchmarkScale(size, config));
    maybeGc();
  }

  console.log("[institutional-memory] evaluating calibration fixture");
  const calibration = await evaluateQualityFixture(calibrationFixture, config.seed);
  console.log("[institutional-memory] evaluating frozen held-out fixture");
  const heldout = await evaluateQualityFixture(
    heldoutFixture,
    config.seed ^ HELDOUT_SEED_SALT,
  );
  const report = {
    schema_version: 1,
    benchmark: "cross-repo-institutional-memory",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    git_sha: await gitSha(),
    platform: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu_count_hint: process.env.BENCH_CPU_COUNT ?? null,
      expose_gc: typeof (globalThis as typeof globalThis & { gc?: () => void }).gc === "function",
    },
    config: {
      corpus_sizes: config.sizes,
      queries_per_latency_cell: config.queryCount,
      concurrency: config.concurrency,
      seed: config.seed,
      dimensions: VECTOR_DIMENSIONS,
      reranking: false,
      network: false,
      vector_backend: "local-exact-cosine",
      policy_weights: {
        rrf_k: RRF_K,
        bm25: 0.4,
        vector: 0.6,
        graph: 0.3,
        scope_policy: "src/state/retrieval-policy.ts",
        same_mission_multiplier: 1.3,
        same_repo_multiplier: 1.18,
        related_repo_multiplier: 1.08,
        global_multiplier: 0.98,
        cross_repo_multiplier: 0.8,
      },
    },
    scale,
    quality: { calibration, heldout },
  };

  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: config.overwrite ? "w" : "wx",
  });
  console.log(`[institutional-memory] raw report: ${config.outputPath}`);
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
