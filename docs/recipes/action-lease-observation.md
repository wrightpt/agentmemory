# Scoped native lease observation

This is a read projection of the existing `mem:leases` authority. It grants no
execution authority and does not replace native acquire/release/renew or their
per-action locks. It adds no task/lease ledger, REST endpoint or MCP tool.

## Opt-in on the existing exact action read

```text
GET /agentmemory/actions/get?actionId=act_...&projectId=project&includeLeaseObservation=true
```

The normal action/history response gains `leaseObservation` only when explicitly
requested. An old request retains its old shape. The opt-in requires a canonical
project ID matching the native action and explicit unmigrated authority (`null`).
Frozen/migrated/unknown authority is unavailable, not a fallback to AgentMemory.

```json
{
  "protocol": "action-lease-observation/v1",
  "projectId": "project",
  "actionId": "act_...",
  "state": "active",
  "lease": {
    "id": "lse_...",
    "agentId": "wsh:worker",
    "acquiredAt": "2026-11-21T01:00:00.000Z",
    "renewedAt": null,
    "expiresAt": "2026-11-21T01:10:00.000Z"
  },
  "observedAt": "2026-11-21T01:01:00.000Z",
  "watermark": { "sequence": 2, "digest": "<64 lowercase hex>" }
}
```

`none` requires a complete successful native read and `lease: null`. A missing
capability, storage failure, malformed/unscopable row, multiple current leases,
or holder/action mismatch never returns `none`. An active observation requires
the native task to be active and assigned to that exact lease holder. Native
timestamps are projected as canonical UTC milliseconds.

The full opt-in read compares its action/authority cut to the later cheap lease
cut. Concurrent action changes return `lease_observation_action_changed`; the
server does not combine old history/edges/children and a later committed action
store cut. The full opt-in also requires the same collection revision across
its two cuts. Lease-only renewals do not advance that action collection revision.

## Cheap final re-observation

```text
GET /agentmemory/actions/get?actionId=act_...&projectId=project&includeLeaseObservation=true&leaseOnly=true
```

This returns `{success, readMode: "lease-only", action, revision, workAuthority,
leaseObservation}`. It deliberately omits edges/children/events; it is not a
replacement for a complete action/history read. The same project, action and
opt-in flag are mandatory on both cuts. It reads one exact action and the native
lease collection, not all actions, edges or historical events. No lease rows or
action projections are written by this observation.

Lock order is the existing `mem:action:<id>` lock followed by `mem:actions:v2`.
This serializes the cut with native renewals and ordinary action changes without
reversing mutation lock order. A pending native action journal is explicitly
refused (`lease_observation_action_pending`), not repaired by this cheap read.
Normal action APIs retain their existing recovery behavior.

## Native ordering and expiry

Native lease writes carry three additive fields on the **same existing row**:
`observationVersion`, `observationDigest`, and `observationLegacyDigest`. Acquire, renew, release, cleanup
expiration and diagnostic-heal expiration compute `1 + max(version)` among
retained leases for that action under its existing lock, then write the stamp
with the lease mutation. Same-owner acquire remains idempotent and does not
advance it. No separate counter write or read-side write exists.

The existing stale-delete policy retains terminal leases while their action
exists. This retains the version floor across process restarts and successive
holders. Orphan cleanup after action removal cannot yield a lease observation:
the exact action read then refuses `lease_observation_action_missing`.

The public sequence is `2 * maxVersion + expiryBit`. The bit is 1 only when no
unexpired active lease exists but at least one native status-active lease has
expired. Thus time passing to expiry advances the source order even before
cleanup runs or action revision changes. The next native mutation advances to
the next even step. Later cleanup of an older expired lease also advances native
order without clearing a different active holder. Counts are safe integers and
exhaustion refuses rather than wraps.

The digest binds project/action, active-or-none selection and sorted native lease
identity/status/timestamps/version. It excludes sampling time. Identical active
observations remain stable; renewals change the mark even when action revision
does not move. Expiry changes both state and sequence. Consumers must reject
lower sequence or same-sequence/different-digest cuts, clock regressions and
expired evidence at use time. A restored older data generation or backward wall
clock must not be treated as forward evidence or a new grant.

## Legacy and rollback

Valid unstamped legacy rows are observed at version 0 without writes. Natural
expiry occupies step 1; their next native mutation stamps version 1 or higher.
Native mutations preserve existing TTL, holder, readiness and rollback behavior.
A failed acquire's existing compensation remains inside its per-action lock, so
no observation sees the transient row/version as a committed lease.

A row that carries a stamp but whose authority-bearing content no longer matches
it (for example an old binary preserving fields while changing expiry) refuses
`lease_observation_unversioned_change`. It is not silently downgraded to legacy.
The latest versioned row also binds the remaining unstamped legacy rows by digest.
This detects an old binary adding/removing/changing an unstamped lease after a
versioned mutation, rather than returning a new holder under the old sequence.
It is only a checksum, not a second copy of lease state or a separate ledger.
Rolling back the producer removes the opt-in capability; consumers must report
unknown/unavailable rather than infer absence. A data rollback may lower the
native sequence and must be refused by a consumer retaining a later watermark.

The projection bounds a complete lease collection to 50,000 rows; exceeding it
is `lease_observation_incomplete`, never truncation. A single scoped observation
is not a source of fleet completeness or an execution authorization.

## Tests and release boundary

`test/action-lease-observation.test.ts` covers optional/cheap modes, no writes or
history scans, renewal stability, natural expiry before cleanup, release/heal,
legacy rows, old-binary changes, retained version floor, conflicting records,
scope/fence failures, native read failure, action-cut races, per-action lock
ordering, backward-clock detection and strict REST flag forwarding. Existing
lease, diagnostics and action suites remain the native mutation regression gate.
Source qualification is separate from producer/consumer wire review and serving
activation. Do not infer live lease evidence until both installed sides agree.
