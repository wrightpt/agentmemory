export interface VectorMetadata {
  [key: string]: unknown;
}

export interface VectorSearchOptions {
  limit?: number;
  /** Optional backend-side narrowing. HybridSearch still hydrates and applies
   * its authoritative policy after retrieval; this is an optimization and a
   * benchmark surface, never an authorization boundary by itself. */
  filter?: VectorSearchFilter;
}

export interface VectorSearchFilter {
  canonicalRepoIds?: readonly string[];
  projectIds?: readonly string[];
  missionIds?: readonly string[];
  agentIds?: readonly string[];
  isLatest?: boolean;
}

export interface VectorSearchResult {
  obsId: string;
  sessionId: string;
  score: number;
  metadata?: VectorMetadata;
}

/**
 * Storage boundary for semantic vectors.
 *
 * Implementations may be synchronous (the default local store) or asynchronous
 * (a future remote store). Callers must therefore await every mutating/search
 * operation even though awaiting a synchronous return value is harmless.
 */
export interface VectorStore {
  add(
    observationId: string,
    sessionId: string,
    embedding: Float32Array,
    metadata?: VectorMetadata,
  ): Promise<void> | void;

  remove(observationId: string): Promise<void> | void;

  search(
    query: Float32Array,
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> | VectorSearchResult[];

  readonly size: number;

  clear(): Promise<void> | void;
}

export interface VectorDimensionValidation {
  mismatches: Array<{ obsId: string; dim: number }>;
  seenDimensions: Set<number>;
}

export interface LocalVectorEntry {
  obsId: string;
  sessionId: string;
  embedding: Float32Array;
  metadata?: VectorMetadata;
}

/**
 * Local JSON snapshot capability used by AgentMemory's existing KV persistence.
 *
 * This is deliberately separate from VectorStore: a future external backend
 * should own its durability instead of being serialized into the local KV index.
 */
export interface PersistableLocalVectorStore extends VectorStore {
  readonly persistenceFormat: "agentmemory-local-vector-v1";
  serialize(): string;
  restoreFrom(other: PersistableLocalVectorStore): void;
  validateDimensions(expected: number): VectorDimensionValidation;
  /** Streams a copy of each entry so a derived backend can reconcile without
   * materializing a second full embedding corpus in memory. */
  entries(): IterableIterator<LocalVectorEntry>;
}

type StoredVector = {
  embedding: Float32Array;
  sessionId: string;
  metadata?: VectorMetadata;
};

type SerializedVector = {
  embedding: string;
  sessionId: string;
  metadata?: VectorMetadata;
};

// Pass byteOffset + byteLength explicitly so the round-trip survives
// Node's Buffer pool. Buffer.from(b64, "base64") returns a slice of a
// shared 8KB pool (poolSize), and `new Float32Array(buf.buffer)` ignores
// the slice metadata — it would mint a 2048-element view over the whole
// pool. Same risk on the encode side if the input Float32Array is itself
// a sliced view. Reported as a phantom "2048 dimensions on disk" crash
// in #455 / #469 / #584 / #587.
function float32ToBase64(arr: Float32Array): string {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64",
  );
}

function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Exact in-memory cosine implementation used by AgentMemory today. */
export class LocalVectorStore implements PersistableLocalVectorStore {
  readonly persistenceFormat = "agentmemory-local-vector-v1" as const;

  protected vectors: Map<string, StoredVector> = new Map();

  add(
    observationId: string,
    sessionId: string,
    embedding: Float32Array,
    metadata?: VectorMetadata,
  ): void {
    this.vectors.set(observationId, {
      embedding,
      sessionId,
      ...(metadata === undefined ? {} : { metadata }),
    });
  }

  remove(observationId: string): void {
    this.vectors.delete(observationId);
  }

