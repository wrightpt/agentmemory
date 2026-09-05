# iii copy amplification and ledger partitions

Updated 2026-09-05. The strongest supported lead for the write-related CPU and
memory pressure is whole-collection copying in iii's file-backed state adapter.
This is a demonstrated amplification mechanism; it is not proof that all of the
live service's multi-gigabyte RSS comes from one leak.

## What had already been done

At 08:02 UTC the live service reported source
`67cf4f71aa1503d161b4a4ab60906621db1e0c8f`, version `0.9.27` and build
`workstation-deepseek-llm-v2`. That revision includes the Pi Astra action-read
repair: eliminate unused full-action change-detection serialization and surface
authoritative read failures instead of caching empty success. It preserves the
earlier action-list snapshot cache. The configured provider was already
`resilient(openai)` with model `glm-5.3`; provider restoration and persistence
pressure are separate issues.

An earlier, unfinished `partition-hot-ledgers` worktree already implemented the
basic daily audit/monthly action-event partition design, on older base
`67cea61`. This integration preserves that work and rebases it onto `67cf4f7`.
It adds history integrity regressions, explicit read-error handling and a
compatible write-mode rollback. Attribution belongs to those separate pieces;
there is no evidence that nobody else identified the mechanism.

## Mechanism

The captured iii source, `iii-builtin-kv.rs`, shows:

1. A row mutation marks its collection dirty. Flushes can coalesce mutations;
   it is inaccurate to claim every API write immediately flushes the file.
2. On the configured five-second persistence cycle, `save_loop` clones the
   entire dirty collection (`store.get(&index).cloned()`, lines 273-275).
3. `persist_index_to_disk` serializes that clone into a JSON string, then an
   additional archived byte buffer (lines 154-155), writes a temporary file,
   and renames it over the collection file.

Thus a small append to a large audit or action-event ledger can allocate and
serialize its entire accumulated history. Repeated cycles cause work far larger
than the changed row. iii's loaded in-memory state and allocator behavior add
separate residency costs. RSS is not the same thing as live allocated objects.

Local source evidence:
`/home/cp/shared/pi-astra-max-benchmark-20260905-KL5O4e/evidence/iii-builtin-kv.rs`.
The synthetic tests used iii binary SHA-256
`03a2d645c16dc9502fb6a694bb2b16465f6772cbe7c65baa15e3adbf3f021bb7`.

The live seven-sample window at 08:10-08:11 UTC also observed the legacy audit
file grow by only 824 bytes while its roughly 99.5 MB file was rewritten twice.
iii's aggregate process write-byte counter grew about 197.6 MiB across all
collections during that window. This is natural-traffic corroboration, not an
isolated attribution of every written byte to audit. See `predeploy.jsonl` in
the integration evidence directory.

## Controlled evidence

Pi's isolated comparison used the same 8,192 synthetic action rows with
41.444 MiB logical JSON, once in one collection and once in 256 collections.
No production records or services were used for the workload.

| Metric | One collection | 256 collections |
| --- | ---: | ---: |
| Final idle RSS | 574.55 MiB | 140.79 MiB |
| Cold reload RSS | 129.82 MiB | 130.19 MiB |
| Peak resident high-water mark | 784.30 MiB | 140.79 MiB |
| Persistence bytes per measured update cycle | 83.08 MiB | 1.31 MiB |
| First-generation process CPU | 6,090 ms | 3,880 ms |

All six original cases reported zero RPC failures and preserved their expected
state manifests after restart. However, the flat case's resident high-water
mark exceeded its 768 MiB budget while sampled RSS missed the peak. The author
flagged and corrected that guard; this case is evidence, not a claim that every
resource limit passed. No larger optional stress run should be justified by it.

The table supports the copy-amplification lead and smaller write collections.
It does not predict this integration's exact savings: the production design
uses 64 action-ID buckets per month, rather than the experiment's 256 row
buckets, and leaves historical collections loaded. Cold reload RSS was nearly
unchanged. A separate allocator-instrumented synthetic run is needed to
distinguish free-but-retained arenas from outstanding allocations; its result
must be reported separately from this paired comparison.

Authoritative experiment files:

- `/home/cp/shared/pi-astra-max-benchmark-20260905-KL5O4e/followup-iii-pressure/evidence/comparison.json`
- The adjacent `PLAN_AMENDMENT.md` and `evidence/resource-audit.json` document
  the resource-guard limitation and the bounded follow-up.

## Repair and integrity guarantees

