# Index snapshot memory-pressure recovery

AgentMemory persists BM25 and local-vector indexes as derived snapshots. Raw
observations, memories, sessions, actions, relationships, and provenance remain
the authoritative structured state. Never delete those authoritative scopes to
repair a search-index incident.

## Prevention in current builds

Production index snapshots alternate between fixed `bank-a` and `bank-b` shard
scope names. This bounds future file-backed state scope cardinality even when an
III `state::delete` acknowledgement is not yet durable. Explicit flushes join an
in-flight snapshot and perform at most one follow-up; writes arriving during the
follow-up return to the normal quiet-period debounce.

Legacy manifests with generated `idx_*` names remain readable. The first new
snapshot publishes a banked manifest before any legacy-generation cleanup is
attempted.

## Read-only inventory

Run the inventory while AgentMemory is live so it can read a stable pair of
manifests through III. The command has no apply/delete mode and refuses to
classify files while a rebuild barrier is active or if manifests change during
the scan. It also defers every unreferenced scope modified within the last six
hours: shard data can become visible before its manifest publication, so a
recent unreferenced bank is not yet a safe cleanup candidate. Layout keys and
scope prefixes come from the same source module as production persistence. The
inventory also refuses to produce a plan if the primary BM25 manifest is
missing while shards exist or if any manifest-referenced shard file is absent.

```bash
node --import tsx scripts/index-snapshot-orphans.ts \
  --store /home/cp/data/state_store.db \
  --iii-bin /home/cp/.local/bin/iii \
  > /tmp/agentmemory-index-orphans.json
```

Review the JSON plan. A cleanup-candidate orphan is only a physical shard scope under
`mem:index:bm25:bm25:*` or `mem:index:bm25:vectors:*` that is absent from the
current BM25, vector, and vector-fallback manifests and older than the fixed
six-hour safety horizon. `deferredUnreferenced` entries must remain untouched;
rerun the inventory after the horizon instead of overriding it.

Run the inventory against the active store, not an archival restore whose file
mtimes may have been preserved or rewritten by backup tooling. After restoring
a store, start and verify it without cleanup, wait through the six-hour safety
horizon, then generate a new plan.

## Offline quarantine procedure

This is a maintenance-window operation, not an automatic migration.

1. Record the deployed AgentMemory and III revisions, current health, index
   counts, and a retrieval-quality smoke result.
2. Save the read-only orphan plan above.
3. Stop AgentMemory and verify both the Node worker and III child are gone.
4. Make a complete, checksummed backup of `state_store.db`, `queue_store`, and
   `stream_store` on a filesystem with enough free space.
5. Verify each planned orphan still has the recorded size and modification
   time, and confirm no deferred entry is in the move set. If any file differs,
   discard the plan and restart without cleanup.
6. Move only the verified orphan files into a separate quarantine directory;
   do not unlink them. Keep the current manifest files and every referenced
   bank intact.
7. Start AgentMemory, then verify liveness, action create/read/cancel, BM25 exact
   symbol retrieval, vector retrieval, graph retrieval, project scoping, and
   provenance before declaring recovery.
8. Soak for 24 hours. Require stable cgroup RSS, no new non-bank index scopes,
   no priority-10 sentinel action, and unchanged retrieval-quality fixtures.

Rollback is to stop the service, restore the exact checksummed store backup (or
move quarantined files back to their original names), and restart the previously
pinned AgentMemory build. Do not mix a state rollback with a source-version
change.

## Known bounded failure mode: vector fallback tear during bank alternation

Under `bank-a`/`bank-b` alternation, the incoming generation always writes the
bank referenced by the current vector fallback manifest. A crash mid
shard-write can therefore tear the retained fallback copy while the primary
manifest stays intact and authoritative. This is accepted by design: shard
loads validate per-shard lengths, a torn fallback fails closed into the full
rebuild-from-observations path, and BM25 has no fallback manifest. Do not
"repair" a torn fallback in place; rerun the rebuild path or re-publish a
generation via a normal save.
