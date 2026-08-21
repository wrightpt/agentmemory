# Cross-repository institutional memory

## Responsibilities and retrieval architecture

AgentMemory keeps coordination facts and institutional knowledge separate.
Actions, leases, missions, sessions, branches, commits, graph relationships,
and provenance remain structured records. Decisions, discoveries, bug causes,
experiment conclusions, interface contracts, and workflow lessons also
participate in semantic retrieval. Embeddings supplement the structured state;
they never replace it.

The previous retrieval path fused BM25, an exact in-memory cosine index, and
graph retrieval. Repository and agent filters were applied by callers after
that fusion, and the vector implementation was a concrete dependency of the
hybrid searcher.

The current path is:

```text
BM25 ---------+
LocalVectorStore -- reciprocal-rank fusion -- provenance/scope policy -- results
graph --------+
```

`LocalVectorStore` preserves exact cosine search and the existing index
snapshot format. `VectorStore` is the replaceable search boundary. Local
snapshot-specific operations are kept outside the general interface so a
future remote implementation can own its persistence instead of pretending to
serialize into the local KV snapshot.

## Canonical repository identity

`project` remains the stable, backward-compatible project registry key.
`canonicalRepoId` is an additional repository identity used for cross-repo
matching:

- GitHub remotes normalize to lower-case `owner/repository` with `.git` and
  credentials removed.
- Other network remotes normalize the host to lower case while preserving the
  repository path's case.
- Normal checkouts and Git worktrees converge because the Git remote, not the
  working directory basename, establishes identity.
- Repositories without a network remote use an opaque fingerprint of the real
  Git common directory. They are not merged merely because their directories
  share a basename.
- An explicit project manifest remains the authority for `project`; a
  deterministically proven Git remote remains the authority for
  `canonicalRepoId`.

New and updated sessions may record `repoRemote`, `repoRoot`, worktree, branch,
full commit SHA, project aliases, agent, terminal session, parent session, and
mission identity. Each new observation and session-bound durable memory also
captures an immutable attribution snapshot. Retrieval prefers that snapshot,
so a later session update cannot relabel historical work with a new branch,
commit, mission, or repository; the mutable session row is only a legacy-data
fallback. Legacy sessions remain readable. This change performs no automatic
production backfill: an offline migration may fill only fields that can be
derived deterministically from durable evidence.

## Provenance model

Compact retrieval results expose a bounded provenance projection and a flag
indicating whether more provenance is available. Expansion by returned result
ID provides the source observation or durable memory plus full provenance.
Where available, provenance contains:

- project, project aliases, and canonical repository;
- session and agent;
- mission and terminal/parent session;
- repo root, worktree, branch, and commit SHA;
- source files and timestamp;
- observation or memory ID and memory type;
- confidence, importance, lifecycle, and supersession state.

A memory derived from more than one distinct session exposes a deterministic
`sessionIds` list and omits singular `sessionId`; a one-session memory keeps the
legacy singular field. Internal index-routing locators are never presented as
source provenance.

Repository provenance is display and ranking metadata, not authorization.
Authorization is evaluated before BM25/vector/graph rank fusion, graph
expansion, optional reranking, scope boosts, and progressive-disclosure
expansion. Filtered candidate hydration is bounded and cached; shared scope
keeps the original fast path.

## One scope-aware ranking policy

The policy applies to the single fused candidate set; it does not concatenate
separate searches. The base score remains reciprocal-rank fusion over BM25,
vector, and graph channels, followed by optional reranking. The scope policy
then multiplies the fused score:

| Scope | Multiplier | Admission |
| --- | ---: | --- |
| current mission | 1.30 | always |
| current canonical repo/project | 1.18 | always |
| explicitly related repo | 1.08 | `includeRelatedProjects=true` |
| explicit global memory | 0.98 | unless `includeGlobal=false` |
| wider cross-repo | 0.80 | `includeCrossRepo=true` |
| unattributed legacy row | 0.70 | retained for compatibility |

