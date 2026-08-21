import type { ISdk } from "iii-sdk";
import type {
  ProjectRelationship,
  ProjectRelationshipProvenance,
  ProjectRelationshipProvenanceKind,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { fingerprintId, KV } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { normalizeRepositoryRemote } from "../utils/repository-identity.js";
import { safeAudit } from "./audit.js";

export interface ProjectRelationshipUpsertInput {
  sourceRepoId: string;
  targetRepoId: string;
  relationType: string;
  sourceAliases?: string[];
  targetAliases?: string[];
  provenance: Omit<ProjectRelationshipProvenance, "recordedAt"> & {
    recordedAt?: string;
  };
  reason?: string;
  expectedRevision?: number;
}

export interface ProjectRelationshipListInput {
  repoId?: string;
  direction?: "incoming" | "outgoing" | "both";
  relationType?: string;
}

const REPO_ID_MAX_LENGTH = 256;
const RELATION_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function normalizeRepositoryIdentity(value: string): string {
  const remote = normalizeRepositoryRemote(value);
  if (remote) return remote.canonicalRepoId;
  const normalized = value
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const [authority, ...path] = normalized.split("/");
  if (authority?.toLowerCase() === "github.com") {
    return path.join("/").toLowerCase();
  }
  // Non-GitHub repository paths may be case-sensitive. Lowercase only the
  // network authority so a credential-free remote and its canonical host/path
  // spelling produce the same deterministic relationship ID.
  if (authority?.includes(".") && path.length > 0) {
    return `${authority.toLowerCase()}/${path.join("/")}`;
  }
  return normalized.toLowerCase();
}

function validateRepositoryIdentity(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const normalized = normalizeRepositoryIdentity(value);
  if (
    !normalized ||
    normalized.length > REPO_ID_MAX_LENGTH ||
    /\s/.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new Error(`${field} is not a valid canonical repository identity`);
  }
  return normalized;
}

function normalizeRelationType(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("relationType must be a string");
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (!RELATION_TYPE_PATTERN.test(normalized)) {
    throw new Error(
      "relationType must match ^[a-z][a-z0-9_]{0,63}$",
    );
  }
  return normalized;
}

function normalizeAliases(values: unknown, canonical: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error("aliases must be an array");
  const aliases = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") throw new Error("aliases must be strings");
    const normalized = normalizeRepositoryIdentity(value);
    if (!normalized || normalized === canonical) continue;
    if (normalized.length > REPO_ID_MAX_LENGTH || /\s/.test(normalized)) {
      throw new Error("alias is not a valid repository identity");
    }
    aliases.add(normalized);
  }
  return [...aliases].sort();
}

function validateProvenance(
  value: ProjectRelationshipUpsertInput["provenance"],
  now: string,
): ProjectRelationshipProvenance {
  if (!value || typeof value !== "object") {
    throw new Error("provenance is required");
  }
  const kinds = new Set<ProjectRelationshipProvenanceKind>([
    "manifest",
    "registry",
    "manual",
    "import",
  ]);
  if (!kinds.has(value.kind)) {
    throw new Error("provenance.kind is invalid");
  }
  if (typeof value.source !== "string" || !value.source.trim()) {
    throw new Error("provenance.source is required");
  }
  const recordedAt = value.recordedAt ?? now;
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new Error("provenance.recordedAt must be an ISO timestamp");
  }
  return {
    kind: value.kind,
    source: value.source.trim().slice(0, 256),
    recordedAt,
    ...(value.recordedBy?.trim()
      ? { recordedBy: value.recordedBy.trim().slice(0, 128) }
      : {}),
    ...(value.sessionId?.trim()
      ? { sessionId: value.sessionId.trim().slice(0, 256) }
      : {}),
    ...(value.commitSha?.trim()
      ? { commitSha: value.commitSha.trim().slice(0, 64) }
      : {}),
  };
}

export function projectRelationshipId(
  sourceRepoId: string,
  relationType: string,
  targetRepoId: string,
): string {
  return fingerprintId(
    "prrel",
    `${sourceRepoId}\u0000${relationType}\u0000${targetRepoId}`,
  );
}

export type ParsedProjectRelationship =
  | { success: true; relationship: ProjectRelationship }
  | { success: false; error: string };

/**
 * Validate and canonicalize a relationship restored from an export.
 *
 * Imports intentionally do not call the normal upsert path: an export is a
 * snapshot and must preserve its revision and timestamps exactly. This parser
 * nevertheless applies the same identity, alias, relationship-type, and
 * provenance rules as an online upsert, and refuses IDs that do not match the
 * canonical triple.
 */
