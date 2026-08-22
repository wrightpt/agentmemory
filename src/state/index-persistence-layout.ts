import { KV } from "./schema.js";

/**
 * Shared on-disk/state layout for derived search-index snapshots.
 *
 * Operational tooling imports these constants so a key or scope-prefix change
 * cannot silently turn referenced shards into cleanup candidates.
 */
export const INDEX_STATE_SCOPE = KV.bm25Index;
export const BM25_LEGACY_KEY = "data";
export const BM25_MANIFEST_KEY = "data:manifest";
export const REBUILD_BARRIER_KEY = "rebuild:in-progress";
export const BM25_SHARD_SCOPE_PREFIX = `${INDEX_STATE_SCOPE}:bm25:`;
export const VECTOR_LEGACY_KEY = "vectors";
export const VECTOR_MANIFEST_KEY = "vectors:manifest";
export const VECTOR_FALLBACK_MANIFEST_KEY = "vectors:fallback-manifest";
export const VECTOR_SHARD_SCOPE_PREFIX = `${INDEX_STATE_SCOPE}:vectors:`;
export const INDEX_SHARD_KEY = "data";
