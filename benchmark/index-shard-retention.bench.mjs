/**
 * Benchmark: bounded-bank saves with lazy retired-generation reclamation.
 *
 * Measures, over an alternating bank save sequence on a synthetic corpus:
 *   - distinct BM25 shard scopes ever created (must stay <= 2 * maxShards)
 *   - resident BM25 shard scopes after each save (must equal current shards)
 *   - logical bytes written per save and in total
 *   - wall time per save
 *
 * Run: npx tsx benchmark/index-shard-retention.bench.mjs
 */
import { SearchIndex } from "../src/state/search-index.js";
import { IndexPersistence } from "../src/state/index-persistence.js";

const SAVES = Number(process.env.BENCH_SAVES ?? 8);
const DOCS = Number(process.env.BENCH_DOCS ?? 5_000);
const SHARD_CHARS = Number(process.env.BENCH_SHARD_CHARS ?? 250_000);
const BM25_SHARD_PREFIX = "mem:index:bm25:bm25:";

const kvStore = new Map();
const everWrittenScopes = new Set();
const kv = {
  get: async (scope, key) => kvStore.get(`${scope}\0${key}`) ?? null,
  set: async (scope, key, value) => {
    kvStore.set(`${scope}\0${key}`, value);
    if (scope.startsWith(BM25_SHARD_PREFIX)) everWrittenScopes.add(scope);
    return value;
  },
  delete: async (scope, key) => { kvStore.delete(`${scope}\0${key}`); },
  listGroups: async () => Array.from(new Set(Array.from(kvStore.keys()).map((k) => k.split("\0")[0]))),
};

function makeIndex(seed) {
  const idx = new SearchIndex();
  for (let i = 0; i < DOCS; i++) {
    const id = `obs_bench_${seed}_${i}`;
    const body = `alpha beta gamma delta epsilon zeta eta theta ${seed} doc ${i} `.repeat(6);
    idx.add({
      id,
      sessionId: "ses_bench",
      timestamp: new Date().toISOString(),
      type: "file_edit",
      title: body.slice(0, 120),
      subtitle: "bench",
      facts: [body.slice(0, 80)],
      narrative: body,
      concepts: ["bench"],
      files: ["bench.ts"],
      importance: 5,
    });
  }
  return idx;
}

let totalLogicalBytes = 0;
const times = [];
let maxShards = 0;
let maxResidentScopes = 0;
let residentBoundFailed = false;

for (let s = 1; s <= SAVES; s++) {
  const persistence = new IndexPersistence(kv, makeIndex(s), null, { shardChars: SHARD_CHARS });
  const t0 = performance.now();
  await persistence.save();
  const ms = performance.now() - t0;
  times.push(ms);
  const manifest = await kv.get("mem:index:bm25", "data:manifest");
  const residentScopes = new Set(
    Array.from(kvStore.keys())
      .map((key) => key.split("\0")[0])
      .filter((scope) => scope.startsWith(BM25_SHARD_PREFIX)),
  );
  totalLogicalBytes += manifest.chars;
  console.log(`save ${s}: gen=${manifest.generation} shards=${manifest.shards.length} resident=${residentScopes.size} retiredRefs=${(manifest.retired ?? []).length} writeMiB=${(manifest.chars / 2 ** 20).toFixed(1)} ms=${ms.toFixed(0)}`);
  maxShards = Math.max(maxShards, manifest.shards.length);
  maxResidentScopes = Math.max(maxResidentScopes, residentScopes.size);
  if (residentScopes.size !== manifest.shards.length) residentBoundFailed = true;
}

const historicalBound = 2 * maxShards;
console.log("----");
console.log(`distinct scopes ever : ${everWrittenScopes.size} (bound ${historicalBound})`);
console.log(`peak resident scopes : ${maxResidentScopes} (bound ${maxShards})`);
console.log(`total logical writes : ${(totalLogicalBytes / 2 ** 20).toFixed(1)} MiB over ${SAVES} saves`);
console.log(`avg save wall time   : ${(times.reduce((a, b) => a + b, 0) / SAVES).toFixed(0)} ms`);
if (everWrittenScopes.size > historicalBound || residentBoundFailed) {
  console.error("FAIL: historical or resident scope bound exceeded");
  process.exitCode = 1;
} else {
  console.log("PASS");
}
