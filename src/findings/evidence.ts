import { execFile } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import type { LessonScope, LessonSensitivity } from "../types.js";
import type {
  FindingCheck,
  FindingEvidence,
  FindingPolicy,
  FindingProposal,
  FindingReview,
  FindingScalar,
  FindingSource,
  PreparedFinding,
} from "./types.js";

const execFileAsync = promisify(execFile);
const SOURCE_BYTES = 64 * 1024;
const QUOTE_BYTES = 8 * 1024;
const CHECKER_VERSION = "shared-findings-evidence-v1";
export const DETERMINISTIC_APPLICABILITY =
  "Only the cited source revision and supporting lines.";
const sensitivities: LessonSensitivity[] = ["public", "internal", "confidential", "restricted"];

function fail(code: string): never {
  throw new Error(`finding_${code}`);
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("invalid_object");
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!keys.includes(key) || !Object.hasOwn(descriptor, "value")) fail("unknown_field");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) fail("unknown_field");
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")
    || Buffer.from(value, "utf8").toString("utf8") !== value || (!empty && !value.trim())) {
    fail("invalid_text");
  }
  return value;
}

function id(value: unknown): string {
  const result = text(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(result)) fail("invalid_id");
  return result;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail("invalid_enum");
  return value as T;
}

function list(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum) fail("invalid_list");
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(entries).length !== value.length + 1 || Object.getOwnPropertySymbols(value).length > 0) fail("invalid_list");
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(entries[index] ?? {}, "value")) fail("invalid_list");
  }
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid_hash");
  return value;
}

function timestamp(value: unknown): string {
  const result = text(value, 24);
  const parsed = new Date(result);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result)
    || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) fail("invalid_timestamp");
  return result;
}

function unique(values: string[], code = "duplicate_binding"): void {
  if (new Set(values).size !== values.length) fail(code);
}

function scope(value: unknown): LessonScope {
  const input = record(value, ["ring", "scopeId", "humanApproval"]);
  const result: LessonScope = {
    ring: oneOf(input.ring, ["worktree", "repo", "initiative", "domain"]),
    scopeId: text(input.scopeId, 256),
  };
  if (input.humanApproval !== undefined) {
    const approval = record(input.humanApproval, ["approvedBy", "approvedAt", "reason"]);
    result.humanApproval = {
      approvedBy: id(approval.approvedBy),
      approvedAt: timestamp(approval.approvedAt),
      reason: text(approval.reason, 500),
    };
  }
  return result;
}

function absolutePath(value: unknown): string {
  const result = text(value, 4096);
  if (!isAbsolute(result) || normalize(result) !== result || /[\r\n]/.test(result)) fail("invalid_location");
  return result;
}

function source(value: unknown): FindingSource {
  const input = record(value, ["id", "project", "taskId", "scope", "sensitivity", "visibility", "uri", "sha256", "revision", "location"]);
  const location = record(input.location, ["type", "repository", "path"]);
  const kind = oneOf(location.type, ["git", "artifact"]);
  let parsedLocation: FindingSource["location"];
  const revision = text(input.revision, 200);
  if (kind === "git") {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) fail("unpinned_revision");
    const path = text(location.path, 2048);
    if (path.startsWith("/") || /[\0\r\n\\:]/.test(path)
      || path.split("/").some((part) => part === "" || part === "." || part === "..")) fail("invalid_location");
    parsedLocation = { type: kind, repository: absolutePath(location.repository), path };
  } else {
    if (location.repository !== undefined) fail("unknown_field");
    parsedLocation = { type: kind, path: absolutePath(location.path) };
  }
  const uri = text(input.uri, 2048);
  try {
    const parsed = new URL(uri);
    if (!["https:", "s3:", "urn:", "git:", "artifact:", "oci:", "ipfs:"].includes(parsed.protocol)
      || parsed.username || parsed.password || /\s/.test(uri)) fail("invalid_uri");
  } catch { fail("invalid_uri"); }
  return {
    id: id(input.id), project: id(input.project), taskId: id(input.taskId), scope: scope(input.scope),
    sensitivity: oneOf(input.sensitivity, sensitivities),
    visibility: oneOf(input.visibility, ["pre-outcome", "post-freeze"]),
    uri, sha256: hash(input.sha256), revision, location: parsedLocation,
  };
}

