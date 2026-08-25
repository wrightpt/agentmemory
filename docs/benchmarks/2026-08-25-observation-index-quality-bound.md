# Observation-index quality boundary — 2026-08-25

Baseline deployed revision: `d3c282e630268494586290b76b242bb5aaeb3e1f`
Raw results: `observation-index-quality-bound-2026-08-25.json`

## Finding

PR #43 bounded physical snapshot generations, but a ten-minute idle proof still
found AgentMemory at 95.3% committed V8 heap, about 3.07 GB Node RSS, and about
5.87 GB III RSS. The remaining pressure was corpus quality, not vector scale:
routine command telemetry dominated the BM25 source rows while the local vector
store held only about 1,753 entries.

Applying policy version 2 to the live corpus retained every raw observation but
reduced eligible observation rows by 90.63% and source characters by 89.75%.
The replacement BM25 serialization is projected at 19.0 million characters and
10 shards, versus the deployed 158.4 million-character, 80-shard manifest.

## Method

`npm run bench:index-quality-live` paged the local AgentMemory REST API in
read-only mode, fetched observations with concurrency four, applied the same
pure indexing policy used by ingestion and rebuild, added all active durable
memories, serialized the resulting `SearchIndex`, and emitted aggregate counts
only. It did not write AgentMemory state or print observation content.

The 2026-08-21 frozen calibration and held-out cross-repository fixtures remain
the retrieval-quality gate. This live audit measures the production corpus
effect and is not used to tune hybrid ranking weights.

## Results

| Metric | Deployed snapshot / corpus | Policy v2 projection |
|---|---:|---:|
| Text-bearing observations | 143,199 | 13,421 indexed |
| Observation source characters | 51,084,903 | 5,234,480 indexed |
| Active durable memories | 1,033 | 1,033 indexed |
| BM25 entries | not separately exposed | 14,454 |
| Serialized BM25 characters | 158,393,361 | 19,045,097 |
| 2M-character shards | 80 | 10 |
| Audit-process RSS delta | n/a | 294,780,928 bytes |
| Fetch plus build | n/a | 5,727.4 ms |
| Serialization | n/a | 227.4 ms |

The retained observation set consisted of 11,465 file edits, 1,249 file
writes, 432 errors, and 275 substantive subagent records. Routine command runs,
file reads, searches, notifications, and web fetches remain stored and
inspectable by session, but no longer inflate the default institutional-memory
search surface.

These are pre-deployment component measurements. Success still requires a
versioned rebuild, a single-bank inventory, retrieval smoke tests, and a true
idle-window CPU/RSS proof after the exact merged revision is installed.
