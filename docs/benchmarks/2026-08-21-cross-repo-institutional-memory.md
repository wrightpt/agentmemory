# Cross-repository institutional-memory benchmark — 2026-08-21

## Decision

`EVALUATE_EXTERNAL_VECTOR_STORE`

This is an evaluation gate, not approval to replace the default backend.
`LocalVectorStore` remains the shipped default. The evidence justifies a
bounded external-backend comparison because the current local vector snapshot
cannot serialize 250,000 384-dimensional entries and single-process hybrid
tail latency degrades under concurrent-agent bursts. The same evidence also
shows that an external vector service alone will not solve the whole latency
problem: BM25, rather than exact cosine, dominates much of the 50k–250k
sequential hybrid cost.

## Scope and methodology

- Git baseline: `2a6b1486e9344ed8598d35f3f5adc1bd719e716f`.
- Receipt `git_sha` fields record that clean baseline because the measurements
  ran from the then-uncommitted implementation worktree; the receipts must be
  paired with this report and feature branch rather than treated as a clean
  checkout of the baseline commit.
- Host: AMD Ryzen 5 5600X, 6 cores / 12 logical CPUs, Linux x86-64,
  Node.js v22.23.2.
- Corpus sizes: 10k, 50k, 100k, 250k.
- Vectors: deterministic precomputed 384-dimensional unit vectors.
- Queries: 200 measured queries per latency cell; concurrency 1, 4, 8, 16.
- Channels: BM25, vector, BM25+vector, BM25+vector+graph.
- Reranking, network, embedding-provider latency, REST/MCP parsing, and a live
  daemon were intentionally excluded.
- Each size ran in a fresh process. Output was written only to the named JSON
  receipt; no AgentMemory daemon, socket, or production state was touched.
- The scope/quality policy is the production `retrieval-policy.ts`, but channel
  fusion is an in-process benchmark kernel over production SearchIndex,
  LocalVectorStore, and GraphRetrieval components. These are component-level
  diagnostics, not end-to-end service SLOs.
- Restore time is in-memory deserialize time, not disk/KV/daemon startup.
  Process memory includes the generated corpus, provenance fixture, indexes,
  and retained serialization payloads; it is not an isolated vector-store
  allocation measurement.
- The workstation was not quiesced, and two short build/test jobs overlapped
  the 250k run. These single-pass, 200-sample results are diagnostic. A
  publishable p99 requires at least 1,000 samples in each of three quiet fresh
  processes with the revision recorded.

Representative command (one fresh process per size):

```bash
GITHUB_SHA=2a6b1486e9344ed8598d35f3f5adc1bd719e716f \
BENCH_N=100000 BENCH_QUERIES=200 BENCH_CONCURRENCY=1,4,8,16 \
BENCH_OUT=docs/benchmarks/cross-repo-institutional-memory-2026-08-21-100k.json \
npm run bench:institutional-memory
```

Raw receipts:

- `cross-repo-institutional-memory-2026-08-21-10k.json`
- `cross-repo-institutional-memory-2026-08-21-50k.json`
- `cross-repo-institutional-memory-2026-08-21-100k.json`
- `cross-repo-institutional-memory-2026-08-21-250k.json`

## Scale findings

All times are milliseconds. RSS is the process snapshot immediately after
population; snapshot size is BM25 plus vector JSON where both succeeded.

| Corpus | Populate | RSS after populate | Snapshot | Restore | Triple p50 | Triple p95 | Triple p99 | C16 p95 | C16 p99 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10k | 2,779 | 193 MiB | 31.2 MiB | 488 | 27 | 31 | 34 | 436 | 451 |
| 50k | 10,227 | 467 MiB | 155.9 MiB | 2,471 | 176 | 433 | 576 | 5,501 | 6,746 |
| 100k | 25,665 | 814 MiB | 311.8 MiB | 3,289 | 380 | 961 | 1,010 | 10,124 | 13,240 |
| 250k | 36,821 | 1,813 MiB | failed | failed | 1,131 | 2,436 | 2,827 | 25,098 | 28,647 |