export function parseImportedProjectRelationship(
  value: unknown,
): ParsedProjectRelationship {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("relationship must be an object");
    }
    const raw = value as Record<string, unknown>;
    const sourceRepoId = validateRepositoryIdentity(
      raw.sourceRepoId,
      "sourceRepoId",
    );
    const targetRepoId = validateRepositoryIdentity(
      raw.targetRepoId,
      "targetRepoId",
    );
    if (sourceRepoId === targetRepoId) {
      throw new Error("a repository cannot relate to itself");
    }
    const relationType = normalizeRelationType(raw.relationType);
    const sourceAliases = normalizeAliases(raw.sourceAliases, sourceRepoId);
    const targetAliases = normalizeAliases(raw.targetAliases, targetRepoId);
    const id = projectRelationshipId(
      sourceRepoId,
      relationType,
      targetRepoId,
    );
    if (typeof raw.id !== "string" || raw.id !== id) {
      throw new Error(
        `id must equal the deterministic relationship ID ${id}`,
      );
    }

    if (!Array.isArray(raw.provenance) || raw.provenance.length === 0) {
      throw new Error("provenance must be a non-empty array");
    }
    const provenance: ProjectRelationshipProvenance[] = [];
    const provenanceKeys = new Set<string>();
    for (const entry of raw.provenance) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).recordedAt !== "string"
      ) {
        throw new Error("provenance.recordedAt is required");
      }
      const normalized = validateProvenance(
        entry as ProjectRelationshipUpsertInput["provenance"],
        new Date().toISOString(),
      );
      const key = provenanceKey(normalized);
      if (provenanceKeys.has(key)) {
        throw new Error("provenance contains a duplicate attribution");
      }
      provenanceKeys.add(key);
      provenance.push(normalized);
    }

    if (
      typeof raw.createdAt !== "string" ||
      !Number.isFinite(Date.parse(raw.createdAt))
    ) {
      throw new Error("createdAt must be an ISO timestamp");
    }
    if (
      typeof raw.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.updatedAt))
    ) {
      throw new Error("updatedAt must be an ISO timestamp");
    }
    if (Date.parse(raw.updatedAt) < Date.parse(raw.createdAt)) {
      throw new Error("updatedAt cannot precede createdAt");
    }
    if (!Number.isInteger(raw.revision) || (raw.revision as number) < 1) {
      throw new Error("revision must be a positive integer");
    }
    if (raw.reason !== undefined && typeof raw.reason !== "string") {
      throw new Error("reason must be a string");
    }
    const reason =
      typeof raw.reason === "string" && raw.reason.trim()
        ? raw.reason.trim().slice(0, 1_000)
        : undefined;

    return {
      success: true,
      relationship: {
        id,
        sourceRepoId,
        targetRepoId,
        relationType,
        sourceAliases,
        targetAliases,
        provenance,
        ...(reason ? { reason } : {}),
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        revision: raw.revision as number,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function provenanceKey(value: ProjectRelationshipProvenance): string {
  return [
    value.kind,
    value.source,
    value.recordedBy ?? "",
    value.sessionId ?? "",
    value.commitSha ?? "",
  ].join("\u0000");
}

function mergeAliases(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])].sort();
}

