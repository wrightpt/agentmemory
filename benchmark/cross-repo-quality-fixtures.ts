/**
 * Hand-authored calibration and held-out fixtures for institutional-memory
 * retrieval. Qrels are intentionally explicit: they are never inferred from
 * document concepts, embeddings, repository metadata, or graph edges.
 */

export type QualityCategory =
  | "exact_symbol"
  | "semantic_paraphrase"
  | "cross_repo_architecture"
  | "historical_bug"
  | "current_repo_preference"
  | "related_dependency";

export interface QualityDocumentFixture {
  id: string;
  canonicalRepoId: string;
  project: string;
  sessionId: string;
  agent: string;
  missionId: string;
  worktree: string;
  branch: string;
  commitSha: string;
  timestamp: string;
  memoryType: "architecture" | "bug" | "workflow" | "fact";
  confidence: number;
  importance: number;
  files: string[];
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  semanticKey: string;
  /** Force a graph-only target outside the vector candidate set. */
  antiSemanticKey?: string;
  global?: boolean;
  stale?: boolean;
  supersededBy?: string;
  supersedes?: string[];
}

export interface QualityQueryFixture {
  id: string;
  category: QualityCategory;
  query: string;
  semanticKey: string;
  currentRepo: string;
  missionId: string;
  relatedRepos: string[];
  entities: string[];
  /** observation id -> graded relevance (3 highest, 0 irrelevant) */
  qrels: Record<string, number>;
}

export interface QualityGraphNodeFixture {
  id: string;
  name: string;
  type: "concept" | "project" | "pattern";
  observationIds: string[];
}

export interface QualityGraphEdgeFixture {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: "uses" | "depends_on" | "related_to";
  weight: number;
}

export interface QualityFixture {
  name: "calibration-v1" | "heldout-v1";
  documents: QualityDocumentFixture[];
  queries: QualityQueryFixture[];
  graphNodes: QualityGraphNodeFixture[];
  graphEdges: QualityGraphEdgeFixture[];
}

const CALIBRATION_TIME = "2025-02-03T12:00:00.000Z";
const HELDOUT_TIME = "2025-06-17T15:30:00.000Z";

function stableCommitSha(id: string): string {
  let result = "";
  for (let round = 0; round < 5; round++) {
    let hash = 0x811c9dc5;
    const input = `${id}:${round}`;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    result += hash.toString(16).padStart(8, "0");
  }
  return result;
}

function document(
  id: string,
  repo: string,
  missionId: string,
  memoryType: QualityDocumentFixture["memoryType"],
  title: string,
  narrative: string,
  semanticKey: string,
  options: Partial<QualityDocumentFixture> = {},
): QualityDocumentFixture {
  const project = repo.split("/").at(-1) ?? repo;
  return {
    id,
    canonicalRepoId: repo,
    project,
    sessionId: `session-${id}`,
    agent: id.includes("noise") ? "pi" : "codex",
    missionId,
    worktree: `/worktrees/${project}/${id}`,
    branch: `agent/${id}`,
    commitSha: stableCommitSha(id),
    timestamp: id.startsWith("cal_") ? CALIBRATION_TIME : HELDOUT_TIME,
    memoryType,
    confidence: 0.9,
    importance: 8,
    files: [`docs/${id}.md`],
    title,
    narrative,
    facts: [narrative],
    concepts: [semanticKey],
    semanticKey,
    ...options,
  };
}

