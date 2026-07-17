# Actions v2: Canonical Tasks, Readiness Views, and Auditable Migration

Status: implementation approved; live deployment is out of scope

## Goal

Make AgentMemory actions a reliable cross-agent task system without breaking
the existing REST, MCP, `todo` CLI, import/export, lease, checkpoint, sentinel,
routine, sketch, or mesh consumers.

Actions v2 must:

- store a canonical project identity instead of relying on paths or tags;
- represent ownership, scheduling, human approval, blocking, and worktree
  context as typed fields;
- separate lifecycle from derived readiness;
- record append-only, actor-attributed lifecycle, result, correction, and
  migration events;
- expose actionable, scheduled, waiting, and blocked views;
- make paginated action reads fail closed when the collection changes;
- migrate legacy rows idempotently without deleting or silently reassigning
  data;
- retain the v1 wire shape long enough for existing clients to keep working.

## Current Evidence

The live workstation store contained 307 actions when this design was written:

- 106 actions stored `tags` as a comma-separated string even though the TypeScript
  interface requires `string[]`;
- three actions used an absolute repository path as `project`;
- one action had no project;
- 64 actions encoded worktree context only in tags;
- scheduling and human-approval state were also tag conventions;
- `blocked` currently mixes manual blocking, dependencies, checkpoints, and
  human waiting in one lifecycle value;
- offset pagination has no revision guard, so concurrent changes can reorder
  pages and produce an incomplete export.

## Non-goals

- Replacing iii-engine or bypassing its StateModule.
- Converting all AgentMemory data to event sourcing.
- Removing v1 fields or endpoints in this change.
- Changing the meaning of existing action IDs.
- Automatically deploying or migrating the workstation store.
- Reading the workstation project registry from a hard-coded local path inside
  the portable AgentMemory package.

## Considered Designs

### Full event sourcing

Events become authoritative and every action is replayed into a projection.
This gives the cleanest history, but iii's KV surface has no cross-key
transaction, every existing reader would need conversion, and recovery would
become a prerequisite for ordinary reads. The migration risk is too high.

### Parallel v1 and v2 stores

Write both `mem:actions` and a new v2 store. Rollback is simple, but dual writes
create two sources of truth and require permanent drift detection. This is not
acceptable for the single-copy coordination queue.

### Additive v2 projection plus append-only events

Keep `mem:actions` as the authoritative projection, add typed v2 fields, add an
immutable action-event scope, and add a collection revision. Existing clients
continue reading v1 fields; new readers use lifecycle and readiness views.
This is the selected design.

## Data Model

The existing `Action` interface remains readable. V2 fields are optional at the
TypeScript boundary so old exports can be imported, but every newly normalized
or created action persists all required v2 fields.

```ts
type ActionLifecycle = "pending" | "active" | "done" | "cancelled";

type ActionReadinessView =
  | "actionable"
  | "scheduled"
  | "waiting"
  | "blocked"
  | "completed"
  | "cancelled";

type ActionApprovalState =
  | "not_required"
  | "pending"
  | "approved"
  | "rejected";

interface ActionApproval {
  state: ActionApprovalState;
  requestedAt?: string;
  requestedBy?: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
}

interface ActionV2Fields {
  schemaVersion: 2;
  revision: number;
  lifecycle: ActionLifecycle;
  projectId: string;
  projectAliases: string[];
  owner?: string;
  notBefore?: string;
  dueAt?: string;
  awaitingHuman: boolean;
  approval?: ActionApproval;
  blockedReason?: string;
  repoRoot?: string;
  worktree?: string;
  branch?: string;
  taskSlug?: string;
}
```

The legacy fields remain projections:

- `project` mirrors `projectId`;
- `assignedTo` describes the current active worker or lease holder, while
  `owner` is durable responsibility;
- `status` remains `pending | active | done | blocked | cancelled` for old
  clients;
- `tags` remains present but is always normalized to a deduplicated array;
- `result` remains the current result projection while result events preserve
  prior values.

The canonical lifecycle never contains `blocked`. For compatibility, the
legacy `status` is `blocked` when a pending action has an explicit manual block
or is awaiting a human decision. Dependency and checkpoint code may continue
updating the legacy projection during the compatibility window, but readiness
is always recomputed from typed state and edges.

## Canonical Project Identity

Project selection uses this precedence:

1. an explicit valid `projectId`;
2. an explicit migration alias map entry for the legacy `project` value;
3. a valid non-path legacy `project` value, because this is the authoritative
   queue scope used by existing `memory_next` and `todo` callers;
4. one unambiguous `projectId:<id>` legacy tag when the action has no
   authoritative queue scope;
5. the final path segment of an absolute legacy repository path, recorded as an
   inferred mapping and preserved in `projectAliases`;
6. the caller-supplied migration fallback, defaulting to `workstation` only for
   genuinely unscoped rows.