export async function upsertProjectRelationship(
  kv: StateKV,
  input: ProjectRelationshipUpsertInput,
): Promise<{
  success: boolean;
  relationship?: ProjectRelationship;
  created?: boolean;
  idempotent?: boolean;
  error?: string;
}> {
  let sourceRepoId: string;
  let targetRepoId: string;
  let relationType: string;
  let sourceAliases: string[];
  let targetAliases: string[];
  const now = new Date().toISOString();
  let provenance: ProjectRelationshipProvenance;
  try {
    sourceRepoId = validateRepositoryIdentity(
      input.sourceRepoId,
      "sourceRepoId",
    );
    targetRepoId = validateRepositoryIdentity(
      input.targetRepoId,
      "targetRepoId",
    );
    if (sourceRepoId === targetRepoId) {
      return { success: false, error: "a repository cannot relate to itself" };
    }
    relationType = normalizeRelationType(input.relationType);
    sourceAliases = normalizeAliases(input.sourceAliases, sourceRepoId);
    targetAliases = normalizeAliases(input.targetAliases, targetRepoId);
    provenance = validateProvenance(input.provenance, now);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const id = projectRelationshipId(
    sourceRepoId,
    relationType,
    targetRepoId,
  );
  return withKeyedLock(`project-relationship:${id}`, async () => {
    const existing = await kv.get<ProjectRelationship>(
      KV.projectRelationships,
      id,
    );
    if (!existing) {
      if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
        return {
          success: false,
          error: "project_relationship_revision_conflict",
        };
      }
      const relationship: ProjectRelationship = {
        id,
        sourceRepoId,
        targetRepoId,
        relationType,
        sourceAliases,
        targetAliases,
        provenance: [provenance],
        ...(input.reason?.trim()
          ? { reason: input.reason.trim().slice(0, 1_000) }
          : {}),
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      await kv.set(KV.projectRelationships, id, relationship);
      await safeAudit(kv, "relation_create", "mem::project-relationship-upsert", [id], {
        sourceRepoId,
        targetRepoId,
        relationType,
        revision: 1,
      });
      return { success: true, relationship, created: true };
    }

    const nextSourceAliases = mergeAliases(
      existing.sourceAliases ?? [],
      sourceAliases,
    );
    const nextTargetAliases = mergeAliases(
      existing.targetAliases ?? [],
      targetAliases,
    );
    const keys = new Set((existing.provenance ?? []).map(provenanceKey));
    const nextProvenance = keys.has(provenanceKey(provenance))
      ? (existing.provenance ?? [])
      : [...(existing.provenance ?? []), provenance];
    const nextReason = input.reason?.trim()
      ? input.reason.trim().slice(0, 1_000)
      : existing.reason;
    const changed =
      nextSourceAliases.length !== (existing.sourceAliases ?? []).length ||
      nextTargetAliases.length !== (existing.targetAliases ?? []).length ||
      nextProvenance.length !== (existing.provenance ?? []).length ||
      nextReason !== existing.reason;
    if (!changed) {
      return { success: true, relationship: existing, idempotent: true };
    }
    if (input.expectedRevision !== existing.revision) {
      return {
        success: false,
        error: "project_relationship_revision_conflict",
      };
    }
    const relationship: ProjectRelationship = {
      ...existing,
      sourceAliases: nextSourceAliases,
      targetAliases: nextTargetAliases,
      provenance: nextProvenance,
      ...(nextReason ? { reason: nextReason } : {}),
      updatedAt: now,
      revision: existing.revision + 1,
    };
    await kv.set(KV.projectRelationships, id, relationship);
    await safeAudit(kv, "relation_update", "mem::project-relationship-upsert", [id], {
      sourceRepoId,
      targetRepoId,
      relationType,
      revision: relationship.revision,
    });
    return { success: true, relationship, created: false };
  });
}

function identitySet(relationship: ProjectRelationship, side: "source" | "target"): Set<string> {
  const canonical =
    side === "source"
      ? relationship.sourceRepoId
      : relationship.targetRepoId;
  const aliases =
    side === "source"
      ? relationship.sourceAliases
      : relationship.targetAliases;
  return new Set([canonical, ...(aliases ?? [])].map(normalizeRepositoryIdentity));
}

export async function listProjectRelationships(
  kv: StateKV,
  input: ProjectRelationshipListInput = {},
): Promise<ProjectRelationship[]> {
  const repoId = input.repoId
    ? validateRepositoryIdentity(input.repoId, "repoId")
    : undefined;
  const direction = input.direction ?? "both";
  const relationType = input.relationType
    ? normalizeRelationType(input.relationType)
    : undefined;
  const relationships = await kv.list<ProjectRelationship>(
    KV.projectRelationships,
  );
  return relationships
    .filter((relationship) => {
      if (relationType && relationship.relationType !== relationType) {
        return false;
      }
      if (!repoId) return true;
      const sourceMatch = identitySet(relationship, "source").has(repoId);
      const targetMatch = identitySet(relationship, "target").has(repoId);
      if (direction === "outgoing") return sourceMatch;
      if (direction === "incoming") return targetMatch;
      return sourceMatch || targetMatch;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function relatedRepositoryIds(
  kv: StateKV,
  repoId: string,
): Promise<string[]> {
  const normalized = validateRepositoryIdentity(repoId, "repoId");
  const relationships = await listProjectRelationships(kv, {
    repoId: normalized,
    direction: "both",
  });
  const related = new Set<string>();
  for (const relationship of relationships) {
    if (identitySet(relationship, "source").has(normalized)) {
      related.add(relationship.targetRepoId);
    }
    if (identitySet(relationship, "target").has(normalized)) {
      related.add(relationship.sourceRepoId);
    }
  }
  related.delete(normalized);
  return [...related].sort();
}

/**
 * Return every explicit identity for repositories related to `repoId`.
 * Canonical IDs remain authoritative, while stored aliases let retrieval
 * classify legacy project labels without rewriting or merging old memories.
 */
export async function relatedRepositoryIdentities(
  kv: StateKV,
  repoId: string,
): Promise<string[]> {
  return (await repositoryRelationshipIdentityScope(kv, repoId)).related;
}

export async function repositoryRelationshipIdentityScope(
  kv: StateKV,
  repoId: string,
): Promise<{ current: string[]; related: string[] }> {
  const normalized = validateRepositoryIdentity(repoId, "repoId");
  const relationships = await listProjectRelationships(kv, {
    repoId: normalized,
    direction: "both",
  });
  const related = new Set<string>();
  const current = new Set<string>([normalized]);
  for (const relationship of relationships) {
    const source = identitySet(relationship, "source");
    const target = identitySet(relationship, "target");
    if (source.has(normalized)) {
      for (const identity of source) current.add(identity);
      for (const identity of target) related.add(identity);
    }
    if (target.has(normalized)) {
      for (const identity of target) current.add(identity);
      for (const identity of source) related.add(identity);
    }
  }
  for (const identity of current) related.delete(identity);
  return {
    current: [...current].sort(),
    related: [...related].sort(),
  };
}

export function registerProjectRelationshipsFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction(
    "mem::project-relationship-upsert",
    async (data: ProjectRelationshipUpsertInput) =>
      upsertProjectRelationship(kv, data),
  );
  sdk.registerFunction(
    "mem::project-relationship-list",
    async (data: ProjectRelationshipListInput) => ({
      success: true,
      relationships: await listProjectRelationships(kv, data),
    }),
  );
}