const calibrationDocuments: QualityDocumentFixture[] = [
  document(
    "cal_exact_target",
    "calico/control-hub",
    "mission-cal-launch",
    "workflow",
    "CoordinatorFenceToken is the single-flight launch guard",
    "The exact CoordinatorFenceToken symbol protects one interactive process birth.",
    "cal-fence-token",
  ),
  document(
    "cal_exact_noise",
    "noise/control-hub",
    "mission-noise",
    "workflow",
    "Coordinator fence notes",
    "A similarly named but unrelated queue fence controls batch jobs.",
    "cal-fence-token",
    { importance: 9 },
  ),
  document(
    "cal_exact_global",
    "global/institutional-memory",
    "mission-global",
    "architecture",
    "Launch guards should be inspectable",
    "Global workflow guidance favors attributable launch guards.",
    "cal-launch-guidance",
    { global: true, importance: 7 },
  ),

  document(
    "cal_semantic_target",
    "calico/knowledge-bank",
    "mission-cal-state",
    "architecture",
    "Keep coordination records structural",
    "Locks, actions, and ownership records retain typed fields so exact state remains queryable.",
    "cal-structured-state",
  ),
  document(
    "cal_semantic_noise",
    "noise/vector-notes",
    "mission-noise",
    "fact",
    "Encode coordination prose",
    "This unrelated experiment embeds lock documentation for similarity lookup.",
    "cal-structured-state",
    { importance: 9 },
  ),
  document(
    "cal_semantic_local_noise",
    "calico/control-hub",
    "mission-cal-state",
    "fact",
    "Cache lock descriptions",
    "Temporary prose caching does not define the authoritative lock state.",
    "cal-cache-state",
  ),

  document(
    "cal_arch_target",
    "calico/policy-manual",
    "mission-cal-architecture",
    "architecture",
    "Central birth broker decision",
    "One process-birth boundary attaches parent and mission attribution to every worker.",
    "cal-broker-ownership",
    { antiSemanticKey: "cal-bootstrap-query" },
  ),
  document(
    "cal_arch_noise",
    "noise/control-hub",
    "mission-noise",
    "architecture",
    "Bootstrap authority comparison",
    "A browser bootstrap experiment delegates process creation to arbitrary tabs.",
    "cal-bootstrap-query",
    { importance: 9 },
  ),
  document(
    "cal_arch_global",
    "global/institutional-memory",
    "mission-global",
    "architecture",
    "Process ownership should be singular",
    "Global guidance recommends one attributable process-launch boundary.",
    "cal-process-guidance",
    { global: true, importance: 7 },
  ),

  document(
    "cal_bug_old",
    "calico/knowledge-bank",
    "mission-cal-restore",
    "bug",
    "Retry pooled buffer restores",
    "The first diagnosis blamed intermittent restore timing and recommended retries.",
    "cal-buffer-restore",
    { stale: true, supersededBy: "cal_bug_target", importance: 10 },
  ),
  document(
    "cal_bug_target",
    "calico/knowledge-bank",
    "mission-cal-restore",
    "bug",
    "Respect typed-array slice offsets",
    "The root cause was decoding the entire pooled ArrayBuffer instead of its byte offset and byte length.",
    "cal-buffer-restore",
    { supersedes: ["cal_bug_old"], importance: 9 },
  ),
  document(
    "cal_bug_noise",
    "noise/vector-notes",
    "mission-noise",
    "bug",
    "Pooled buffer restoration failure",
    "An unrelated media decoder also mishandled pooled byte storage.",
    "cal-buffer-restore",
  ),

  document(
    "cal_local_target",
    "calico/control-hub",
    "mission-cal-watchdog",
    "workflow",
    "Watchdog retries stop at the ownership boundary",
    "The local control hub retries twice and then leaves the session inspectable.",
    "cal-watchdog",
  ),
  document(
    "cal_local_noise",
    "noise/control-hub",
    "mission-noise",
    "workflow",
    "Watchdog retries forever",
    "An unrelated product continuously respawns failed background jobs.",
    "cal-watchdog",
    { importance: 10 },
  ),
  document(
    "cal_local_global",
    "global/institutional-memory",
    "mission-global",
    "workflow",
    "Watchdogs require bounded recovery",
    "Global workflow guidance recommends bounded recovery attempts.",
    "cal-watchdog-guidance",
    { global: true, importance: 6 },
  ),

  document(
    "cal_related_target",
    "calico/knowledge-bank",
    "mission-cal-dependency",
    "architecture",
    "Knowledge bank supplies shared recall",
    "Control hub agents retrieve attributed institutional memory through the knowledge bank.",
    "cal-shared-recall",
  ),
  document(
    "cal_related_noise",
    "noise/vector-notes",
    "mission-noise",
    "architecture",
    "Shared recall service",
    "An unrelated notebook service exposes approximate document recall.",
    "cal-shared-recall",
    { importance: 9 },
  ),
  document(
    "cal_related_local_noise",
    "calico/control-hub",
    "mission-cal-dependency",
    "fact",
    "Control hub renders recall results",
    "The UI renders results but is not the durable recall provider.",
    "cal-render-recall",
  ),
];