export function parseFindingPolicy(value: unknown): FindingPolicy {
  const input = record(value, ["version", "grants", "sources", "reviewers"]);
  if (input.version !== 1) fail("invalid_policy_version");
  const grants: FindingPolicy["grants"] = list(input.grants, 1024).map((value) => {
    const grant = record(value, ["principalId", "project", "taskId", "role", "phase", "publish"]);
    if (typeof grant.publish !== "boolean") fail("invalid_grant");
    return {
      principalId: id(grant.principalId), project: id(grant.project), taskId: id(grant.taskId),
      role: oneOf(grant.role, ["worker", "reviewer", "generator", "refiner", "report"]),
      phase: oneOf(grant.phase, ["coding", "pre-outcome", "post-freeze"]), publish: grant.publish,
    };
  });
  const sources = list(input.sources, 1024).map(source);
  const reviewers = list(input.reviewers, 64).map((value) => {
    const reviewer = record(value, ["principalId", "publicKey"]);
    const pem = text(reviewer.publicKey, 2048);
    let publicKey: string;
    try {
      if (!pem.startsWith("-----BEGIN PUBLIC KEY-----")) fail("invalid_reviewer_key");
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== "ed25519") fail("invalid_reviewer_key");
      publicKey = key.export({ type: "spki", format: "pem" }).toString();
    } catch { fail("invalid_reviewer_key"); }
    return { principalId: id(reviewer.principalId), publicKey };
  });
  unique(grants.map(({ publish: _publish, ...grant }) => canonicalJson(grant)), "duplicate_grant");
  unique(sources.map((value) => value.id));
  unique(sources.map((value) => canonicalJson({ location: value.location, revision: value.revision })));
  unique(sources.map((value) => canonicalJson({ uri: value.uri, revision: value.revision })));
  unique(reviewers.map((value) => value.principalId), "duplicate_reviewer");
  unique(reviewers.map((value) => value.publicKey), "duplicate_reviewer_key");
  return { version: 1, grants, sources, reviewers };
}

function scalar(value: unknown): FindingScalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value, 500, true);
  if (typeof value === "number" && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  fail("invalid_scalar");
}

function check(value: unknown): FindingCheck {
  const input = record(value, ["type", "sourceId", "pointer", "expected"]);
  switch (input.type) {
    case "narrative":
      record(value, ["type"]);
      return { type: "narrative" };
    case "exact-quote":
      record(value, ["type", "sourceId"]);
      return { type: "exact-quote", sourceId: id(input.sourceId) };
    case "json-pointer-equals": {
      const pointer = text(input.pointer, 500, true);
      if ((pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/.test(pointer)) fail("invalid_pointer");
      if (!Object.hasOwn(input, "expected")) fail("invalid_scalar");
      return { type: "json-pointer-equals", sourceId: id(input.sourceId), pointer, expected: scalar(input.expected) };
    }
    default: fail("invalid_check");
  }
}

function review(value: unknown): FindingReview {
  const input = record(value, ["reviewerId", "claimHash", "bindingHash", "evidenceHash", "reviewedAt", "verdict", "rationale", "signature"]);
  const signature = text(input.signature, 88);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || Buffer.from(signature, "base64").toString("base64") !== signature) {
    fail("invalid_signature");
  }
  return {
    reviewerId: id(input.reviewerId), claimHash: hash(input.claimHash), bindingHash: hash(input.bindingHash),
    evidenceHash: hash(input.evidenceHash), reviewedAt: timestamp(input.reviewedAt),
    verdict: oneOf(input.verdict, ["supported", "unsupported", "conflicting"]),
    rationale: text(input.rationale, 2000), signature,
  };
}

