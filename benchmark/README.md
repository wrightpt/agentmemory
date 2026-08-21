# benchmark/

Two kinds of numbers live in this directory:

1. **Quality / retrieval** — `longmemeval-bench.ts`, `quality-eval.ts`,
   `real-embeddings-eval.ts`, `scale-eval.ts`. Recall, precision, token
   savings. Documented in `LONGMEMEVAL.md`, `QUALITY.md`,
   `REAL-EMBEDDINGS.md`, `SCALE.md`.

2. **Load shape** — `load-100k.ts`. p50 / p90 / p99 latency and
   throughput against a running daemon. This is the file you want when
   somebody asks "what's p99 at 100k memories under concurrency 100?".

## load-100k.ts

Hand-rolled, dependency-free load harness. Issues real HTTP against a
local agentmemory daemon at `http://localhost:3111`, records per-request
latency with `performance.now()`, and writes a JSON report per run.

### What it measures

For each cell in the matrix `(N, concurrency, endpoint)` it records:

- `p50_ms`, `p90_ms`, `p99_ms` — nearest-rank percentiles.
- `min_ms`, `max_ms`, `ops`, `errors`.
- `throughput_per_sec` — wall-clock ops / sec for that cell.

Default matrix:

- `N` ∈ {1000, 10000, 100000} — number of memories seeded before the
  cell runs.
- `C` ∈ {1, 10, 100} — concurrent in-flight requests during the cell.
- Endpoints under test:
  - `POST /agentmemory/remember`
  - `POST /agentmemory/smart-search`
  - `GET  /agentmemory/memories?latest=true`

Each cell issues `BENCH_OPS=200` requests by default — enough samples
for stable p99 without dragging a 100k-seed run past tens of minutes.

### Why p99 is the number that matters

p50 tells you the median request feels fast. p90 tells you the bulk of
requests feel fast. **p99 tells you the request your tail user hits when
they really need it feels fast.** Capacity planning lives here — if you
want to size a fleet, scale your daemon, or set an SLO, p99 is the
number to plan against. p50 will lie to you.

### Running it

```bash
# 1. Start the daemon however you normally do (npx, Docker, etc.)
npx @agentmemory/agentmemory

# 2. From the repo root, in another shell:
npm run bench:load
```

To override the matrix:

```bash
BENCH_N=1000 BENCH_C=1,10 BENCH_OPS=100 npm run bench:load
```

To have the harness spawn a daemon for the run (after `npm run build`):

```bash
AGENTMEMORY_BENCH_AUTOSTART=1 npm run bench:load
```

Other env knobs (see the file header for the canonical list):

- `AGENTMEMORY_URL` — base URL of the daemon (default
  `http://localhost:3111`).
- `BENCH_SEED` — seed for the `mulberry32` content RNG. Same seed +
  same daemon build = byte-identical seed corpus.
- `BENCH_OUT_DIR` — where the JSON report lands (default
  `benchmark/results/`).

### Where results land

`benchmark/results/load-100k-<short-git-sha>.json`. The harness
`mkdir -p`s the directory. The file has a `schema_version: 1` field so
future format changes don't silently break consumers.

### Content generation is seedable

Synthetic memory content is built from a small noun / verb / concept
vocabulary fed by a `mulberry32(BENCH_SEED)` PRNG. Same seed + same
build = same corpus. The point isn't "realistic" content (there isn't
one realistic content); the point is **reproducibility** — re-running
the harness against the same git sha should give the same content
mixture going in, so latency variance comes from the daemon and not
from JSON payload jitter.

### Publishing numbers per release

The release flow appends a `## Performance` section to `CHANGELOG.md`
referencing the JSON in `benchmark/results/` for that release's git
sha. p99 is the headline number; the JSON is the receipt.

## Cross-repository institutional memory

`cross-repo-institutional-memory.ts` is the decision-gate benchmark for the
default exact-cosine vector store and the BM25 + vector + graph retrieval
architecture. It is deliberately separate from `load-100k.ts`: it never talks
to a daemon, never opens a socket, and cannot write to a live AgentMemory
store. The output path is mandatory and an existing file is not overwritten
unless `BENCH_OVERWRITE=1` is explicitly set.

### Decision run

```bash
BENCH_OUT=/tmp/agentmemory-institutional-memory.json \
  npm run bench:institutional-memory
```

The default matrix uses exact corpus sizes 10k, 50k, 100k, and 250k, 1,000
measured queries per latency cell, and burst concurrency 1, 4, 8, and 16. Run
one corpus size at a time on memory-constrained machines:

```bash
BENCH_N=250000 BENCH_OUT=/tmp/agentmemory-250k.json \
  npm run bench:institutional-memory
```

Before a decision run, use the bounded smoke profile:

```bash
BENCH_N=1000 BENCH_QUERIES=12 BENCH_CONCURRENCY=1,4 \
BENCH_OUT=/tmp/agentmemory-institutional-memory-smoke.json \
  npm run bench:institutional-memory
```

Environment controls:

- `BENCH_N`: comma-separated positive corpus sizes;
- `BENCH_QUERIES`: measured queries per latency/concurrency cell;
- `BENCH_CONCURRENCY`: comma-separated burst widths;
- `BENCH_SEED`: unsigned 32-bit seed;
- `BENCH_OUT`: required raw JSON path;
- `BENCH_OVERWRITE=1`: explicitly allow replacing that one output file.