const calibrationQueries: QualityQueryFixture[] = [
  {
    id: "cal_q_exact",
    category: "exact_symbol",
    query: "CoordinatorFenceToken",
    semanticKey: "cal-fence-token",
    currentRepo: "calico/control-hub",
    missionId: "mission-cal-launch",
    relatedRepos: ["calico/knowledge-bank"],
    entities: [],
    qrels: { cal_exact_target: 3 },
  },
  {
    id: "cal_q_semantic",
    category: "semantic_paraphrase",
    query: "Why are ownership locks not merely similarity vectors?",
    semanticKey: "cal-structured-state",
    currentRepo: "calico/control-hub",
    missionId: "mission-cal-state",
    relatedRepos: ["calico/knowledge-bank"],
    entities: [],
    qrels: { cal_semantic_target: 3 },
  },
  {
    id: "cal_q_architecture",
    category: "cross_repo_architecture",
    query: "Why was BootstrapAuthority chosen?",
    semanticKey: "cal-bootstrap-query",
    currentRepo: "calico/control-hub",
    missionId: "mission-cal-architecture",
    relatedRepos: ["calico/policy-manual"],
    entities: ["BootstrapAuthority"],
    qrels: { cal_arch_target: 3, cal_arch_global: 1 },
  },
  {
    id: "cal_q_bug",
    category: "historical_bug",
    query: "What caused the pooled buffer restore corruption?",
    semanticKey: "cal-buffer-restore",
    currentRepo: "calico/control-hub",
    missionId: "mission-cal-restore",
    relatedRepos: ["calico/knowledge-bank"],
    entities: [],
    qrels: { cal_bug_target: 3 },
  },
  {
    id: "cal_q_local",
    category: "current_repo_preference",
    query: "How should watchdog retries behave?",
    semanticKey: "cal-watchdog",
    currentRepo: "calico/control-hub",
    missionId: "mission-cal-watchdog",
    relatedRepos: [],
    entities: [],
    qrels: { cal_local_target: 3, cal_local_global: 1 },
  },
  {
    id: "cal_q_related",
    category: "related_dependency",
    query: "Which component supplies shared recall to the control hub?",
    semanticKey: "cal-shared-recall",
    currentRepo: "calico/control-hub",
    missionId: "mission-cal-dependency",
    relatedRepos: ["calico/knowledge-bank"],
    entities: [],
    qrels: { cal_related_target: 3 },
  },
];

