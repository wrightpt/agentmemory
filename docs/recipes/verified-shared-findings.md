# Verified shared findings

Shared findings are task-scoped causal lessons for coding, data qualification,
and procedures. They reuse AgentMemory's lesson store, immutable evidence
records, audit records, and lesson correction path. They do not claim tasks or
replace Beads, orchestrate workers, or register research verdicts.

The worker interface is `npm run findings -- <command>` from a source checkout.
It makes one bounded POST to `/agentmemory/findings/{command}` through the
existing AgentMemory REST service. The commands are `prepare`, `publish`,
`snapshot`, `expand`, and `correct`. This change requires separately reviewed
service/package activation; running the CLI against an older service fails.

## Identity and policy

Every call requires `AGENTMEMORY_CALLER_TOKEN` in the worker's environment. If
the service uses bearer authentication, also provide `AGENTMEMORY_SECRET` in
the environment through the existing credential mechanism. Neither credential
is accepted as a CLI argument or written to output. Errors expose a bounded
code and HTTP status, never server error text. The adapter does not send a
caller-selected actor ID; the caller token identifies the server-policy
principal. Distinct actor strings are not reviewer independence.

The server requires two operator-managed policies:

- `AGENTMEMORY_LESSON_CALLER_POLICY_FILE`: the existing caller policy binds
  token digests to principal IDs, durable lesson scopes, and sensitivity
  clearance. Findings enforce this policy even when ordinary lesson access
  remains in compatibility `classify` mode.
- `AGENTMEMORY_FINDINGS_POLICY_FILE`: an absolute JSON file with `version: 1`,
  `grants`, `sources`, and `reviewers`. A grant binds a principal to the exact
  project, task ID, role, phase, and `publish` capability. Reviewer entries
  bind approved principal IDs to Ed25519 public keys. Provisioning either
  policy is a separate operator action; this PR does not change live policy.

A finding source is explicitly registered with a project/task, durable lesson
scope, sensitivity, phase visibility, durable URI, revision, and SHA-256 of
its exact UTF-8 bytes. A `git` location supplies an absolute repository path,
a relative file path, and a full commit hash. An `artifact` location supplies
an absolute file path plus the pinned revision and digest. A durable
`research-ontology` reference can be represented by an operator-approved
artifact and URI; the adapter does not crawl a registry or infer access from
a supplied URI. Only registered local source locations are read. A URI alone
does not verify a claim.

`FindingPolicy`, `FindingProposal`, and the source types are defined in
[`src/findings/types.ts`](../../src/findings/types.ts). Unregistered sources,
changed bytes, source hash/span mismatches, absent policies, and unsupported
checks fail closed. Inputs are limited to four sources; each complete source
is at most 64 KiB and each exact supporting quote at most 8 KiB.

## Admission and independent review

`prepare` validates and binds the requested claim and evidence for review. It
returns `admitted: false`; it does not publish a lesson. `publish` re-reads the
registered sources and reruns admission before making a finding visible.

The built-in deterministic verifier admits only these narrow statements:

- `exact-quote`: `Source <id> lines <start>-<end> contains <JSON-quoted quote>.`
- `json-pointer-equals`: `Source <id> JSON pointer <JSON-quoted pointer> equals <JSON scalar>.`

Both require the sole applicability condition
`Only the cited source revision and supporting lines.` They establish source
content, not that a broader conclusion or a trading edge follows. The JSON
check requires the complete document as its supporting slice, rejects
ambiguous duplicate keys and numeric representations, and compares the
requested scalar exactly.

A narrative finding requires an independently reviewed, Ed25519-signed
`review` with the exact `claimHash`, `bindingHash`, and `evidenceHash` from
`prepare`. The author cannot be the reviewer. A trusted reviewer's signature
authenticates who accepted support; it is not a mathematical proof of the
claim. The reviewer must inspect the full applicability and source evidence,
record a rationale, and sign the payload produced by `reviewSigningPayload`
in [`evidence.ts`](../../src/findings/evidence.ts). The signature covers
reviewer ID, all three hashes, review time, verdict, and rationale. Only
`supported` admits a finding; altered claims, evidence, applicability, or
author identity invalidate the binding. The worker CLI deliberately offers
no automatic review/sign command or self-asserted `verified` flag.

## Worker use

Credentials are supplied through the environment. The default URL is
`http://127.0.0.1:3111`; `--url` accepts an explicit HTTPS origin or loopback
HTTP origin. Redirects, URL credentials, query strings, and URL path prefixes
are rejected. JSON requests come from stdin or `--input request.json`.

For example, a registered coding worker can read a compact view with:

```sh
npm run --silent findings -- snapshot <<'JSON'
{"view":{"project":"agentmemory","taskId":"example-task","role":"worker","phase":"coding"},"limit":8,"maxBytes":8192}
JSON
```

The response includes `snapshot.id`, `snapshot.hash`, compact entries,
explicit `unavailable` entries, and `truncated`. The same principal can send
the returned `snapshotId` with the same view to reread that frozen snapshot.
The ID and hash are bound to principal, view, policy, and selected entries;
two workers can reuse identical findings while having different snapshot
IDs. Snapshots are immutable and checked against current authority and
evidence. A policy change, correction, retraction, or evidence mutation can
make an earlier snapshot unusable; it cannot silently change its contents.

Use the returned IDs to expand one finding:

```json
{
  "view": {"project":"agentmemory","taskId":"example-task","role":"worker","phase":"coding"},
  "snapshotId": "<returned snapshot ID>",
  "lessonId": "<entry lesson ID>",
  "level": "evidence"
}
```