### Performance methodology

The corpus generator uses fixed timestamps, a fixed seeded PRNG, and
precomputed 384-dimensional unit vectors. Every observation retains distinct
project, canonical repository, session, agent, mission, worktree, branch,
commit, file, timestamp, type, confidence, and importance metadata. Graph size
grows deterministically at one auxiliary node per 250 observations, with 64
topic nodes shared across sizes.

Each size runs in this order:

1. generate the corpus and vectors;
2. populate BM25, local exact-cosine vector, in-memory KV, and graph indexes;
3. serialize BM25 and vector indexes;
4. deserialize each successful snapshot, replace the live index, and force GC
   when `--expose-gc` is available;
5. measure BM25, true vector-only, BM25+vector, and BM25+vector+graph;
6. measure burst-concurrent triple-stream search.

The JSON contains component and total population time, serialized bytes,
component restore time, index sizes after restore, RSS/heap/external/array
buffer memory, process high-water RSS, errors, throughput, and nearest-rank
p50/p95/p99. A burst's timer starts before it enters the event-loop queue, so
tail latency includes queueing behind synchronous exact-cosine scans. Reranking
and embedding-provider latency are disabled; those are separate concerns from
the vector-store decision gate.

Serialization or restore failure is a measured result, not a reason to discard
the corpus cell. The JSON records the error and a null byte/restore total, then
continues retrieval measurements against the still-valid in-memory index. This
distinguishes search scalability from persistence/startup viability.

For publishable measurements, run with no unrelated CPU/memory load and record
the git SHA through `GITHUB_SHA` or `CI_COMMIT_SHA`. Use at least 1,000 samples
for p99. Repeat the full run in three fresh processes if a result is close to a
decision threshold; a single in-process pass is a diagnostic, not a release
claim.

## Isolated Qdrant decision gate

`qdrant-vector-evaluation.ts` exercises the same `VectorStore` seam against a
caller-managed Qdrant instance. It is an evaluation adapter only: AgentMemory
does not import it, production configuration cannot select it, and the harness
refuses non-loopback endpoints and non-benchmark collection names by default.

Create a disposable loopback-only Qdrant instance, then run:

```bash
QDRANT_URL=http://127.0.0.1:6333 \
QDRANT_COLLECTION=agentmemory_eval_100000 \
BENCH_N=100000 \
BENCH_OUT=/tmp/agentmemory-qdrant-100k-fresh.json \
  npm run bench:qdrant-vector-evaluation
```

After restarting the same instance with its benchmark storage retained, probe
restore behavior without repopulating it:

```bash
QDRANT_URL=http://127.0.0.1:6333 \
QDRANT_COLLECTION=agentmemory_eval_100000 \
BENCH_N=100000 BENCH_REUSE=1 \
BENCH_OUT=/tmp/agentmemory-qdrant-100k-restore.json \
  npm run bench:qdrant-vector-evaluation
```

The harness records population-to-optimizer-ready time, vector p50/p95/p99 at
concurrency 1/4/8/16, indexed repository filtering, exact-local recall@10,
same-process rank repeatability, the frozen held-out BM25/vector/graph quality
fixture, and Qdrant process metrics. Container readiness, cgroup memory, and
physical storage are lifecycle-level measurements and must be recorded by the
caller. Use a fresh collection and storage directory for every corpus size.

Safety controls:

- `QDRANT_URL` must be loopback unless `QDRANT_ALLOW_REMOTE=1` is explicit;
- `QDRANT_COLLECTION` must match `agentmemory_eval_[A-Za-z0-9_-]+` unless
  explicitly overridden;
- output is create-only unless `BENCH_OVERWRITE=1` is explicit;
- collection cleanup occurs only with `BENCH_CLEANUP=1`;
- no AgentMemory daemon, production state, or default backend is changed.

### Retrieval-quality methodology

The same runner evaluates two different hand-authored fixtures:

- `calibration-v1` is the only fixture on which policy weights may be changed;
- `heldout-v1` uses different repositories, symbols, vocabulary, graph nodes,
  missions, and semantic keys and is evaluated only after weights are frozen.

Both fixtures cover exact-symbol lookup, semantic paraphrase, cross-repository
architecture, historical bugs, current-repository preference, related-project
dependencies, same-basename unrelated repositories, semantic distractors,
graph-only targets, and stale/superseded rows. Qrels are explicit constants in
`cross-repo-quality-fixtures.ts`; they are not generated from concepts,
embeddings, graph edges, or search output.

The four ablations use the same scope/provenance policy: BM25 only, true vector
only, BM25+vector, and BM25+vector+graph. The report includes nDCG@5/10, MRR,
Recall@5/10, exact-symbol top-1, current-repo top-1, related-repo recall,
unrelated and stale intrusion rates, provenance completeness, per-query top
IDs, and a SHA-256 rank digest. Do not tune on `heldout-v1`; changing policy
after seeing its result requires a new policy version and a new holdout.

### External vector-store gate

These raw measurements inform, but do not mechanically make, the decision.
Keep the local store unless the 100k/250k receipts demonstrate unacceptable
latency, memory, restore, or concurrent-agent behavior under a stated target.
Any external-store recommendation must also account for filtering needs,
operational complexity, availability, backup/restore, and failure modes.