const heldoutDocuments: QualityDocumentFixture[] = [
  document(
    "hold_exact_target",
    "northstar/fleet-console",
    "mission-hold-launch",
    "workflow",
    "TerminalLaunchAuthorityV3 owns interactive starts",
    "The exact TerminalLaunchAuthorityV3 entry point attaches parent, mission, and agent identity.",
    "hold-launch-symbol",
  ),
  document(
    "hold_exact_noise",
    "elsewhere/fleet-console",
    "mission-noise",
    "workflow",
    "Terminal launch authority notes",
    "A same-basename repository documents a different batch launcher.",
    "hold-launch-symbol",
    { importance: 10 },
  ),
  document(
    "hold_exact_global",
    "global/institutional-memory",
    "mission-global",
    "workflow",
    "Interactive launches carry provenance",
    "Global guidance requires parent and mission attribution at launch.",
    "hold-launch-guidance",
    { global: true, importance: 7 },
  ),

  document(
    "hold_semantic_target",
    "northstar/memory-ledger",
    "mission-hold-state",
    "architecture",
    "Typed coordination remains authoritative",
    "Leases, actions, and sessions preserve queryable fields; embeddings only supplement institutional prose.",
    "hold-structured-state",
  ),
  document(
    "hold_semantic_noise",
    "thirdparty/search-lab",
    "mission-noise",
    "fact",
    "Embedding coordination manuals",
    "This unrelated prototype converts lock manuals into nearest-neighbor vectors.",
    "hold-structured-state",
    { importance: 10 },
  ),
  document(
    "hold_semantic_local_noise",
    "northstar/fleet-console",
    "mission-hold-state",
    "fact",
    "Render lease descriptions",
    "The console displays lease prose but does not own structured lease state.",
    "hold-render-state",
  ),

  document(
    "hold_arch_target",
    "northstar/protocol-book",
    "mission-hold-architecture",
    "architecture",
    "Central birth broker decision",
    "One process-birth boundary makes every worker attributable and keeps policy enforceable.",
    "hold-broker-ownership",
    { antiSemanticKey: "hold-launch-query" },
  ),
  document(
    "hold_arch_noise",
    "thirdparty/search-lab",
    "mission-noise",
    "architecture",
    "LaunchAuthority experiment",
    "An unrelated search worker lets any plugin spawn background processes.",
    "hold-launch-query",
    { importance: 10 },
  ),
  document(
    "hold_arch_global",
    "global/institutional-memory",
    "mission-global",
    "architecture",
    "Process birth needs an attributable boundary",
    "Global architecture guidance favors one inspectable launch boundary.",
    "hold-process-guidance",
    { global: true, importance: 7 },
  ),

  document(
    "hold_bug_old",
    "northstar/memory-ledger",
    "mission-hold-restore",
    "bug",
    "Retry phantom 2048-dimension restores",
    "The superseded diagnosis blamed eventual consistency and recommended retries.",
    "hold-dimension-restore",
    { stale: true, supersededBy: "hold_bug_target", importance: 10 },
  ),
  document(
    "hold_bug_target",
    "northstar/memory-ledger",
    "mission-hold-restore",
    "bug",
    "Decode only the Buffer slice",
    "The phantom dimension came from ignoring byteOffset and byteLength when viewing a pooled Buffer.",
    "hold-dimension-restore",
    { supersedes: ["hold_bug_old"], importance: 9 },
  ),
  document(
    "hold_bug_noise",
    "thirdparty/search-lab",
    "mission-noise",
    "bug",
    "Phantom embedding dimension restore",
    "An unrelated browser index restored an obsolete model dimension.",
    "hold-dimension-restore",
    { importance: 9 },
  ),

  document(
    "hold_local_target",
    "northstar/runtime-engine",
    "mission-hold-heartbeat",
    "workflow",
    "Heartbeat timeout preserves the failed worker",
    "The runtime stops new dispatch, records the timeout, and leaves the worker inspectable.",
    "hold-heartbeat",
  ),
  document(
    "hold_local_noise",
    "thirdparty/runtime-engine",
    "mission-noise",
    "workflow",
    "Heartbeat timeout immediately respawns workers",
    "An unrelated same-basename runtime loops forever on missed heartbeats.",
    "hold-heartbeat",
    { importance: 10 },
  ),
  document(
    "hold_local_global",
    "global/institutional-memory",
    "mission-global",
    "workflow",
    "Failed workers remain inspectable",
    "Global operations guidance favors evidence preservation after timeouts.",
    "hold-heartbeat-guidance",
    { global: true, importance: 7 },
  ),

  document(
    "hold_related_target",
    "northstar/memory-ledger",
    "mission-hold-dependency",
    "architecture",
    "Memory ledger supplies attributed cross-agent recall",
    "Fleet console agents obtain shared institutional recall through the memory ledger.",
    "hold-shared-recall",
  ),
  document(
    "hold_related_noise",
    "thirdparty/search-lab",
    "mission-noise",
    "architecture",
    "Cross-agent recall component",
    "An unrelated document index exposes anonymous semantic search.",
    "hold-shared-recall",
    { importance: 10 },
  ),
  document(
    "hold_related_local_noise",
    "northstar/fleet-console",
    "mission-hold-dependency",
    "fact",
    "Fleet console renders attributed results",
    "The console renders compact results but is not their durable store.",
    "hold-render-recall",
  ),
];