  // The numeric form is retained for source compatibility with VectorIndex.
  // VectorStore callers should use { limit } so future backends can grow the
  // option set without positional parameters.
  search(
    query: Float32Array,
    options: VectorSearchOptions | number = {},
  ): VectorSearchResult[] {
    const limit =
      typeof options === "number" ? options : (options.limit ?? 20);
    const results: VectorSearchResult[] = [];
    let minScore = -Infinity;

    for (const [obsId, entry] of this.vectors) {
      const score = cosineSimilarity(query, entry.embedding);
      const result: VectorSearchResult = {
        obsId,
        sessionId: entry.sessionId,
        score,
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      };
      if (results.length < limit) {
        results.push(result);
        if (results.length === limit) {
          results.sort(
            (a, b) =>
              a.score - b.score || b.obsId.localeCompare(a.obsId),
          );
          minScore = results[0].score;
        }
      } else if (
        score > minScore ||
        (score === minScore && obsId.localeCompare(results[0].obsId) < 0)
      ) {
        results[0] = result;
        results.sort(
          (a, b) => a.score - b.score || b.obsId.localeCompare(a.obsId),
        );
        minScore = results[0].score;
      }
    }

    results.sort(
      (a, b) => b.score - a.score || a.obsId.localeCompare(b.obsId),
    );
    return results;
  }

  get size(): number {
    return this.vectors.size;
  }

  // Walks every stored vector and returns the obsIds whose dimension
  // doesn't match `expected`, plus the set of distinct dimensions seen.
  // Used by the persistence-restore guard in src/index.ts to refuse
  // loading any index containing wrong-dimension vectors — including
  // legacy on-disk indexes written before the live-API dimension guard
  // existed (where a mid-session provider swap could mix dimensions
  // inside a single index). Empty `mismatches` plus a single-entry
  // `seenDimensions` matching `expected` is the only clean state.
  validateDimensions(expected: number): VectorDimensionValidation {
    const mismatches: Array<{ obsId: string; dim: number }> = [];
    const seenDimensions = new Set<number>();
    for (const [obsId, entry] of this.vectors) {
      const dim = entry.embedding.length;
      seenDimensions.add(dim);
      if (dim !== expected) {
        mismatches.push({ obsId, dim });
      }
    }
    return { mismatches, seenDimensions };
  }

  *entries(): IterableIterator<LocalVectorEntry> {
    for (const [obsId, entry] of this.vectors) {
      yield {
        obsId,
        sessionId: entry.sessionId,
        embedding: new Float32Array(entry.embedding),
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      };
    }
  }

  clear(): void {
    this.vectors.clear();
  }

  restoreFrom(other: PersistableLocalVectorStore): void {
    const restored = LocalVectorStore.deserialize(other.serialize());
    this.vectors = restored.cloneEntries();
  }

  serialize(): string {
    const data: Array<[string, SerializedVector]> = [];
    for (const [obsId, entry] of this.vectors) {
      data.push([
        obsId,
        {
          embedding: float32ToBase64(entry.embedding),
          sessionId: entry.sessionId,
          ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
        },
      ]);
    }
    return JSON.stringify(data);
  }

  static deserialize(json: string): LocalVectorStore {
    const store = new LocalVectorStore();
    store.loadSerialized(json);
    return store;
  }

  protected loadSerialized(json: string): void {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;
    for (const row of data) {
      try {
        if (!Array.isArray(row) || row.length < 2) continue;
        const [obsId, entry] = row;
        if (
          typeof obsId !== "string" ||
          typeof entry?.embedding !== "string" ||
          typeof entry?.sessionId !== "string"
        ) {
          continue;
        }
        const metadata =
          entry.metadata !== null && typeof entry.metadata === "object"
            ? (entry.metadata as VectorMetadata)
            : undefined;
        this.vectors.set(obsId, {
          embedding: base64ToFloat32(entry.embedding),
          sessionId: entry.sessionId,
          ...(metadata === undefined ? {} : { metadata }),
        });
      } catch {
        continue;
      }
    }
  }

  private cloneEntries(): Map<string, StoredVector> {
    const cloned = new Map<string, StoredVector>();
    for (const [obsId, entry] of this.vectors) {
      cloned.set(obsId, {
        embedding: new Float32Array(entry.embedding),
        sessionId: entry.sessionId,
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      });
    }
    return cloned;
  }
}