Canonical IDs must be non-empty, must not be absolute paths, and may contain
letters, numbers, dots, underscores, and hyphens. All prior path/name values
are retained in `projectAliases`. The migration reports explicit, inferred,
defaulted, and conflicting mappings separately so rollout can stop on an
unexpected inference.

Existing cross-repo actions may legitimately carry multiple `projectId:<id>`
tags as repository context while their `project` is an initiative queue. When
an authoritative project is present, those tags are retained as context and
reported as warnings rather than treated as competing identities. Ambiguous or
invalid project tags remain hard conflicts only when the row has no
authoritative project from which to migrate.

New v2 callers should send `projectId`. Legacy callers may continue sending
`project`; the normalizer produces the same persisted v2 shape and includes
normalization warnings in the result when inference was necessary.

## Typed Context Migration

Legacy tags are retained and parsed into first-class fields when the target
field is absent:

- `projectId:<id>` -> `projectId`;
- `agent:<id>` -> `owner` when no explicit owner or assignee exists;
- `due:<ISO timestamp>` -> `dueAt`;
- `not-before:<ISO timestamp>` -> `notBefore`;
- `worktree:<value>` -> `worktree`;
- `branch:<value>` -> `branch`;
- `task_slug:<value>` or `task-slug:<value>` -> `taskSlug`;
- `requires-confirmation`, `awaiting-human`, or `approval-required` ->
  `awaitingHuman=true` and a pending approval.

Invalid timestamps are preserved in tags and reported; they are not copied to
typed fields. If a legacy blocked action has unresolved `requires` or
`gated_by` edges, its block remains derived. If it is waiting for approval, it
becomes `waiting`. Otherwise it receives `blockedReason="Legacy blocked state"`
so no manual block disappears.

## Append-only Events and Collection Revision

`mem:action-events` stores immutable `ActionEvent` rows:

```ts
type ActionEventType =
  | "created"
  | "fields_changed"
  | "lifecycle_changed"
  | "result_recorded"
  | "corrected"
  | "migrated"
  | "deleted"
  | "edge_created"
  | "edge_deleted";

interface ActionEvent {
  schemaVersion: 2;
  id: string;
  actionId: string;
  revision: number;
  type: ActionEventType;
  actor: string;
  timestamp: string;
  reason?: string;
  correctionOf?: string;
  before?: Action | ActionEdge;
  after?: Action | ActionEdge;
}
```

There is no event update/delete API. Corrections append a `corrected` event and
identify the corrected event when known. The action projection changes to the
correct value; the original event remains.

`mem:action-state/current` stores:

```ts
interface ActionCollectionState {
  schemaVersion: 2;
  revision: number;
  updatedAt: string;
  pending?: { revision: number; eventId: string };
}
```

All action/edge projection writes use one keyed action-store lock and this
recoverable sequence:

1. write `pending` with the next revision and event ID;
2. append the event containing the post-image;
3. write or delete the projection;
4. commit the collection revision and clear `pending`.

If the worker stops mid-write, the next action-store operation reconciles the
pending marker. An existing event is replayed into the projection; a marker
without an event is cleared without advancing the revision. Normal reads never
observe intermediate writes because they use the same in-process lock.

Secondary action writers supply the projection they read as an optimistic base.
The store rebases non-overlapping field changes onto the current projection and
rejects same-field races with `action_revision_conflict`. This keeps checkpoint,
lease, sketch, routine, mesh, crystallization, and healing updates from silently
overwriting a concurrent action change even when their larger workflows use
different entity locks.

The existing audit log remains. Action events are the domain history; audit
entries remain the system-wide operational record.

## Readiness Views

Readiness is derived at read time in this precedence order:

1. lifecycle `done` -> `completed`;
2. lifecycle `cancelled` -> `cancelled`;
3. explicit `blockedReason`, rejected approval, unsatisfied `requires`, failed
   or pending checkpoint/sentinel `gated_by`, an active conflict, or an unavailable lease ->
   `blocked`;
4. `awaitingHuman` or pending approval -> `waiting`;
5. future `notBefore` -> `scheduled`;
6. otherwise -> `actionable`.

Each computed item includes structured blockers rather than only display
strings. `memory_frontier` remains the actionable view and excludes leases held
by other agents unless requested. `memory_next` remains the highest-ranked
actionable item.

`dueAt` does not block readiness. It adds a bounded urgency component to the
existing priority/age score. Invalid or past `notBefore` values never crash a
read; invalid persisted values are reported as blockers until corrected.

## API and MCP Compatibility

Existing names, required arguments, response fields, and status values remain
valid.

Additive changes:

- action create accepts `projectId`, `projectAliases`, `owner`, `notBefore`,
  `dueAt`, `awaitingHuman`, `approval`, `blockedReason`, `repoRoot`, `worktree`,
  `branch`, `taskSlug`, and `actor`;