Importance and confidence provide small bounded multipliers. Durable
architecture, bug, workflow, pattern, and preference memories receive a small
quality multiplier; an exact current-file overlap receives a small boost.
Recency is a late tie-breaker, not a multiplier, so an older authoritative
architecture decision is not displaced merely by a newer casual observation.
Superseded durable memories are removed before ranking. Final ties use the
stable source ID.

When both sides have canonical IDs, a conflict cannot be overridden by equal
project basenames. Project aliases are consulted only when canonical evidence
does not conflict. With no repository context, the policy preserves the
existing hybrid order while still labeling the provenance ring accurately.
Related and wider repository recall are explicit so ordinary repo-local recall
does not collapse into a noisy global search.

## Explicit project relationships

Project relationships are directional records identified deterministically by
`sourceRepoId + relationType + targetRepoId`. Each record carries aliases,
provenance, timestamps, and a revision. Repeating the same statement is
idempotent. A material update requires the current `expectedRevision`, which
prevents concurrent writers from silently producing contradictory duplicates.
Import validates canonical identities, deterministic record IDs, timestamps,
provenance, duplicates, and revision monotonicity before a replace can mutate
state. Merge imports are monotonic supersets: a higher revision cannot erase
previous aliases, reason, or provenance records, and the full batch is
preflighted before any relationship or lesson write.

Relationship types are generic lower-case identifiers such as `uses`,
`governed_by`, or `orchestrates`; AgentMemory core does not hard-code workstation
repositories. Ranking may traverse either side of an explicit relationship,
while directional queries retain incoming/outgoing semantics.

## Memory quality

The four states are intentionally distinct:

1. Raw observations are stored.
2. Useful compressed text remains lexically searchable with BM25.
3. Decisions, discoveries, errors, important task/subagent conclusions, and
   high-importance change summaries are semantically indexed.
4. Explicit memories are promoted durable institutional knowledge and remain
   semantic until superseded.

Routine file reads, searches, status notifications, command chatter, and
ordinary conversations remain stored and may remain lexical, but are not
embedded unless their importance crosses a high threshold. Existing stored
observations are not deleted. Git and source search remain authoritative for
exact current code.

## Cross-agent access

The normal workstation shared scope permits attributed knowledge created by
Codex, Kimi, Pi, Claude, OpenCode, or a supervisor to be retrieved by another
agent. `agentId` remains provenance, not a default relevance penalty.

When `AGENTMEMORY_AGENT_SCOPE=isolated`, the existing agent filter remains
fail-closed and is applied to every retrieval channel before fusion, graph
expansion, reranking, scope scoring, and result-ID expansion. An explicit
wildcard remains the existing opt-in shared read; repository ranking does not
grant a new permission or weaken isolation. The reduced local MCP fallback
enforces the same rule instead of silently treating scoped fields as global.

## Progressive disclosure for supervisors

A DeepSeek Harness supervisor can issue a compact search without knowing
storage IDs:

```json
{
  "query": "Why did we choose workstation-shell as the launch authority for DSH?",
  "currentRepo": "wrightpt/trading-system",
  "missionId": "mission-id",
  "includeRelatedProjects": true,
  "limit": 10
}
```

Each compact hit supplies its result ID, title, type, fused score, scope and
reason, channel scores, and bounded provenance. The caller can then pass one or
more returned IDs to `expandIds` to inspect source content and full provenance.
The supervisor does not need an internal ID before its initial query.

Workstation-shell should keep supplying canonical session/mission/agent
metadata at session start. DSH should call AgentMemory through the existing
MCP or REST surface, use compact results in its working context, and expand
only the few sources it intends to inspect. Neither integration should infer
repository relationships from embedding similarity.

## Migration and operations

This feature does not restart or deploy AgentMemory, mutate production memory,
or silently rebuild a production index. Existing BM25/vector snapshots and
legacy session rows remain readable. Any future identity backfill must be an
explicit, idempotent offline operation with a dry-run report. Any later external
vector implementation must pass the same retrieval, dimension, isolation,
persistence-compatibility, and quality fixture tests before it can replace the
local default.
