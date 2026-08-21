import { createHash } from "node:crypto";
import type {
  LocalVectorEntry,
  VectorMetadata,
  VectorSearchFilter,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from "./vector-store.js";

const COLLECTION_PATTERN = /^agentmemory_shadow_[A-Za-z0-9_-]+$/;
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_ERROR_BODY_CHARS = 500;
const MAX_QUERY_LIMIT = 500;

export interface QdrantVectorStoreConfig {
  baseUrl: string;
  collection: string;
  dimensions: number;
  timeoutMs?: number;
  apiKey?: string;
  allowRemote?: boolean;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

interface QdrantScoredPoint {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

function boundedErrorBody(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, MAX_ERROR_BODY_CHARS);
}

function normalizedStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
    .sort();
}

function matchAny(key: string, values: readonly string[]): Record<string, unknown> {
  return values.length === 1
    ? { key, match: { value: values[0] } }
    : { key, match: { any: values } };
}

export function buildQdrantFilter(
  filter: VectorSearchFilter | undefined,
): Record<string, unknown> | undefined {
  if (!filter) return undefined;
  const must: Record<string, unknown>[] = [];
  const fields: Array<[string, readonly string[] | undefined]> = [
    ["canonicalRepoId", filter.canonicalRepoIds],
    ["project", filter.projectIds],
    ["missionId", filter.missionIds],
    ["agentId", filter.agentIds],
  ];
  for (const [key, rawValues] of fields) {
    const values = normalizedStrings(rawValues);
    if (values.length > 0) must.push(matchAny(key, values));
  }
  if (filter.isLatest !== undefined) {
    must.push({ key: "isLatest", match: { value: filter.isLatest } });
  }
  return must.length > 0 ? { must } : undefined;
}

/** Stable Qdrant point ID. Repeating an observation upsert replaces the same
 * derived point instead of creating duplicates. */
export function qdrantPointId(observationId: string): string {
  const hex = createHash("sha256").update(observationId).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function validateConfig(config: QdrantVectorStoreConfig): {
  baseUrl: string;
  timeoutMs: number;
} {
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Qdrant URL must not contain credentials, query parameters, or fragments");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Qdrant URL must use http or https");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (!loopback && config.allowRemote !== true) {
    throw new Error("Remote Qdrant endpoints require allowRemote=true");
  }
  if (!loopback && url.protocol !== "https:" && config.apiKey) {
    throw new Error("Qdrant API keys require HTTPS for non-loopback endpoints");
  }
  if (!COLLECTION_PATTERN.test(config.collection)) {
    throw new Error("Qdrant shadow collection must match agentmemory_shadow_[A-Za-z0-9_-]+");
  }
  if (!Number.isSafeInteger(config.dimensions) || config.dimensions <= 0) {
    throw new Error("Qdrant vector dimensions must be a positive integer");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Qdrant timeout must be positive");
  }
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    timeoutMs: Math.floor(timeoutMs),
  };
}

export class QdrantVectorStore implements VectorStore {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private initialized = false;
  private pointCount = 0;
  private pointIdentitiesKnown = false;
  private readonly knownPointIds = new Set<string>();

  constructor(
    private readonly config: QdrantVectorStoreConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  ) {
    const validated = validateConfig(config);
    this.baseUrl = validated.baseUrl;
    this.timeoutMs = validated.timeoutMs;
  }

  private headers(hasBody: boolean): Record<string, string> {
    return {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(this.config.apiKey ? { "api-key": this.config.apiKey } : {}),
    };
  }