- action update accepts the same mutable fields plus `lifecycle`, `actor`,
  `correctionOf`, and `correctionReason`;
- action list accepts `view`, `owner`, `cursor`, and `revision` and returns
  `revision`, `nextCursor`, and computed view entries while retaining
  `actions`, `total`, `limit`, `offset`, and `hasMore`;
- a new `memory_action_list` MCP tool exposes the same bounded views;
- frontier items gain additive `view` and structured blocker data;
- REST handlers explicitly whitelist every forwarded field.

Legacy `status="blocked"` updates create or retain a manual block. A later
legacy `status="pending"` clears only that manual block; it does not approve a
pending human decision or bypass dependencies/checkpoints.

## Revision-bound Pagination

Action pages are sorted deterministically by `updatedAt DESC, id ASC`.

The first page returns the collection `revision` and an opaque cursor encoding
the revision, offset, and a fingerprint of the filters. Subsequent requests
must either pass that cursor or the same explicit revision. A changed
collection, modified filter, malformed cursor, or mismatched revision returns
a typed `revision_conflict`/`invalid_cursor` failure instead of a partial page.

Offset-only calls remain supported for old clients but are not advertised as a
complete snapshot mechanism.

Checkpoint and sentinel transitions re-project their linked actions and append
an action event. This advances the same collection revision used by cursors, so
a gate changing between pages fails closed instead of silently changing the
derived readiness set.

## Export and Import

`ExportData` gains optional `actionEvents` and `actionSnapshot` fields. Action,
edge, event, and state reads occur under the action-store lock, so one export
contains a self-consistent action revision.

Old exports without v2 fields still import. Imported actions are normalized
before persistence. Imported event IDs are deduplicated. A replace import also
replaces action events/state; a merge import appends non-conflicting events and
advances the local collection revision. Existing import safety limits gain
bounded action/event limits.

An export reports action count, edge count, event count, schema version, and
revision. Import validates those counts when snapshot metadata is present and
fails before mutation on mismatch.

## Migration

`POST /agentmemory/migrate` gains `step="actions-v2"` with whitelisted fields:

- `dryRun` (default true);
- `projectAliases` mapping legacy values to canonical IDs;
- `defaultProjectId` (default `workstation`);
- `limit` and opaque `cursor` for bounded batches.

The migration:

1. reads a deterministic page of actions;
2. normalizes tags and typed context;
3. resolves project identity and reports conflicts/inferences;
4. derives lifecycle without removing the legacy status;
5. appends one `migrated` event per changed action;
6. writes the v2 projection and collection revision;
7. returns counts, warnings, unresolved rows, revision, and next cursor.

It skips already-normalized actions, making retries idempotent. Dry-run performs
no KV writes, events, audit writes, or revision changes. A non-dry batch stops
before mutation if any row has an invalid explicit canonical project ID or
conflicting explicit identities. Inferred/defaulted mappings are warnings and
remain reviewable in the result and event.

## Failure Handling

- Boundary validation rejects invalid lifecycle/status values, priorities,
  approval combinations, project IDs, and timestamps.
- No raw REST request body is forwarded to an internal function.
- Migration errors identify action IDs but do not include secrets or full
  descriptions/results.
- Event/state recovery is idempotent and runs before action-store mutations or
  revision-bound reads.
- Existing v1 rows are normalized on read for classification, but only the
  explicit migration or a mutation persists v2 fields.
- No live migration is implicit at process startup.

## Rollout Plan

1. Merge code and documentation with all tests passing.
2. Build a package from the exact merge commit; do not install it yet.
3. Export and stop-backup the live store.
4. Run `actions-v2` dry-run with aliases sourced by deployment tooling from the
   external workspace project registry.
5. Review conflicts, inferred mappings, counts, and projected revision.
6. Install the package and restart only with explicit deployment approval.
7. Run bounded migration batches, verifying counts and revision after each.
8. Exercise old REST/MCP/CLI calls and new views against the migrated store.
9. Keep v1 fields for at least one release before considering deprecation.

## Acceptance Criteria

- Existing action, frontier, next, lease, export/import, checkpoint, sentinel,
  routine, sketch, crystallize, mesh, diagnostics, and MCP tests still pass.
- New creates persist a complete v2 projection while old create inputs work.
- String/list tags normalize without losing tokens.
- Path aliases, tag project IDs, and unscoped rows migrate deterministically and
  are reported by category.
- Dry-run is byte-for-byte non-mutating and repeated migration is idempotent.
- Every lifecycle, result, correction, and migration change appends an event
  with actor and timestamp.
- Manual blocks, dependencies, approvals, schedules, leases, and terminal
  lifecycle states land in the correct readiness view.
- A collection change between pages produces a revision conflict rather than
  an incomplete export.
- Export action counts/events/revision are internally consistent; old exports
  remain importable.
- No test or migration path touches the workstation live data store.
