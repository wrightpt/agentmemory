import { describe, expect, it, vi } from "vitest";

vi.mock("../src/functions/audit.js", () => ({ safeAudit: vi.fn() }));
vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import {
  listProjectRelationships,
  normalizeRepositoryIdentity,
  parseImportedProjectRelationship,
  projectRelationshipId,
  relatedRepositoryIdentities,
  relatedRepositoryIds,
  repositoryRelationshipIdentityScope,
  upsertProjectRelationship,
} from "../src/functions/project-relationships.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      [...(store.get(scope)?.values() ?? [])] as T[],
  };
}

const provenance = {
  kind: "registry" as const,
  source: "projects.yaml",
  recordedAt: "2026-08-21T00:00:00.000Z",
};

describe("project relationships", () => {
  it("normalizes HTTPS and SCP-style repository identities", () => {
    expect(
      normalizeRepositoryIdentity("https://github.com/WrightPT/AgentMemory.git"),
    ).toBe("wrightpt/agentmemory");
    expect(
      normalizeRepositoryIdentity("git@github.com:WrightPT/AgentMemory.git"),
    ).toBe("wrightpt/agentmemory");
    expect(
      normalizeRepositoryIdentity(
        "ssh://git@git.example.com/Platform/AgentMemory.git",
      ),
    ).toBe("git.example.com/Platform/AgentMemory");
    expect(
      normalizeRepositoryIdentity("git.example.com/Platform/AgentMemory"),
    ).toBe("git.example.com/Platform/AgentMemory");
  });

  it("upserts a directional relationship with deterministic identity", async () => {
    const kv = mockKV();
    const first = await upsertProjectRelationship(kv as never, {
      sourceRepoId: "wrightpt/workstation-shell",
      targetRepoId: "wrightpt/agentmemory",
      relationType: "uses",
      sourceAliases: ["workstation-shell"],
      targetAliases: ["agentmemory"],
      provenance,
    });
    const repeat = await upsertProjectRelationship(kv as never, {
      sourceRepoId: "wrightpt/workstation-shell",
      targetRepoId: "wrightpt/agentmemory",
      relationType: "uses",
      sourceAliases: ["workstation-shell"],
      targetAliases: ["agentmemory"],
      provenance,
    });

    expect(first.success).toBe(true);
    expect(first.created).toBe(true);
    expect(repeat.idempotent).toBe(true);
    expect(repeat.relationship?.id).toBe(first.relationship?.id);
    expect((await listProjectRelationships(kv as never)).length).toBe(1);
  });

  it("requires a matching revision for material updates", async () => {
    const kv = mockKV();
    const first = await upsertProjectRelationship(kv as never, {
      sourceRepoId: "wrightpt/trading-system",
      targetRepoId: "wrightpt/repo-brain",
      relationType: "governed_by",
      provenance,
    });
    const conflict = await upsertProjectRelationship(kv as never, {
      sourceRepoId: "wrightpt/trading-system",
      targetRepoId: "wrightpt/repo-brain",
      relationType: "governed_by",
      reason: "mission policy",
      provenance,
    });
    const updated = await upsertProjectRelationship(kv as never, {
      sourceRepoId: "wrightpt/trading-system",
      targetRepoId: "wrightpt/repo-brain",
      relationType: "governed_by",
      reason: "mission policy",
      expectedRevision: first.relationship?.revision,
      provenance,
    });

    expect(conflict).toEqual({
      success: false,
      error: "project_relationship_revision_conflict",
    });
    expect(updated.relationship?.revision).toBe(2);
  });

  it("queries direction while related-project ranking can traverse either side", async () => {
    const kv = mockKV();
    await upsertProjectRelationship(kv as never, {
      sourceRepoId: "wrightpt/workstation-shell",
      targetRepoId: "wrightpt/agentmemory",
      relationType: "uses",
      sourceAliases: ["shell"],
      targetAliases: ["memory"],
      provenance,
    });

    const incoming = await listProjectRelationships(kv as never, {
      repoId: "memory",
      direction: "incoming",
    });
    const outgoing = await listProjectRelationships(kv as never, {
      repoId: "memory",
      direction: "outgoing",
    });
    expect(incoming).toHaveLength(1);
    expect(outgoing).toHaveLength(0);
    expect(await relatedRepositoryIds(kv as never, "memory")).toEqual([
      "wrightpt/workstation-shell",
    ]);
    expect(await relatedRepositoryIdentities(kv as never, "memory")).toEqual([
      "shell",
      "wrightpt/workstation-shell",
    ]);
    expect(
      await repositoryRelationshipIdentityScope(kv as never, "memory"),
    ).toEqual({
      current: ["memory", "wrightpt/agentmemory"],
      related: ["shell", "wrightpt/workstation-shell"],
    });
  });

  it("keeps unrelated same-basename repositories separate", async () => {
    const kv = mockKV();
    await upsertProjectRelationship(kv as never, {
      sourceRepoId: "org-a/api",
      targetRepoId: "org-a/platform",
      relationType: "uses",
      provenance,
    });
    expect(await relatedRepositoryIds(kv as never, "org-b/api")).toEqual([]);
  });

  it("validates imported relationship snapshot invariants", () => {
    const sourceRepoId = "git.example.com/Platform/AgentMemory";
    const targetRepoId = "wrightpt/workstation-shell";
    const relationship = {
      id: projectRelationshipId(sourceRepoId, "uses", targetRepoId),
      sourceRepoId,
      targetRepoId,
      relationType: "uses",
      sourceAliases: ["agentmemory"],
      targetAliases: ["workstation-shell"],
      provenance: [provenance],
      reason: "Shell integration uses AgentMemory.",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      revision: 1,
    };

    expect(parseImportedProjectRelationship(relationship)).toEqual({
      success: true,
      relationship,
    });
    expect(
      parseImportedProjectRelationship({
        ...relationship,
        id: "prrel_attacker_chosen",
      }),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("deterministic relationship ID"),
    });
    expect(
      parseImportedProjectRelationship({ ...relationship, revision: 0 }),
    ).toEqual({
      success: false,
      error: "revision must be a positive integer",
    });
    expect(
      parseImportedProjectRelationship({
        ...relationship,
        provenance: [provenance, provenance],
      }),
    ).toEqual({
      success: false,
      error: "provenance contains a duplicate attribution",
    });
    expect(
      parseImportedProjectRelationship({
        ...relationship,
        provenance: [{ kind: "import", source: "fixture" }],
      }),
    ).toEqual({
      success: false,
      error: "provenance.recordedAt is required",
    });
  });

  it("canonicalizes imported GitHub identities without changing snapshot metadata", () => {
    const id = projectRelationshipId(
      "wrightpt/workstation-shell",
      "uses",
      "wrightpt/agentmemory",
    );
    expect(
      parseImportedProjectRelationship({
        id,
        sourceRepoId:
          "https://github.com/WrightPT/Workstation-Shell.git",
        targetRepoId: "git@github.com:WrightPT/AgentMemory.git",
        relationType: "USES",
        sourceAliases: ["Workstation-Shell", "shell"],
        targetAliases: ["AgentMemory"],
        provenance: [provenance],
        createdAt: "2026-08-21T01:00:00Z",
        updatedAt: "2026-08-21T02:00:00Z",
        revision: 4,
      }),
    ).toEqual({
      success: true,
      relationship: {
        id,
        sourceRepoId: "wrightpt/workstation-shell",
        targetRepoId: "wrightpt/agentmemory",
        relationType: "uses",
        sourceAliases: ["shell", "workstation-shell"],
        targetAliases: ["agentmemory"],
        provenance: [provenance],
        createdAt: "2026-08-21T01:00:00Z",
        updatedAt: "2026-08-21T02:00:00Z",
        revision: 4,
      },
    });
  });
});
