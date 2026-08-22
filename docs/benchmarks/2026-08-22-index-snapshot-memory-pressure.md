# AgentMemory index snapshot pressure

Date: 2026-08-22
Baseline/deployed revision: `3ecdff1`
Raw results: `index-snapshot-memory-pressure-2026-08-22.json`

## Finding

The recurring degraded state is not evidence that the vector backend needs to
change. The live vector snapshot is about 3.6 MB and two shards; the current
BM25 snapshot is about 213 MB and 107 shards. Most file-backed index state is
unreachable derived data: the read-only inventory found 381 orphan shard files
(834.5 MB) versus 111 files (240.5 MB) referenced by the current BM25, vector,
and vector-fallback manifests.

III 0.11.2 loads every file-backed state scope into its in-memory map at boot.
Its delete call acknowledges the in-memory mutation before the background file
save loop makes that deletion durable. Dynamic per-save scope names therefore
allow acknowledged-but-still-physical generations to return on restart.

## Method

The live inventory called `state::get` for the rebuild barrier and three index
manifest keys, scanned only file names and metadata in the configured state
directory, then reread the manifests. It failed closed if a rebuild was active
or either manifest sample changed. It did not mutate the service or store.

The deterministic snapshot fixture created 200 BM25 documents, used 500
characters per shard (139 shards), and saved the unchanged index three times
against an in-memory StateKV mock that retains empty scope identities like the
III file adapter. The before run used the byte-identical pre-fix persistence
source from `4a82c78`; the after run used this branch. Counters covered state
sets, peak simultaneous shard calls, retained shard scopes, generation names,
and index-persistence audit rows.

The ownership-transfer fixture built 25,000 identical deterministic documents
in separate Node processes with `--expose-gc`. It compared the post-GC delta
from copying a restored `SearchIndex` to transferring its maps into the live
index.

## Results

| Three-save persistence metric | Before | After |
|---|---:|---:|
| Generation names | 3 | 2 fixed banks |
| Retained shard scopes | 417 | 278 |
| Index-persistence audit rows | 701 | 9 |
| Peak concurrent shard calls | 139 | 4 |
| State set calls | 1,121 | 429 |

At 25,000 documents, deep-copy restore added 56.9 MB heap and 58.7 MB RSS.
Ownership transfer added 1.8 KB heap and 0.13 MB RSS while leaving the source
index empty and the target fully searchable.

These are component measurements, not a post-deployment soak claim. The live
degraded service remains on the pre-fix build and still contains legacy orphan
files. Production success requires the stopped-service quarantine procedure,
a restart on the pinned fixed build, and the 24-hour gates in
`docs/recipes/index-snapshot-memory-pressure.md`.
