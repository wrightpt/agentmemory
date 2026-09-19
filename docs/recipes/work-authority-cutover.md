# Project task authority cutover

AgentMemory remains the task authority for projects without a control record.
For a selectively migrated project, Beads owns work, dependencies and claims;
AgentMemory preserves historical actions and continues to own memory. This
boundary is provider neutral and does not require DSH or an active Kimi subscription.

The authenticated REST endpoint `GET /agentmemory/work-authority?projectId=...`
returns `work-authority/v1`, the current phase/generation and a complete bounded
metadata snapshot. Full historical descriptions and terminal content are not
returned. The snapshot digest covers exact source records and graph edges.
`POST /agentmemory/work-authority` accepts whitelisted transition fields only.

| Input | Transition | Durable evidence | Failure behavior |
| --- | --- | --- | --- |
| Exact plan/source digests, selected IDs and explicit deferred IDs | AgentMemory → frozen, generation 1 | `mem:work-authority[projectId]` and audit event | Reject drift, missing dispositions, active leases, unacknowledged historical assignments and selected dependencies |
| Complete unique source→Bead mapping, receipt digest, triage Bead ID | frozen → beads | Same control record, immutable action history, audit event | Reject wrong plan/generation, incomplete or conflicting receipts |
| Replayed identical transition | No new transition | Existing record | Return the original result; never reopen historical actions |

Every open action must have a disposition. The initial importer selects only
unassigned pending tasks with no graph edges or human/manual gate. Unselected
historical assignments must be named in `heldClaimIds` and remain held for
triage; their source owner/status is preserved. An active, unexpired lease
always prevents freezing the project. Source observation and fence publication
use the action-store lock and existing maintenance barrier; an outstanding
writer aborts the transition.

The fence is checked before action events and inside StateKV writes for actions,
edges and leases. This covers existing MCP/REST clients, raw restore writes,
claim/release paths and project renames. A rejected write is
`work_authority_read_only`; it is not an uncertain storage write. Frontier and
open action views exclude frozen/migrated projects. Historical list/get access
remains; graph/get responses identify historical authority. GC, lease expiry
and healing preserve fenced source actions. Generic imports are rejected while
any project is fenced; they cannot resurrect task authority via an old export.

There is deliberately no unfreeze endpoint or automatic rollback. A partial
Beads import remains deferred while the engine fence stays frozen. Resume the
same reviewed plan after reconciling errors. Back up the native iii state store
including `mem:work-authority`, the Beads store and importer receipts together.
Legacy JSON exports alone do not contain sufficient cutover control evidence.
Do not downgrade to a pre-fence runtime after freezing a project: that would
restore an unchecked writer. Recovery must retain the fence implementation.

Validation: `npm test` and `npx tsc --noEmit`. `test/work-authority.test.ts`
uses the real StateKV/barrier with engine-faithful clone/undefined semantics,
including restart, concurrent-writer, claim, raw-write, history and quarantine
assertions. `scripts/work-authority-fixture.ts` is a marker-gated, loopback-only
synthetic storage transport for the workspace-config native importer pilot;
it is never a production engine, replacement store or client fallback.

Code preparation is not activation. Package and verify the exact source/digest
using the workspace deployment tooling. The existing systemd activation gate
still applies; no service restart is performed by these endpoints or tests.
