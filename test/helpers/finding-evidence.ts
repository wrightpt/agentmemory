import { execFile } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DETERMINISTIC_APPLICABILITY,
  deterministicClaim,
  prepareFindingReview,
  reviewSigningPayload,
  sha256,
} from "../../src/findings/evidence.js";
import type { FindingPolicy, FindingProposal, FindingReview, FindingSource } from "../../src/findings/types.js";

const execFileAsync = promisify(execFile);

export async function createFindingFixture(raw = "The queue accepts durable receipts.\n", git = false) {
  const directory = await mkdtemp(join(tmpdir(), "finding-evidence-"));
  const path = join(directory, "source.txt");
  await writeFile(path, raw);
  let revision = "fixture-v1";
  if (git) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const command = (args: string[]) => execFileAsync("git", ["-C", directory, "-c", "core.hooksPath=/dev/null", ...args], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    await command(["init", "-q"]);
    await command(["add", "--", "source.txt"]);
    await command(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "--no-gpg-sign", "-m", "Fixed evidence fixture"]);
    revision = (await command(["rev-parse", "HEAD"])).stdout.trim();
  }
  const source: FindingSource = {
    id: "fixture-source", project: "agentmemory", taskId: "task-fixture",
    scope: { ring: "repo", scopeId: "repo:agentmemory" }, sensitivity: "internal",
    visibility: "pre-outcome", uri: "urn:agentmemory:fixed-fixture", sha256: sha256(raw), revision,
    location: git ? { type: "git", repository: directory, path: "source.txt" } : { type: "artifact", path },
  };
  const policy: FindingPolicy = {
    version: 1, sources: [source], reviewers: [],
    grants: [{ principalId: "worker-a", project: "agentmemory", taskId: "task-fixture", role: "worker", phase: "coding", publish: true }],
  };
  const proposal: FindingProposal = {
    project: source.project, taskId: source.taskId, kind: "coding", claim: "pending",
    applicability: [DETERMINISTIC_APPLICABILITY],
    sources: [{ sourceId: source.id, sha256: source.sha256, startLine: 1, endLine: 1, quote: raw.split("\n")[0] }],
    check: { type: "exact-quote", sourceId: source.id },
  };
  proposal.claim = deterministicClaim(proposal);
  return { directory, path, raw, source, policy, proposal, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export function addTestReviewer(policy: FindingPolicy, principalId = "reviewer-b"): KeyObject {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  policy.reviewers.push({ principalId, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() });
  return privateKey;
}

export async function signTestFinding(
  proposal: FindingProposal,
  policy: FindingPolicy,
  privateKey: KeyObject,
  options: { authorId?: string; reviewerId?: string; verdict?: FindingReview["verdict"]; reviewedAt?: string } = {},
): Promise<FindingProposal> {
  const prepared = await prepareFindingReview(proposal, options.authorId ?? "worker-a", policy);
  const unsigned = {
    reviewerId: options.reviewerId ?? "reviewer-b", claimHash: prepared.claimHash,
    bindingHash: prepared.bindingHash, evidenceHash: prepared.evidenceHash,
    reviewedAt: options.reviewedAt ?? "2026-01-01T00:00:00.000Z", verdict: options.verdict ?? "supported",
    rationale: "The exact supporting lines support the stated bounded claim and applicability.",
  };
  return { ...proposal, review: { ...unsigned, signature: sign(null, Buffer.from(reviewSigningPayload(unsigned)), privateKey).toString("base64") } };
}
