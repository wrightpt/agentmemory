# Qdrant vector-store decision gate — 2026-08-21

## Outcome

`EVALUATE_EXTERNAL_VECTOR_STORE`

The local exact-cosine store remains AgentMemory's default. No external vector
backend was added to production. The measurements justify a production-shaped
Qdrant shadow evaluation because the local JSON snapshot fails at 250k and its
exact scan has materially worse scale and concurrency. They do not justify
replacing BM25, graph retrieval, structured coordination state, or the local
fallback.

## Method

- AgentMemory base: `f2773d2756510216896ff74af9cff29bc5ce2f68`.
- Candidate: Qdrant 1.19.0, commit `74f3e85`, image digest
  `sha256:057ee3a8da769fe7310dd3537b4dc7583bf87a95ce8ac43c0af5a46bc580d1fc`.
- Host: AMD Ryzen 5 5600X, 6 cores / 12 logical CPUs, 121 GiB RAM.
- Endpoint: loopback only; one disposable container and bind mount per size.
- Corpora: deterministic 10k, 50k, 100k, and 250k entries, 384 dimensions.
- Payload indexes: `canonicalRepoId`, `missionId`, and `agentId`.
- Search: 1,000 measured queries per concurrency cell, candidate limit 100,
  concurrency 1/4/8/16, plus 250 current-repository filtered queries.
- Quality: the frozen six-query holdout used by the local decision run. It was
  not used to tune weights.
- Fresh population waited for green collection status, optimizer `ok`, and
  the exact expected point count. Restore readiness was measured from
  `docker start` to the first successful `/readyz` response.
- Qdrant process RSS comes from its metrics endpoint. Container memory and
  physical storage were measured externally. Node client RSS includes the
  generated truth corpus and is not attributed to Qdrant.
- The workstation was not quiesced. AgentMemory and other agents remained
  active, so these are decision-gate measurements rather than release SLOs.

The benchmark adapter exists only in `benchmark/`; it cannot be selected by
AgentMemory runtime configuration. The container, collections, and exact
temporary storage directories were removed after the measurements.

## Fresh population and search

All times are milliseconds.

| Corpus | Population to ready | Process RSS | Physical store | Vector p50 |   p95 |   p99 | C16 p95 | C16 p99 | Filtered p95 |
| -----: | ------------------: | ----------: | -------------: | ---------: | ----: | ----: | ------: | ------: | -----------: |
|    10k |               2,886 |     124 MiB |         40 MiB |       7.63 | 13.45 | 18.12 |   41.81 |   52.10 |         7.61 |
|    50k |              10,900 |     158 MiB |        132 MiB |       3.32 |  6.96 | 11.41 |   17.88 |   20.24 |         4.64 |
|   100k |              18,204 |     173 MiB |        231 MiB |       3.55 |  9.67 | 13.79 |   18.62 |   20.96 |         7.25 |
|   250k |              79,698 |     189 MiB |        531 MiB |       4.37 | 15.92 | 19.89 |   33.73 |   50.21 |        13.73 |

The 10k collection is slower than 50k because this default configuration is
still in the exact/brute-force regime before Qdrant's indexing threshold. The
candidate was not tuned per corpus size.

## Restore and warmed search

| Corpus | Ready after restart | Process RSS | Vector p50 |   p95 |   p99 | C16 p95 | C16 p99 | Filtered p95 | Recall@10 |
| -----: | ------------------: | ----------: | ---------: | ----: | ----: | ------: | ------: | -----------: | --------: |
|    10k |                 404 |     121 MiB |       7.13 | 12.55 | 16.63 |   54.93 |   76.55 |         8.75 |     1.000 |
|    50k |                 669 |     131 MiB |       6.70 | 11.43 | 16.73 |   22.80 |   27.21 |         3.87 |     1.000 |
|   100k |                 731 |     139 MiB |       3.68 |  5.19 |  7.92 |   28.85 |   38.51 |         4.41 |     1.000 |
|   250k |                 676 |     168 MiB |       3.76 |  4.96 |  7.50 |   25.92 |   40.69 |         4.82 |     1.000 |

Every run returned the same exact top-10 set as local cosine search. Rankings
were identical across repeated queries inside each run. At 50k, one query's
tied ordering changed across the container restart (16/16 exact before,
15/16 exact after) even though recall stayed 1.0; 10k, 100k, and 250k retained
all 16 exact orders. A future adapter must over-fetch and apply AgentMemory's
`score DESC, observationId ASC` tie-breaker before fusion rather than trusting
backend order at a tie boundary.

