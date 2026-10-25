# Zero-selected, all-deferred cutover contract

This is source-only support for an explicitly reviewed cutover with no selected
work. The existing nonempty `work-authority/v1` import remains unchanged.
An empty selection without the exact opt-in is still invalid. No source action
is edited, reopened, assigned, deleted or made runnable by either transition.
The control record records dispositions; the source status and owner remain
historical evidence.

The engine and workspace importer agree on the literal field and value:

```json
{"selectionMode":"zero-selected-defer-all/v1"}
```

The opt-in is required on freeze, commit and every replay, and persisted in the
authority, importer plan and importer receipt. Unknown versions, missing mode
on a zero-mode authority, and switching a nonempty import to zero mode fail
closed. The authenticated REST whitelist forwards `selectionMode` and
`sourceRevision`; no endpoint, MCP tool, scope or authority protocol is added.

## Freeze

The request contains these fields (angle-bracket values are placeholders):

```json
{
  "protocol": "work-authority/v1",
  "operation": "freeze",
  "projectId": "workstation-shell",
  "prefix": "wsh",
  "generation": 0,
  "planDigest": "<64 lowercase hex characters>",
  "selectionMode": "zero-selected-defer-all/v1",
  "sourceDigest": "<exact snapshot sourceDigest>",
  "sourceRevision": 0,
  "selectedIds": [],
  "deferredIds": ["<every open source action ID, sorted and unique>"],
  "heldClaimIds": ["<every active or historically assigned source ID, sorted and unique>"],
  "actor": "work-importer"
}
```

`sourceRevision` is the reviewed snapshot revision, not the literal example
value. Initial freeze requires absent authority (`agentmemory`, generation 0),
an exact source digest and revision, and zero active project leases, including
leases on closed history. Active leases with invalid expiration and leases with
unknown status also prevent zero-mode transitions. Expired/released leases are
preserved. An outstanding or uncertain maintenance writer prevents publication.

`deferredIds` must contain every open source ID exactly once (1–1000 entries).
`heldClaimIds` is mandatory even when empty and must exactly match all source
rows whose status is active or whose `assignedTo` is set. Every held claim must
be deferred. Source gates and dependencies are permitted because nothing is
selected. The engine publishes phase `frozen`, generation 1, retaining the
original plan fingerprint, source digest/revision, prefix and complete scope.

The caller computes `planDigest` using the existing importer fingerprint:
SHA-256 of UTF-8 `json.dumps(plan, sort_keys=True, separators=(",", ":"))`.
The complete zero-mode plan includes `selectionMode`, reviewed source revision,
source digest, all deferred metadata and held claims. The engine accepts an
opaque plan fingerprint; it does not receive or independently hash the full
importer plan. The importer validates the plan and native receipt contents.

## Commit

```json
{
  "protocol": "work-authority/v1",
  "operation": "commit",
  "projectId": "workstation-shell",
  "generation": 1,
  "planDigest": "<the identical reviewed plan fingerprint>",
  "selectionMode": "zero-selected-defer-all/v1",
  "receiptDigest": "<fingerprint of the complete importer receipt>",
  "mapping": [],
  "deferredTrackingId": "wsh-<native triage bead ID suffix>",
  "actor": "work-importer"
}
```

Commit requires the existing frozen generation and fingerprint, an empty
mapping, a valid receipt digest, and a triage ID using the frozen prefix.
Before publication it rechecks the source digest, complete deferred IDs, exact
held claims and absence of leases under the action lock and maintenance barrier.
Success retains generation 1 and changes phase to `beads`. It grants no selected
work. The importer owns native Beads reconciliation, triage deferral, receipt
validation and refusal of admission in this mode; the engine does not query
Beads or launch workers.

## Replay and failure

Replay freeze with its original generation **0**, original source revision and
the identical mode, fingerprint, prefix, digest, deferred IDs and held claims.
Replay commit with generation **1** and the identical receipt digest, mapping
and triage ID. Both recheck source/claims/leases before returning the existing
record. Unrelated projects may advance the global action-store revision after
freeze; replay retains the original revision and compares the project digest.
Replays add no audit entries and cannot rewrite or reopen authority.

Malformed stored zero-mode scope or receipts reject reads/transitions and
prevent historical writes. Source drift or conflicting receipts keep the fence
in place. A failed/uncertain storage write requires reconciliation; a synthetic
restart test demonstrates replay against the retained store, not crash
durability of the native iii file adapter. The existing native backup,
persistence and activation gates in [work-authority-cutover.md](work-authority-cutover.md)
still apply. No rollback or unfreeze operation is introduced.

## Synthetic verification

`test/fixtures/work-authority-defer-all.json` contains 15 fixed synthetic
`workstation-shell` records, including two historical assignments and one human
wait. It contains no live records. The marker-gated fixture uses a random literal
loopback port and an isolated file store:

```json
{
  "purpose": "isolated-work-authority-test",
  "root": "<realpath of a new temporary directory>",
  "scenario": "zero-selected-defer-all/v1"
}
```

Save the marker as `authority-fixture.json` in that directory, then run
`node --import tsx scripts/work-authority-fixture.ts <directory>` from this
worktree. Read its `endpoint.json` for the fixture URL. Omitting `scenario`
retains the original three-record nonempty importer fixture. No service unit
or deployed engine participates.

`npm test -- test/work-authority.test.ts test/work-authority-fixture.test.ts`
checks source custody, empty runnable views, guarded writes, exact fingerprints,
phase/generation, malformed input, leases, claim/scope/source drift, receipt
conflicts, concurrent/uncertain writes, authenticated REST whitelisting and
process restart replay. The original nonempty tests remain in the same run.
