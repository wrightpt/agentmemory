# Conditional stale-record cleanup

Owner: AgentMemory. Contract: `stale-delete-v1`.
Source: `src/functions/stale-cleanup.ts`, `stale-cleanup-policy.ts`, and
`src/state/maintenance-barrier.ts`. Validation: `test/stale-cleanup.test.ts`.

Use `POST /agentmemory/maintenance/stale-delete` for scheduled deletion.
The endpoint uses the same bearer authentication as the other protected REST
routes. It does not schedule work or authorize a deployment.

First send `{"protocol":"stale-delete-v1","kind":"capabilities"}`.
A compatible engine returns `conditional: true`, `minIdleMs: 259200000`, and
`requiresReconciliation: false` when its write outcomes are known.
An older engine's missing endpoint must stop cleanup; never fall back to
unconditional governance deletion or direct state writes.

A deletion request names one `kind` (`memory` or `lease`), `id`, `cutoff`, and
`expectedFingerprint`. The fingerprint is SHA-256 of recursively key-sorted
JSON. The server rejects cutoffs newer than 72 hours ago and compares the
fingerprint against authoritative storage. The scheduler should freeze one
cutoff and bound its number of requests.

Memory must be latest, unscoped, session-free, free of linked evidence, and old
by creation, update, and recorded access. Invalid timestamps or access logs
retain it. References in memories, actions, lessons, relations, semantic and
procedural records, insights, and crystals retain it. Inventories are bounded
at 5,000 memories and 20,000 rows per other reference collection; invalid,
duplicate, excessive, or failed reads stop cleanup. Leases must be released or
expired, older than the cutoff by all timestamps, and have no surviving action.

All engine `StateKV.set`, `update`, and `delete` calls in those collections,
access logs, and leases participate in a mutation barrier. Ordinary writes
remain concurrent. A write during the eligibility scan changes its revision,
so cleanup retains the candidate. An in-flight write also prevents the commit.
The revision comparison and acquiring the commit barrier are synchronous.

During the commit, writes wait. A waiting write that targets or mentions the
deleted ID fails with `maintenance_write_conflict`; callers must reload the
record before retrying. Unrelated writes resume normally. This prevents a
queued stale update from recreating a deleted record or committing a dangling
reference. Mutations begun after the maintenance operation finishes retain
their existing API semantics; this is not a general foreign-key or distributed
transaction layer. The barrier is shared by StateKV instances using the same
engine SDK. External raw iii state writers bypass it and must not run alongside
maintenance. Use the engine APIs for shared state changes.

A failed guarded write or commit latches `requiresReconciliation` for that
engine SDK's lifetime. Cleanup then retains candidates as `state-write-uncertain`;
ordinary operations remain available. A timed-out iii write may still complete,
so inspect the exact invocation and storage/audit state before a controlled
recovery. There is no automatic reset or timer-driven restart of this latch.

Successful deletion returns the protocol, kind and ID, `outcome: "deleted"`,
and `deleted: 1`. Retention returns `outcome: "retained"`, `deleted: 0`, and a
reason, including `concurrent-write`. No-op requests write no audit residue.
The commit records intent before deletion, maintains access/search indexes for
memories, then records completion. It never strips surviving references.
Storage or index failures propagate; the caller must retain the pending ID and
inspect the audit before retrying an uncertain deletion. The barrier releases
on failure, and waiting writes concerning an uncertain deleted ID fail closed.

The existing manual governance endpoints retain their explicit-delete behavior.
This source change does not enable any timer, replace a deployment pin, or
restart AgentMemory.