## Local comparison

| Corpus | Local vector p95 | Qdrant restored p95 | Ratio | Local restore | Qdrant ready | Local vector snapshot               |
| -----: | ---------------: | ------------------: | ----: | ------------: | -----------: | ----------------------------------- |
|    10k |            27.75 |               12.55 |  2.2x |           488 |          404 | 20.7 MiB                            |
|    50k |            46.40 |               11.43 |  4.1x |         2,471 |          669 | 103.6 MiB                           |
|   100k |           113.13 |                5.19 | 21.8x |         3,289 |          731 | 207.1 MiB                           |
|   250k |           468.70 |                4.96 | 94.5x |        failed |          676 | `RangeError: Invalid string length` |

This is not a claim that the full hybrid path becomes 94.5 times faster.
Local BM25 p95 was 846 ms at 100k and 1,972 ms at 250k, while 16-client
triple-stream p95 was 10.1 s and 25.1 s. Qdrant fixes the vector scan,
filtering, and vector persistence dimensions; BM25 serialization and search
remain separate bottlenecks. Live deployment evidence reinforces that split:
the current corpus has a 212.6 MB / 107-shard BM25 snapshot but only a 3.58 MB
/ 2-shard vector snapshot, and large snapshot writes can transiently return
503 from the health trigger under fleet load.

Memory comparisons are also not perfectly symmetric. Local RSS includes the
corpus, provenance map, BM25, graph, vector store, and serialization strings.
Qdrant RSS is the service only; the Node generator/client peaked from 279 MiB
at 10k to 1.23 GiB at 250k but is not part of a steady-state remote backend.

## Retrieval quality

Qdrant reproduced the held-out local quality results exactly:

| Mode                  | nDCG@5 | nDCG@10 |   MRR | Recall@5 | Recall@10 | Unrelated intrusion@5 |
| --------------------- | -----: | ------: | ----: | -------: | --------: | --------------------: |
| BM25                  |  0.833 |   0.833 | 0.833 |    0.833 |     0.833 |                 0.409 |
| Vector                |  0.820 |   0.820 | 0.833 |    0.750 |     0.750 |                 0.714 |
| BM25 + vector         |  0.820 |   0.827 | 0.833 |    0.750 |     0.833 |                 0.621 |
| BM25 + vector + graph |  0.820 |   0.882 | 0.861 |    0.750 |     0.917 |                 0.621 |

Every mode kept exact-symbol and current-repository top-1 behavior, related
repository recall@5 of 0.75, zero stale intrusion, and complete provenance.
Graph remained additive: it recovered the graph-only architecture source in
the top 10. The result supports a swappable vector component, not vector-only
retrieval.

## Decision and next gate

Qdrant should be the first external store evaluated in a production-shaped
shadow because it already demonstrates sub-second restore readiness, indexed
repository filtering, bounded service memory, and dramatically lower vector
tail latency at 100k–250k. It is not yet approved as the default because this
run did not test production dual-write recovery, backup/restore, upgrades,
timeouts, isolation predicates under adversarial payloads, or end-to-end
MCP/REST latency.

The next bounded evaluation should:

1. implement a non-default Qdrant adapter behind `VectorStore` in an isolated
   branch and shadow it from durable observations;
2. over-fetch and deterministically tie-break before hybrid fusion;
3. push canonical repo, mission, lifecycle, and permitted agent scope into
   payload filters before rank assignment;
4. fail open to BM25+graph on timeout while reporting vector degradation;
5. compare against a local binary/chunked vector snapshot so Qdrant is not
   chosen merely because the current JSON codec is monolithic;
6. measure end-to-end smart-search, dual-write reconciliation, backup/restore,
   and process/container failure injection.

No such adapter or production service is implemented by this change.

## Raw receipts

- `qdrant-vector-evaluation-2026-08-21-10k-fresh.json`
- `qdrant-vector-evaluation-2026-08-21-10k-restore.json`
- `qdrant-vector-evaluation-2026-08-21-50k-fresh.json`
- `qdrant-vector-evaluation-2026-08-21-50k-restore.json`
- `qdrant-vector-evaluation-2026-08-21-100k-fresh.json`
- `qdrant-vector-evaluation-2026-08-21-100k-restore.json`
- `qdrant-vector-evaluation-2026-08-21-250k-fresh.json`
- `qdrant-vector-evaluation-2026-08-21-250k-restore.json`
- `qdrant-vector-evaluation-2026-08-21-operations.json`