export function parseFindingProposal(value: unknown): FindingProposal {
  const input = record(value, ["project", "taskId", "kind", "claim", "applicability", "sources", "check", "review"]);
  const sources = list(input.sources, 4, 1).map((value) => {
    const slice = record(value, ["sourceId", "sha256", "startLine", "endLine", "quote"]);
    if (!Number.isSafeInteger(slice.startLine) || !Number.isSafeInteger(slice.endLine)
      || (slice.startLine as number) < 1 || (slice.endLine as number) < (slice.startLine as number)
      || (slice.endLine as number) > SOURCE_BYTES) fail("invalid_span");
    const quote = text(slice.quote, QUOTE_BYTES);
    if (Buffer.byteLength(quote, "utf8") > QUOTE_BYTES) fail("quote_too_large");
    return {
      sourceId: id(slice.sourceId), sha256: hash(slice.sha256), startLine: slice.startLine as number,
      endLine: slice.endLine as number, quote,
    };
  });
  unique(sources.map((value) => value.sourceId));
  const applicability = list(input.applicability, 4, 1).map((value) => text(value, 200));
  unique(applicability, "duplicate_applicability");
  return {
    project: id(input.project), taskId: id(input.taskId),
    kind: oneOf(input.kind, ["coding", "data-quality", "procedure", "evaluation"]),
    claim: text(input.claim, 500), applicability, sources, check: check(input.check),
    ...(input.review === undefined ? {} : { review: review(input.review) }),
  };
}

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(value: unknown, depth: number): string {
    if (depth > 64) fail("invalid_json");
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== "object" || seen.has(value)) fail("invalid_json");
    seen.add(value);
    let encoded: string;
    if (Array.isArray(value)) {
      encoded = `[${list(value, 65536).map((item) => encode(item, depth + 1)).join(",")}]`;
    } else {
      const object = record(value, Object.keys(value));
      encoded = `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${encode(object[key], depth + 1)}`).join(",")}}`;
    }
    seen.delete(value);
    return encoded;
  }
  return encode(value, 0);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function deterministicClaim(proposal: FindingProposal): string {
  if (proposal.check.type === "narrative") fail("independent_review_required");
  if (proposal.sources.length !== 1 || proposal.sources[0].sourceId !== proposal.check.sourceId) fail("conflicting_binding");
  const slice = proposal.sources[0];
  const claim = proposal.check.type === "exact-quote"
    ? `Source ${slice.sourceId} lines ${slice.startLine}-${slice.endLine} contains ${JSON.stringify(slice.quote)}.`
    : `Source ${slice.sourceId} JSON pointer ${JSON.stringify(proposal.check.pointer)} equals ${JSON.stringify(proposal.check.expected)}.`;
  if (claim.length > 500) fail("claim_too_long");
  return claim;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

async function gitRead(repository: string, args: string[], maxBuffer: number): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", ["-C", repository, "--no-pager", "--no-lazy-fetch", "-c", "core.fsmonitor=false", ...args], {
      encoding: "buffer", maxBuffer, timeout: 3000, env: gitEnvironment(),
    });
    return result.stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") fail("source_too_large");
    fail("source_unavailable");
  }
}

async function sourceBytes(source: FindingSource): Promise<Buffer> {
  if (source.location.type === "git") {
    const { repository, path } = source.location;
    const object = `${source.revision}:${path}`;
    const [revisionType, objectType] = await Promise.all([
      gitRead(repository, ["cat-file", "-t", source.revision], 128),
      gitRead(repository, ["cat-file", "-t", object], 128),
    ]);
    if (revisionType.toString() !== "commit\n" || objectType.toString() !== "blob\n") fail("invalid_source_object");
    return gitRead(repository, ["show", "--no-ext-diff", "--no-textconv", object], SOURCE_BYTES);
  }
  let handle;
  try {
    handle = await open(source.location.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) fail("invalid_source_object");
    if (info.size > SOURCE_BYTES) fail("source_too_large");
    const bytes = Buffer.alloc(SOURCE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > SOURCE_BYTES) fail("source_too_large");
    return bytes.subarray(0, length);
  } catch (error) {
    if (error instanceof Error && /^finding_(?:invalid_source_object|source_too_large)$/.test(error.message)) throw error;
    return fail("source_unavailable");
  } finally {
    if (handle) await handle.close().catch(() => fail("source_unavailable"));
  }
}

async function bindEvidence(source: FindingSource, slice: FindingProposal["sources"][number]): Promise<FindingEvidence> {
  if (slice.sha256 !== source.sha256) fail("stale_source_hash");
  const bytes = await sourceBytes(source);
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("source_not_utf8"); }
  if (raw.includes("\0")) fail("source_not_text");
  if (sha256(raw) !== source.sha256) fail("source_hash_mismatch");
  const lines = raw.split("\n");
  if (raw.endsWith("\n")) lines.pop();
  if (slice.endLine > lines.length || lines.slice(slice.startLine - 1, slice.endLine).join("\n") !== slice.quote) {
    fail("source_span_mismatch");
  }
  const { location: _location, ...metadata } = source;
  return { source: metadata, raw, slice };
}

function unambiguousJson(raw: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("invalid_json_source"); }
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  let cursor = 0;
  function visit(depth: number): void {
    if (depth > 64) fail("invalid_json_source");
    const token = tokens[cursor++];
    if (token === "{") {
      const keys = new Set<string>();
      while (tokens[cursor] !== "}") {
        const key = JSON.parse(tokens[cursor++]) as string;
        if (keys.has(key)) fail("conflicting_json_keys");
        keys.add(key);
        cursor++;
        visit(depth + 1);
        if (tokens[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (token === "[") {
      while (tokens[cursor] !== "]") {
        visit(depth + 1);
        if (tokens[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (/^-?\d/.test(token)) {
      const number = Number(token);
      if (!Number.isFinite(number) || JSON.stringify(number) !== token
        || (Number.isInteger(number) && !Number.isSafeInteger(number))) fail("ambiguous_json_number");
    }
  }
  visit(0);
  return parsed;
}

function pointerValue(root: unknown, pointer: string): unknown {
  let value = root;
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)
      || (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(key))) fail("pointer_not_found");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function validateDeterministic(proposal: FindingProposal, evidence: FindingEvidence[]): void {
  if (proposal.check.type === "narrative") return;
  if (proposal.claim !== deterministicClaim(proposal)) fail("claim_not_supported");
  if (proposal.applicability.length !== 1 || proposal.applicability[0] !== DETERMINISTIC_APPLICABILITY) fail("applicability_not_supported");
  if (proposal.check.type === "json-pointer-equals") {
    const { raw, slice } = evidence[0];
    if (raw !== slice.quote && raw !== `${slice.quote}\n`) fail("json_document_span_required");
    const value = pointerValue(unambiguousJson(raw), proposal.check.pointer);
    if (value !== proposal.check.expected) fail("check_failed");
  }
}

export interface PreparedFindingReview {
  proposal: FindingProposal;
  evidence: FindingEvidence[];
  claimHash: string;
  bindingHash: string;
  evidenceHash: string;
  scope: LessonScope;
  sensitivity: LessonSensitivity;
  visibility: "pre-outcome" | "post-freeze";
}

async function prepare(proposal: FindingProposal, authorId: string, policy: FindingPolicy): Promise<PreparedFindingReview> {
  const author = id(authorId);
  const sources = proposal.sources.map((slice) => {
    const registered = policy.sources.find((source) => source.id === slice.sourceId);
    if (!registered) fail("unknown_source");
    if (registered.project !== proposal.project || registered.taskId !== proposal.taskId) fail("source_scope_mismatch");
    return registered;
  });
  const scope = sources[0].scope;
  if (sources.some((source) => canonicalJson(source.scope) !== canonicalJson(scope))) fail("source_scope_mismatch");
  const evidence = await Promise.all(sources.map((source, index) => bindEvidence(source, proposal.sources[index])));
  validateDeterministic(proposal, evidence);
  const claimHash = sha256(proposal.claim);
  const evidenceHash = sha256(canonicalJson(evidence));
  const bindingHash = sha256(canonicalJson({ checkerVersion: CHECKER_VERSION, proposal, authorId: author, sources: evidence.map(({ source }) => source) }));
  const sensitivity = sensitivities[Math.max(...sources.map((source) => sensitivities.indexOf(source.sensitivity)))];
  const visibility = sources.some((source) => source.visibility === "post-freeze") ? "post-freeze" : "pre-outcome";
  return { proposal, evidence, claimHash, bindingHash, evidenceHash, scope, sensitivity, visibility };
}

export async function prepareFindingReview(proposal: FindingProposal, authorId: string, policy: FindingPolicy): Promise<PreparedFindingReview> {
  const input = record(proposal, ["project", "taskId", "kind", "claim", "applicability", "sources", "check", "review"]);
  const { review: _review, ...unsigned } = input;
  return prepare(parseFindingProposal(unsigned), authorId, parseFindingPolicy(policy));
}

export function reviewSigningPayload(review: Omit<FindingReview, "signature">): string {
  return canonicalJson({
    reviewerId: review.reviewerId, claimHash: review.claimHash, bindingHash: review.bindingHash,
    evidenceHash: review.evidenceHash, reviewedAt: review.reviewedAt, verdict: review.verdict, rationale: review.rationale,
  });
}

export async function prepareFinding(proposal: FindingProposal, authorId: string, policy: FindingPolicy): Promise<PreparedFinding> {
  const parsed = parseFindingProposal(proposal);
  const parsedPolicy = parseFindingPolicy(policy);
  const { review, ...unsigned } = parsed;
  const prepared = await prepare(unsigned, authorId, parsedPolicy);
  let verifierId = `deterministic:${CHECKER_VERSION}`;
  let method: PreparedFinding["verification"]["method"];
  if (parsed.check.type === "narrative") {
    if (!review) fail("independent_review_required");
    if (review.reviewerId === authorId) fail("self_review");
    const reviewer = parsedPolicy.reviewers.find((reviewer) => reviewer.principalId === review.reviewerId);
    if (!reviewer) fail("untrusted_reviewer");
    if (review.claimHash !== prepared.claimHash || review.bindingHash !== prepared.bindingHash
      || review.evidenceHash !== prepared.evidenceHash) fail("review_binding_mismatch");
    if (Date.parse(review.reviewedAt) > Date.now()) fail("review_in_future");
    if (review.verdict !== "supported") fail("review_not_supported");
    if (!verify(null, Buffer.from(reviewSigningPayload(review)), reviewer.publicKey, Buffer.from(review.signature, "base64"))) {
      fail("invalid_signature");
    }
    verifierId = reviewer.principalId;
    method = "independent-review-ed25519-v1";
  } else {
    if (review !== undefined) fail("unexpected_review");
    method = parsed.check.type === "exact-quote" ? "exact-quote-v1" : "json-pointer-equals-v1";
  }
  return {
    proposal: parsed, evidence: prepared.evidence, scope: prepared.scope, sensitivity: prepared.sensitivity, visibility: prepared.visibility,
    verification: {
      method, authorId, verifierId, claimHash: prepared.claimHash, bindingHash: prepared.bindingHash,
      evidenceHash: prepared.evidenceHash, verifiedAt: new Date().toISOString(),
    },
  };
}
