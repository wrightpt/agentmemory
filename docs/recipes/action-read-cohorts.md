# Coherent action-read cohorts

The existing scalar native action APIs keep their response and authority
contracts. They now share collection scans when concurrent readers are waiting
to acquire `mem:actions:v2`. This reduces read amplification without introducing
another task store, projection cache, scheduler, public endpoint or authority.

## Consistency and admission

`readActionStoreSnapshot` keeps a pending cohort per `StateKV` instance. A
cohort contains at most 256 callers and 64 distinct requested event action IDs.
Overflow starts another FIFO lock acquisition; no result or history is dropped.
The cohort is removed from joinable state **before the first native state read**.
Requests arriving while a scan is active cannot extend that scan. Consequently
a queued writer is not starved by a continuously growing active read batch.

The existing `withActionStoreLock` and `recoverActionStoreUnlocked` remain the
consistency boundary. Pending journal recovery completes under that lock before
actions, edges or history are exposed. The writer/commit protocol is unchanged;
`commitEventUnlocked` is deliberately untouched to preserve separately owned
closeout journal-admission work. This is scan amortization, not a lock-free or
optimistically stale read.

Each cohort scans actions and edges once. When selected action histories are
requested, `listActionEventsForActions` reads each applicable monthly/import
partition once and the entire legacy event scope once, then retains all matching
events. Legacy rollback writes and imported/corrected history are not skipped
on the basis of a creation event or a presumed migration cutoff. A caller asking
for all history still receives all history. A caller asking for no history or
one action receives only that mode's events, never a sibling's history.

Each returned snapshot is cloned for caller isolation. There is no completed
cache or TTL: a subsequent call always enters a new native observation, even
if the collection revision is unchanged. Failed cohorts propagate the failure;
later calls retry normal reads rather than inheriting a failed or partial cache.
Separate `StateKV` instances do not share a cohort.

## Qualification

`test/action-read-cohorts.test.ts` verifies:

- 64 installed scalar `mem::action-get` calls share one action scan, one edge
  scan and one legacy-history scan, preserving exact event ownership/revision
  and explicit unmigrated authority;
- complete legacy/monthly/imported/correction history, duplicate migration
  records, and later legacy-mode writes;
- independent mutable replies and each caller's original history mode;
- 257 callers and 65 distinct IDs split into two complete cohorts;
- a native writer queued during one read commits before later readers, which
  observe its new revision/projection/history;
- pending-journal recovery, read failures, unchanged-revision refresh and
  isolation between native KV instances.

The focused tests measure scan counts, not production latency. A lone cold
read still needs a full action/edge scan and complete applicable event history.
A live overloaded engine's previously queued invocations are not cancelled by
this source change; deployment remains separate reviewed work. Client deadlines
are not server-side cancellation. Consumer-side same-scope in-flight coalescing
can complement this native fix without weakening freshness or write authority.

Run the engine gate with `npm test -- --no-file-parallelism`, and the paired
owner's closeout fixtures on the independently reviewed combined revision before
serving. Do not deploy an unrelated closeout branch to obtain this read repair.