`src/state/partitioned-ledgers.ts` centralizes storage discovery and reads:

- New audit writes use `mem:audit:day:YYYY-MM-DD` in UTC.
- Online action events use `mem:action-events:month:YYYY-MM:bNN`, with 64 stable
  SHA-256 action-ID buckets. Each action's events stay together within a month.
- Imported events use 64 fixed `mem:action-events:import:bNN` buckets, so
  untrusted historical timestamps do not create unbounded calendar partitions.
- Small event-ID locators have their own 64 buckets. They retain global ID
  conflict detection even when an import changes an event's action or date.
- Pending commits record their exact event scope. Recovery works across a
  restart or write-mode change; interrupted locator/event/projection writes
  remain covered by tests.
- Legacy and partitioned histories remain readable and deduplicated by event
  ID. A creation or migration event alone cannot justify skipping legacy
  history: imports and write-mode rollback can put later events there.
- Import/export and explicit GC use actual storage locations. Read/discovery
  failures do not silently become an empty successful history or permission to
  overwrite an existing event identity.

This redirects future writes. It does not migrate/delete old memories, change
the default `LocalVectorStore`, remove structured actions/leases/sessions, or
replace iii. Older adapters without `listGroups` retain legacy writes.

## Compatible rollback

`AGENTMEMORY_LEDGER_WRITE_MODE` accepts `partitioned` (default) or `legacy`.
An invalid value fails before writing. Reads always support both layouts.

After new-format writes, do not reinstall `67cf4f7` or an earlier binary as an
ordinary rollback: it cannot read the partitioned history. Retain this reader
and set `AGENTMEMORY_LEDGER_WRITE_MODE=legacy` in the service environment, then
perform the same graceful worker-first restart and revision/health checks.
This reintroduces the old write amplification but preserves access to records
from both layouts. Returning to `partitioned` also preserves intervening legacy
events. The mode-switch regression exercises both directions.

An unrelated binary regression needs a forward fix or a rebuilt rollback
artifact retaining these readers. Restoring old stored data would discard new
writes and requires a separately diagnosed corruption recovery; it is not a
routine performance rollback.

## Validation and deployment record

Integration evidence is kept at
`/home/cp/shared/agentmemory-ledger-integration-20260905`.
The original patch and its file hashes were preserved before integration;
the original worktree was not edited. Seven added safety tests initially failed
against that patch. Those cases now pass, with rollback and invalid-mode cases
added afterward. The final full suite passed 1,917 tests in 182 files, recorded
in `full-suite-rollback.log`.
`npm run build` passed. `tsc --noEmit` reported the same 40 pre-existing
diagnostics as the Pi source baseline, with no added diagnostic after ignoring
line-number movement. Another independently owned task is addressing them.

`benchmark/verify-ledger-persistence.mts` also passed against a private iii
process: 69 synthetic events and two audits survived two restarts, imported
event identity lookup, legacy-write rollback and reactivation. All three owned
engine processes exited. The result and private file store are in `engine-smoke`.
This validates persistence after the configured flush interval; it does not add
an fsync acknowledgement or an ACID transaction across iii collection files.

Tests ran with an isolated network namespace and private memory-state/temp
directories, retaining the original HOME value. An initial `/dev/null`
permission failure was corrected in the sandbox, not by weakening tests.

Source preparation, artifact publication, activation and live verification are
separate states. Consult the exact lock, deployment marker, live `/health`
revision and the integration's deployment record before declaring it deployed.
Building this checkout alone has no effect on the installed package.

## Runtime acceptance and remaining limits

Use natural traffic for the live soak. Record process start times, interval CPU,
RSS/PSS/private dirty memory, process write-byte deltas, invocation/error
counters, action-list latency, and metadata for legacy/new ledger files. Check
revision continuity, event history and sentinel write/read/cancel behavior.
Health 200 or a small V8 heap alone does not establish memory health.

Require new appends to create/update small partition files while the old
monolithic ledgers stop changing, except during explicit legacy mode or a
separately requested import/GC. Compare comparable activity intervals; a fresh
restart's lower RSS alone is not evidence of a sustained fix. Record startup,
5/15/30/60 minutes and later 6/24-hour observations as they actually occur.

Remaining concerns include historical boot rehydration, allocator retention,
other large collections, outstanding invocation accounting and bursty hot
partitions. Daily/monthly partitioning bounds history per period, not bytes
under arbitrary traffic. Export/full-history reads still materialize records.
Do not declare the whole incident resolved until these measurements support it.
