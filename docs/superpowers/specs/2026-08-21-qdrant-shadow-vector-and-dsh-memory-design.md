# Qdrant Shadow Vector and DSH Memory Design

Date: 2026-08-21

Status: implementation contract

## Objective

Exercise an external vector implementation under real AgentMemory traffic without
making it authoritative, and give DeepSeek Harness (DSH) a compact, read-only
institutional-memory surface. `LocalVectorStore`, AgentMemory KV, BM25, graph
retrieval, hybrid fusion, and the existing retrieval policy remain authoritative.

## Approaches considered

### A. In-process composite shadow store (selected)

Wrap `LocalVectorStore` in a `ShadowVectorStore`. Every primary operation happens
locally first. Mutations are mirrored asynchronously to a dedicated Qdrant
collection, and a configurable sample of searches is replayed against Qdrant for
aggregate comparison. AgentMemory always returns the local result.

This exercises the existing `VectorStore` boundary, real mutation cadence, restore
behavior, filters, and concurrency while preserving one failure domain for serving
results.

### B. Offline/sidecar reconciliation only

Periodically export the local snapshot and benchmark it in a separate process.
This is operationally safest, but it does not exercise the live abstraction,
mutation ordering, outage behavior, or query mix. The existing Qdrant benchmark
already covers most of this approach.

### C. Selectable authoritative Qdrant backend

Allow an environment variable to replace local search with Qdrant. This gives the
strongest production signal but prematurely introduces a network dependency and a
second durability authority before the decision gate has been met.

Approach A gives useful evidence with the smallest authority change.

## Authority and behavior invariants

- `LocalVectorStore.search()` is the only result returned to `HybridSearch`.
- AgentMemory's existing vector snapshot format remains unchanged.
- A Qdrant timeout, malformed response, dimension mismatch, reset, or outage must
  not fail a memory write, deletion, startup, or search.
- BM25 and graph retrieval are unchanged. Hydration and authorization remain the
  final guard for every retrieval stream.
- The shadow collection is derived data. It may be dropped and deterministically
  rebuilt from the local snapshot and authoritative KV metadata.
- Shadow mode is off by default. Enabling it does not make it eligible to serve
  results.
- Diagnostics contain counts, timings, state, and aggregate overlap only. They do
  not retain query text, vector values, result IDs, secrets, or memory content.

## Components

### `QdrantVectorStore`

An HTTP implementation of `VectorStore` with no new package dependency. It uses
deterministic UUIDs derived from observation IDs, cosine distance, stable
score/observation-ID ordering, bounded responses and timeouts, batch upsert/delete,
and payload filters for canonical repository, project, mission, agent, and latest
status. Collection names are restricted to `agentmemory_shadow_*`. Non-loopback
URLs require an explicit opt-in; credentials over remote plaintext HTTP are
rejected.

### `ShadowVectorStore`

Implements `PersistableLocalVectorStore` and delegates serialization, restore,
dimension validation, size, and all primary mutations/searches to the local store.
Remote mutations are coalesced in a bounded queue. Queue overflow or a remote
failure marks the mirror as needing reconciliation but cannot affect local state.

During reconciliation, the wrapper first marks itself reconciling, discards queued
mutations already represented by a fresh local snapshot, resets only the dedicated
shadow collection, and populates that snapshot in batches. Mutations arriving after
the snapshot are queued and replayed before the mirror becomes healthy. A failed
reconciliation remains visible as degraded and retryable.

A sampled search records remote latency and top-K overlap. The local result returns
before the remote request completes. Explicit comparison methods are available to
tests and benchmarks; they are not used by serving retrieval.

### Metadata resolution

Local vector snapshots retain their compatible v1 shape. For shadow writes and
reconciliation, a resolver hydrates the source memory/observation from KV and emits
only bounded filter/provenance fields: project, canonical repository, mission,
agent, memory type, latest status, attribution status, and files. Legacy entries
without resolvable metadata remain searchable and are marked unattributed rather
than guessed.

### Configuration

Shadowing activates only with `AGENTMEMORY_VECTOR_SHADOW=qdrant`. Configuration
includes endpoint, dedicated collection, timeout, sample rate, mutation queue
bound, and reconciliation batch size. Missing or invalid opt-in configuration
leaves the local store active and reports a degraded `vectorShadow` diagnostic.

The health response reports the local authority, mirror state, pending mutations,
sample/search/upsert failure counts, aggregate overlap, last success/failure, and
whether reconciliation is required.

## DSH least-privilege retrieval

DSH receives a separate stdio AgentMemory MCP child configured with:

- `AGENTMEMORY_FORCE_PROXY=1`;
- `AGENTMEMORY_TOOLS=memory_smart_search`;
- `AGENT_ID=dsh` and shared agent scope;
- LLM-backed AgentMemory tools disabled.

The standalone proxy must intersect the remote server's tool list with the client
allowlist and reject calls to hidden tools before forwarding. With force-proxy set,
a failed remote call must not fall back to the shim's per-process KV. This makes
the capability genuinely search-only rather than merely hiding mutation tools from
discovery.

The DSH workflow uses progressive disclosure:

1. call `memory_smart_search` with a query and current repo/mission context, compact
   format, and a bounded limit;
2. inspect compact provenance and select at most a small number of IDs;
3. call the same tool with `expandIds` for only those IDs;
4. use workstation-shell's existing MCP bridge for any brokered agent action.

DSH does not receive internal KV access, a new launch path, or authority to deploy,
close, or mutate sessions. Workstation-shell remains the sole launch/session
authority.

## Failure and recovery tests

- exact local search and snapshot bytes remain compatible;
- Qdrant creates/attaches only a valid dedicated collection and rejects dimensions;
- deterministic IDs make repeated upserts idempotent;
- remote add/remove/search/clear failures leave local behavior unchanged;
- sampled shadow search never delays the returned local result;
- startup reconciliation replaces stale/missing points and replays concurrent
  mutations;
- queue overflow is bounded and marks `needsReconcile`;
- payload filters and deterministic result ties behave consistently;
- proxy discovery exposes exactly `memory_smart_search` for the DSH allowlist;
- hidden proxy calls are rejected without an upstream request;
- force-proxy outages fail closed instead of reading/writing local shim state;
- a DSH fixture performs compact search followed by selective expansion, while the
  existing workstation-shell orchestration authority and tool profiles are
  unchanged.

## Activation gate

Code merge does not enable shadow mode. A loopback-only Qdrant service may be
activated separately using a digest-pinned image and a dedicated collection after
local/full tests pass. Initial activation must verify:

- AgentMemory health remains healthy with `authority: local`;
- forced Qdrant outage leaves search and writes healthy while diagnostics degrade;
- restart/reconciliation converges point counts without changing local snapshots;
- sampled overlap and remote latency are recorded for a meaningful workload.

Only sustained measurements that show a material local latency, memory, restore,
filtering, or concurrency limit can reopen the external-authority decision. Until
then the decision remains `KEEP_LOCAL_VECTOR_STORE`.