The 250k BM25 snapshot alone was 274,718,854 bytes and restored in 12,273 ms.
The vector index remained valid in memory with 250,000 entries, but
`VectorIndex.serialize()` failed after 4,787 ms with `RangeError: Invalid
string length`; therefore total snapshot bytes and total restore time are
undefined. Peak process RSS during that cell was 3,914,252,288 bytes.

Exact-cosine vector p95/p99 remained 27.8/32.4 ms at 10k, 46.4/53.2 ms at
50k, 113.1/163.1 ms at 100k, and 468.7/541.3 ms at 250k. In contrast, BM25
p95/p99 reached 846.2/925.9 ms at 100k and 1,972.2/2,201.4 ms at 250k. That
distinction matters: a remote vector service may solve vector persistence,
payload filtering, and concurrent scans, but the full hybrid path also needs a
separate BM25 profiling/concurrency pass.

## Held-out retrieval quality

The frozen six-query holdout was never used to tune weights. Qrels are
hand-authored and independent of embeddings and graph construction.

| Mode | nDCG@5 | nDCG@10 | MRR | Recall@5 | Recall@10 | Unrelated intrusion@5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BM25 | 0.833 | 0.833 | 0.833 | 0.833 | 0.833 | 0.409 |
| Vector | 0.820 | 0.820 | 0.833 | 0.750 | 0.750 | 0.714 |
| BM25 + vector | 0.820 | 0.827 | 0.833 | 0.750 | 0.833 | 0.621 |
| BM25 + vector + graph | 0.820 | 0.882 | 0.861 | 0.750 | 0.917 | 0.621 |

Every mode returned the exact-symbol, current-repository, semantic-paraphrase,
historical-bug, and explicitly related-repository target at rank 1. Every mode
had zero stale intrusion and complete provenance on returned fixture rows. The
graph channel recovered the graph-only architecture target at rank 6, raising
top-10 quality, but did not improve nDCG@5 or Recall@5. Wider cross-repository
search remains noisy (0.621 unrelated intrusion@5 in the triple stream), so it
must remain explicit and callers should prefer compact, low-limit local and
related-repository searches before opting into the wider ring.

## Gate rationale and next measurement

The evaluation trigger is the combination of:

1. a hard 250k local-vector persistence failure;
2. 100k C16 hybrid p95/p99 of 10.1/13.2 seconds;
3. 250k C16 hybrid p95/p99 of 25.1/28.6 seconds;
4. a 1.81 GiB post-population and 3.91 GiB peak process footprint at 250k;
5. the need to filter by canonical repository, mission, lifecycle, and agent
   scope before rank assignment rather than hydrate/filter every candidate.

Evaluate Qdrant first behind the new `VectorStore` boundary, without changing
the BM25 or graph authorities and without making it the default. Compare it to
a local record-aware binary/chunked persistence experiment so the decision is
not biased toward a service merely because the legacy JSON codec is
monolithic. The comparison must use production HybridSearch and an end-to-end
MCP/REST path, repeat 100k and 250k in quiet fresh processes, verify payload
filtering and isolation, inject backend outage/timeout cases, and measure
backup/restore and operational recovery. Qdrant is the first candidate because
its documented [payload filters](https://qdrant.tech/documentation/search/filtering/)
and [filter-aware payload indexes](https://qdrant.tech/documentation/manage-data/indexing/)
map directly to repository, mission, lifecycle, and agent-scope predicates.
[pgvector](https://github.com/pgvector/pgvector) supports exact and approximate
nearest-neighbor search plus SQL filtering, but should be the second candidate
only if AgentMemory adopts PostgreSQL as an existing storage authority;
otherwise it adds an unrelated database plus dual-write failure modes.
