import type { LessonScope, LessonSensitivity } from '../types.js';

export const FINDING_ROUTES = [
  { operation: 'prepare', api_path: '/agentmemory/findings/prepare', http_method: 'POST' },
  { operation: 'publish', api_path: '/agentmemory/findings/publish', http_method: 'POST' },
  { operation: 'snapshot', api_path: '/agentmemory/findings/snapshot', http_method: 'POST' },
  { operation: 'expand', api_path: '/agentmemory/findings/expand', http_method: 'POST' },
  { operation: 'correct', api_path: '/agentmemory/findings/correct', http_method: 'POST' },
] as const;

export type FindingRole = 'worker' | 'reviewer' | 'generator' | 'refiner' | 'report';
export type FindingPhase = 'coding' | 'pre-outcome' | 'post-freeze';
export type FindingKind = 'coding' | 'data-quality' | 'procedure' | 'evaluation';
export type FindingScalar = string | number | boolean | null;
export interface FindingView {
  project: string;
  taskId: string;
  role: FindingRole;
  phase: FindingPhase;
}
export interface FindingPrincipalGrant extends FindingView {
  principalId: string;
  publish: boolean;
}
export interface FindingSource {
  id: string;
  project: string;
  taskId: string;
  scope: LessonScope;
  sensitivity: LessonSensitivity;
  visibility: 'pre-outcome' | 'post-freeze';
  uri: string;
  sha256: string;
  revision: string;
  location: { type: 'git'; repository: string; path: string } | { type: 'artifact'; path: string };
}
export interface FindingPolicy {
  version: 1;
  grants: FindingPrincipalGrant[];
  sources: FindingSource[];
  reviewers: Array<{ principalId: string; publicKey: string }>;
}
export interface FindingSlice {
  sourceId: string;
  sha256: string;
  startLine: number;
  endLine: number;
  quote: string;
}
export type FindingCheck =
  | { type: 'exact-quote'; sourceId: string }
  | { type: 'json-pointer-equals'; sourceId: string; pointer: string; expected: FindingScalar }
  | { type: 'narrative' };
export interface FindingReview {
  reviewerId: string;
  claimHash: string;
  bindingHash: string;
  evidenceHash: string;
  reviewedAt: string;
  verdict: 'supported' | 'unsupported' | 'conflicting';
  rationale: string;
  signature: string;
}
export interface FindingProposal {
  project: string;
  taskId: string;
  kind: FindingKind;
  claim: string;
  applicability: string[];
  sources: FindingSlice[];
  check: FindingCheck;
  review?: FindingReview;
}
export interface FindingEvidence {
  source: Omit<FindingSource, 'location'>;
  raw: string;
  slice: FindingSlice;
}
export interface FindingVerification {
  method: 'exact-quote-v1' | 'json-pointer-equals-v1' | 'independent-review-ed25519-v1';
  authorId: string;
  verifierId: string;
  claimHash: string;
  bindingHash: string;
  evidenceHash: string;
  verifiedAt: string;
}
export interface PreparedFinding {
  proposal: FindingProposal;
  evidence: FindingEvidence[];
  verification: FindingVerification;
  scope: LessonScope;
  sensitivity: LessonSensitivity;
  visibility: 'pre-outcome' | 'post-freeze';
}
export interface SharedFinding {
  version: 1;
  proposal: FindingProposal;
  verification: FindingVerification;
  evidenceId: string;
  visibility: 'pre-outcome' | 'post-freeze';
}
export interface FindingEvidenceRecord {
  id: string;
  evidenceHash: string;
  evidence: FindingEvidence[];
}
export interface FindingSnapshotEntry {
  lessonId: string;
  bindingHash: string;
  evidenceHash: string;
  claim: string;
  kind: FindingKind;
  applicability: string[];
}
export interface FindingSnapshot {
  version: 1;
  id: string;
  hash: string;
  principalId: string;
  view: FindingView;
  policyHash: string;
  entries: FindingSnapshotEntry[];
}
