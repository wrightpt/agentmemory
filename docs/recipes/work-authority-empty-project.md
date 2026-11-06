# Empty-project first admission

`selectionMode: empty-project-first-admission/v1` is an explicit companion to
`work-authority/v1`. It adds no endpoint, scheduler or task. It is source support;
installing a reviewed package and admitting a project remain separate operations.

The ordinary 1–32 selection and `zero-selected-defer-all/v1` contracts remain
unchanged. Unmarked empty selection, unknown modes and switching modes are
rejected. This new mode requires an entirely empty project, including terminal
history. Snapshot `totalRecords` counts all matching actions before filtering
terminal rows; the existing source digest continues to cover records and edges.

Freeze uses generation 0, original source digest/revision, the explicit mode,
project/prefix/plan digest, and exactly empty `selectedIds`, `deferredIds` and
`heldClaimIds`. Under the existing action-store lock and maintenance barrier,
the engine checks zero total records, edges and active/uncertain project leases.
Uncertain means an active lease with an invalid expiration, or a lease with an
unknown status; attribution includes terminal project actions. Any project
history, even without a lease, refuses this mode. Outstanding or uncertain
maintenance writes refuse publication. Success persists phase `frozen`,
generation 1 and the original source evidence. The ordinary writer fence applies
even though there is no action ID to invalidate: future creates and moves into
the project resolve its authority in StateKV before writing.

Commit uses generation 1, the same mode/plan digest, a receipt digest and mapping
`[]`. No `deferredTrackingId` is accepted, including null. The source inventory
is checked again under the existing lock/barrier. Identical freeze and commit
replays retain the original global source revision while allowing unrelated
project activity, compare project custody again and add no audit transition.
Malformed stored controls reject reads and historical writers. No rollback or
unfreeze operation is added.

The paired AWC importer owns canonical native store provenance, empty native
inventory, durable backup qualification and fsynced receipt publication. Its
separate `freeze` command permits the required native iii persistence and
ordered restart/readback gate before commit. The engine does not trust an empty
mapping as a native storage or backup receipt and does not contact Beads.

Run `npm test` and `npx tsc --noEmit`. The marker-gated isolated fixture accepts
`scenario: empty-project-first-admission/v1` and starts with no actions. Tests
cover freeze/commit, restart/replay, terminal history, drift, malformed controls,
concurrent writers, refused old clients and unchanged nonempty/defer-all modes.
Fixture file persistence does not qualify the deployed iii adapter. Follow
[the native activation and backup gates](work-authority-cutover.md) with paired
engine/importer/Shell versions; never downgrade a fenced production engine.