Pass that JSON to `npm run --silent findings -- expand --input request.json`.
Evidence expansion includes the supporting slice, durable reference,
verification record, and lifecycle. `level: "raw"` expands a source with
optional `sourceIndex`, `offset`, and `maxChars` (at most 8192). Follow
`nextOffset` only when more source text is required. Evidence/source text is
marked `untrustedData: true`; render it as quoted data, never as instructions
or executable commands. Permission, phase, sensitivity, source hashes, and
lifecycle are rechecked at each expansion.

Snapshot selection is limited to 32 entries and a 4096–65536 byte response
budget. The adapter independently caps serialized requests at 256 KiB,
responses at 512 KiB, and each HTTP call at ten seconds. Response accounting
reports exact UTF-8 bytes for the indicated serialized payload and estimated
tokens; token estimates are not provider tokenizer usage or billing.

`correct` accepts the same view, `lessonId`, `reason`, and optional
`expectedUpdatedAt`. Without a replacement it retracts through the existing
lesson correction function; `replacementLessonId` supersedes instead. Pass
the `updatedAt` from publication/evidence expansion to detect a concurrent
correction. Publication writes and rereads evidence before the lesson becomes
visible. Repeating an identical claim, check, applicability, and evidence
deduplicates across authorized authors while retaining the original admission
and its author-bound review. Correction and publication share the authoritative lesson
mutation lock. This is a single service-owner guarantee: run one AgentMemory
writer process. It does not provide distributed multi-process transactions or
a distributed lock.

## Research result boundaries

Shared findings are opt-in and excluded from ordinary lesson/context recall,
search-derived context, crystals, and exports. Ordinary lessons retain their
existing behavior. Generator/refiner views require `phase: "pre-outcome"`
and an explicit grant, and can only see explicitly registered pre-outcome
sources. Post-freeze evaluation material requires an appropriate explicitly
granted post-freeze role. A client-selected role or phase grants no access.

This implementation does not modify Research Town packets, launch research,
call models, or expose a live research registry. A future approved packet
integration must consume an authorized pre-outcome snapshot, freeze its
serialized bytes/hash with the packet, and preserve the tool-less generation
and refinement lane. Do not add default recall or raw expansion tools to that
lane. Evaluation outcomes remain official research-ontology evidence.

## Reproducible bounded pilot

Run `npm run --silent findings:pilot`. It creates only a temporary source
fixture and loopback HTTP listener, exercises the production findings API and
registered functions through the production `StateKV` interface, emits one
JSON report, and removes the fixture. The `state::*` handlers are explicitly
in-memory engine mocks for this pilot, never a production persistence
alternative. No live service endpoint, account, model, research loop, or
nightly epoch is touched.

The fixed tasks inspect a coding retry constant and a data-quality receipt.
Two distinct authenticated workers consume the same admitted findings. The
pilot checks deterministic admission, independent signed narrative admission,
fabricated and self-reviewed rejection, repeat publication, frozen snapshot
reads, evidence/raw expansion, and correction invalidation. Its counters
count fixture operations and programmed reuse only. Serialized HTTP request
and response bytes are exact; tokens use an explicitly labeled estimate.
No empirical LLM quality, latency, cost, alpha, or token-billing improvement is
claimed. The fixture does not prove iii WebSocket transport, file-adapter
durability, crash recovery, or production activation.

A successful report contains two shared finding IDs across two distinct
principal-bound snapshots, two consumer reuse events, two programmed fixture
task skips, two deduplicated repeat publications, and one independently
signed narrative admission. Snapshot IDs/hashes change between executions
because the fixture's temporary locations and reviewer keys are new; the
fixed-task assertions and operation accounting remain reproducible.

## Operational limits

Source policies support `worktree`, `repo`, `initiative`, and `domain` lesson
scopes with explicit IDs; global publication is unsupported. Every finding is
also bound to one project and task. Source classification applies to the
**entire raw file**, not only the supporting lines. A file mixing pre-outcome
knowledge and evaluation outcomes must be post-freeze or replaced by a
separately approved pre-outcome artifact. Registry operators and reviewer key
custodians are trusted; the system cannot independently infer whether their
classification or support judgment is correct.

The supported deployment has one iii-connected AgentMemory writer process.
Evidence references must already name retained, pinned source bytes. StateKV
writes are acknowledged and reread in evidence-before-lesson order, but the
iii file adapter's asynchronous flush is not an fsync transaction across
scopes. A partial restore or crash that loses a backing record causes
snapshot/expansion to fail closed; this pilot does not test engine crash
persistence. Preserve source artifacts and all three lesson scopes together
when backing up. Generic lesson export omits shared findings and their
supporting scopes, and generic replacement import cannot overwrite them.
The new immutable snapshot/evidence records have no automatic expiry or
garbage collector. Snapshot creation scans the existing lesson store, admits
at most 32 candidates per request, and refuses scopes exceeding 512 findings;
this is a bounded worker notebook, not a large-corpus retrieval service.

Findings responses carry `findingSurface: "verified-shared-findings-v1"`.
Automatic observation capture skips marked payloads before persistence or
indexing. Replay skips an entire marked transcript before extracting prompts,
observations or derived lessons. Marked stored replay content is also denied.
Reserved finding/snapshot IDs and recognized API/CLI commands provide a
conservative fallback when wrapping or truncation loses the explicit field.
This protects the automatic capture path; it is not a data-loss-prevention
system for deliberately unmarked copies, paraphrases, or manually pasted
source content. Workers must preserve the response marker when relaying data
and keep post-freeze material in the approved task/phase channel.