  private async rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers(init.body !== undefined),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.rawRequest(path, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Qdrant ${init.method ?? "GET"} ${path} -> ${response.status}: ` +
          boundedErrorBody(text),
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  private collectionPath(suffix = ""): string {
    return `/collections/${encodeURIComponent(this.config.collection)}${suffix}`;
  }

  private async collectionInfo(): Promise<Record<string, unknown> | null> {
    const response = await this.rawRequest(this.collectionPath());
    if (response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Qdrant GET ${this.collectionPath()} -> ${response.status}: ` +
          boundedErrorBody(text),
      );
    }
    const parsed = (text ? JSON.parse(text) : null) as {
      result?: Record<string, unknown>;
    } | null;
    return parsed?.result ?? null;
  }

  private collectionDimensions(info: Record<string, unknown>): number | undefined {
    const config = info.config as Record<string, unknown> | undefined;
    const params = config?.params as Record<string, unknown> | undefined;
    const vectors = params?.vectors as Record<string, unknown> | undefined;
    return typeof vectors?.size === "number" ? vectors.size : undefined;
  }

  private async createCollection(): Promise<void> {
    await this.request(this.collectionPath(), {
      method: "PUT",
      body: JSON.stringify({
        vectors: { size: this.config.dimensions, distance: "Cosine" },
      }),
    });
    for (const field of [
      "canonicalRepoId",
      "project",
      "missionId",
      "agentId",
      "memoryType",
    ]) {
      await this.request(this.collectionPath("/index?wait=true"), {
        method: "PUT",
        body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
      });
    }
    await this.request(this.collectionPath("/index?wait=true"), {
      method: "PUT",
      body: JSON.stringify({ field_name: "isLatest", field_schema: "bool" }),
    });
    this.pointCount = 0;
    this.pointIdentitiesKnown = true;
    this.knownPointIds.clear();
    this.initialized = true;
  }

  async ensureCollection(): Promise<void> {
    if (this.initialized) return;
    const info = await this.collectionInfo();
    if (!info) {
      await this.createCollection();
      return;
    }
    const dimensions = this.collectionDimensions(info);
    if (dimensions !== this.config.dimensions) {
      throw new Error(
        `Qdrant collection dimension mismatch: expected ${this.config.dimensions}, ` +
          `got ${dimensions ?? "unknown"}`,
      );
    }
    this.pointCount = Number(info.points_count ?? 0);
    this.pointIdentitiesKnown = this.pointCount === 0;
    this.knownPointIds.clear();
    this.initialized = true;
  }

  private validateEmbedding(embedding: Float32Array): void {
    if (embedding.length !== this.config.dimensions) {
      throw new Error(
        `Qdrant vector dimension mismatch: expected ${this.config.dimensions}, ` +
          `got ${embedding.length}`,
      );
    }
  }

  private point(entry: LocalVectorEntry): QdrantPoint {
    this.validateEmbedding(entry.embedding);
    return {
      id: qdrantPointId(entry.obsId),
      vector: Array.from(entry.embedding),
      payload: {
        ...(entry.metadata ?? {}),
        obsId: entry.obsId,
        sessionId: entry.sessionId,
      },
    };
  }

  async upsertBatch(entries: readonly LocalVectorEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.ensureCollection();
    const points = entries.map((entry) => this.point(entry));
    await this.request(this.collectionPath("/points?wait=true&ordering=weak"), {
      method: "PUT",
      body: JSON.stringify({ points }),
    });
    if (this.pointIdentitiesKnown) {
      for (const point of points) this.knownPointIds.add(point.id);
      this.pointCount = this.knownPointIds.size;
    } else {
      await this.refreshPointCount();
    }
  }

  async add(
    observationId: string,
    sessionId: string,
    embedding: Float32Array,
    metadata?: VectorMetadata,
  ): Promise<void> {
    await this.upsertBatch([
      {
        obsId: observationId,
        sessionId,
        embedding,
        ...(metadata === undefined ? {} : { metadata }),
      },
    ]);
  }

  async deleteBatch(observationIds: readonly string[]): Promise<void> {
    if (observationIds.length === 0) return;
    await this.ensureCollection();
    const pointIds = [...new Set(observationIds)].sort().map(qdrantPointId);
    await this.request(this.collectionPath("/points/delete?wait=true&ordering=weak"), {
      method: "POST",
      body: JSON.stringify({
        points: pointIds,
      }),
    });
    if (this.pointIdentitiesKnown) {
      for (const pointId of pointIds) this.knownPointIds.delete(pointId);
      this.pointCount = this.knownPointIds.size;
    } else {
      await this.refreshPointCount();
    }
  }

  async remove(observationId: string): Promise<void> {
    await this.deleteBatch([observationId]);
  }

  async search(
    query: Float32Array,
    options: VectorSearchOptions = {},
  ): Promise<VectorSearchResult[]> {
    this.validateEmbedding(query);
    await this.ensureCollection();
    const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(options.limit ?? 20)));
    const filter = buildQdrantFilter(options.filter);
    const response = await this.request<{
      result?: { points?: QdrantScoredPoint[] } | QdrantScoredPoint[];
    }>(this.collectionPath("/points/query"), {
      method: "POST",
      body: JSON.stringify({
        query: Array.from(query),
        limit: Math.min(MAX_QUERY_LIMIT, limit * 2),
        with_payload: true,
        ...(filter ? { filter } : {}),
      }),
    });
    const result = response.result;
    const points = Array.isArray(result) ? result : (result?.points ?? []);
    return points
      .map((point): VectorSearchResult => {
        const payload = point.payload ?? {};
        return {
          obsId: String(payload.obsId ?? point.id),
          sessionId: String(payload.sessionId ?? ""),
          score: point.score,
          metadata: payload,
        };
      })
      .sort((a, b) => b.score - a.score || a.obsId.localeCompare(b.obsId))
      .slice(0, limit);
  }

  get size(): number {
    return this.pointCount;
  }

  private async refreshPointCount(): Promise<void> {
    const info = await this.collectionInfo();
    this.pointCount = Number(info?.points_count ?? 0);
  }

  async resetCollection(): Promise<void> {
    const info = await this.collectionInfo();
    if (info) {
      await this.request(this.collectionPath(), { method: "DELETE" });
    }
    this.initialized = false;
    this.pointCount = 0;
    this.pointIdentitiesKnown = false;
    this.knownPointIds.clear();
    await this.createCollection();
  }

  async clear(): Promise<void> {
    await this.resetCollection();
  }
}