const heldoutQueries: QualityQueryFixture[] = [
  {
    id: "hold_q_exact",
    category: "exact_symbol",
    query: "TerminalLaunchAuthorityV3",
    semanticKey: "hold-launch-symbol",
    currentRepo: "northstar/fleet-console",
    missionId: "mission-hold-launch",
    relatedRepos: ["northstar/memory-ledger"],
    entities: [],
    qrels: { hold_exact_target: 3 },
  },
  {
    id: "hold_q_semantic",
    category: "semantic_paraphrase",
    query: "Why are coordination locks not represented only as semantic vectors?",
    semanticKey: "hold-structured-state",
    currentRepo: "northstar/fleet-console",
    missionId: "mission-hold-state",
    relatedRepos: ["northstar/memory-ledger"],
    entities: [],
    qrels: { hold_semantic_target: 3 },
  },
  {
    id: "hold_q_architecture",
    category: "cross_repo_architecture",
    query: "Why was LaunchAuthority selected for supervisor startup?",
    semanticKey: "hold-launch-query",
    currentRepo: "northstar/runtime-engine",
    missionId: "mission-hold-architecture",
    relatedRepos: ["northstar/protocol-book"],
    entities: ["LaunchAuthority"],
    qrels: { hold_arch_target: 3, hold_arch_global: 1 },
  },
  {
    id: "hold_q_bug",
    category: "historical_bug",
    query: "What caused the old phantom embedding dimension restore failure?",
    semanticKey: "hold-dimension-restore",
    currentRepo: "northstar/fleet-console",
    missionId: "mission-hold-restore",
    relatedRepos: ["northstar/memory-ledger"],
    entities: [],
    qrels: { hold_bug_target: 3 },
  },
  {
    id: "hold_q_local",
    category: "current_repo_preference",
    query: "How should a worker heartbeat timeout behave?",
    semanticKey: "hold-heartbeat",
    currentRepo: "northstar/runtime-engine",
    missionId: "mission-hold-heartbeat",
    relatedRepos: [],
    entities: [],
    qrels: { hold_local_target: 3, hold_local_global: 1 },
  },
  {
    id: "hold_q_related",
    category: "related_dependency",
    query: "Which component supplies cross-agent recall to the fleet console?",
    semanticKey: "hold-shared-recall",
    currentRepo: "northstar/fleet-console",
    missionId: "mission-hold-dependency",
    relatedRepos: ["northstar/memory-ledger"],
    entities: [],
    qrels: { hold_related_target: 3 },
  },
];

export const calibrationFixture: QualityFixture = {
  name: "calibration-v1",
  documents: calibrationDocuments,
  queries: calibrationQueries,
  graphNodes: [
    {
      id: "cal_graph_anchor",
      name: "BootstrapAuthority",
      type: "concept",
      observationIds: [],
    },
    {
      id: "cal_graph_decision",
      name: "BrokerOwnership",
      type: "pattern",
      observationIds: ["cal_arch_target"],
    },
  ],
  graphEdges: [
    {
      id: "cal_graph_edge",
      sourceNodeId: "cal_graph_anchor",
      targetNodeId: "cal_graph_decision",
      type: "depends_on",
      weight: 0.95,
    },
  ],
};

export const heldoutFixture: QualityFixture = {
  name: "heldout-v1",
  documents: heldoutDocuments,
  queries: heldoutQueries,
  graphNodes: [
    {
      id: "hold_graph_anchor",
      name: "LaunchAuthority",
      type: "concept",
      observationIds: [],
    },
    {
      id: "hold_graph_decision",
      name: "SupervisorBrokerDecision",
      type: "pattern",
      observationIds: ["hold_arch_target"],
    },
  ],
  graphEdges: [
    {
      id: "hold_graph_edge",
      sourceNodeId: "hold_graph_anchor",
      targetNodeId: "hold_graph_decision",
      type: "depends_on",
      weight: 0.95,
    },
  ],
};
