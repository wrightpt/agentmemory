import { describe, expect, it } from "vitest";
import type { CompressedObservation, Memory, Session } from "../src/types.js";
import {
  compactRetrievalProvenance,
  resolveRetrievalProvenance,
} from "../src/state/provenance.js";
import { memoryToObservation } from "../src/state/memory-utils.js";

function mockKV(session?: Session | Session[]) {
  const sessions = session
    ? Array.isArray(session)
      ? session
      : [session]
    : [];
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      if (scope === "mem:sessions") {
        return (
          (sessions.find((candidate) => candidate.id === key) as T) ?? null
        );
      }
      return null;
    },
  };
}

const observation: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-08-20T00:00:00.000Z",
  type: "decision",
  title: "Launch authority",
  facts: [],
  narrative: "Use the broker",
  concepts: [],
  files: ["src/launch.ts"],
  importance: 9,
  confidence: 0.9,
  agentId: "codex",
};

const session: Session = {
  id: "ses_1",
  project: "workstation-shell",
  cwd: "/worktrees/task",
  repoRoot: "/repos/workstation-shell",
  worktree: "/worktrees/task",
  branch: "agent/launch",
  canonicalRepoId: "wrightpt/workstation-shell",
  repoRemote: "https://github.com/wrightpt/workstation-shell",
  terminalSession: "shared-codex-launch",
  missionId: "mission_1",
  missionTitle: "DSH integration",
  missionRole: "worker",
  parentSession: "shared-codex-lead",
  commitSha: "a".repeat(40),
  startedAt: "2026-08-20T00:00:00.000Z",
  status: "active",
  observationCount: 1,
  agentId: "codex",
};

describe("retrieval provenance", () => {
  it("resolves repository, mission, agent, source, and commit attribution", async () => {
    const result = await resolveRetrievalProvenance(
      mockKV(session) as never,
      observation,
      null,
    );
    expect(result).toMatchObject({
      project: "workstation-shell",
      canonicalRepoId: "wrightpt/workstation-shell",
      sessionId: "ses_1",
      agentId: "codex",
      missionId: "mission_1",
      branch: "agent/launch",
      commitSha: "a".repeat(40),
      observationId: "obs_1",
      memoryType: "decision",
      attributed: true,
    });
    expect(result.files).toEqual(["src/launch.ts"]);
  });

  it("retains durable-memory lifecycle and project when no session exists", async () => {
    const memory: Memory = {
      id: "mem_1",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      type: "architecture",
      title: "Architecture choice",
      content: "Reason",
      concepts: [],
      files: [],
      sessionIds: [],
      strength: 10,
      version: 2,
      supersedes: ["mem_old"],
      isLatest: true,
      project: "global",
      agentId: "kimi",
    };
    const result = await resolveRetrievalProvenance(
      mockKV() as never,
      { ...observation, id: memory.id, sessionId: "memory" },
      memory,
    );
    expect(result).toMatchObject({
      project: "global",
      memoryId: "mem_1",
      memoryType: "architecture",
      isLatest: true,
      supersedes: ["mem_old"],
      importance: 10,
      agentId: "kimi",
    });
  });

  it("prefers immutable write-time attribution over mutable current session context", async () => {
    const result = await resolveRetrievalProvenance(
      mockKV({
        ...session,
        canonicalRepoId: "other/current-repo",
        project: "current-repo",
        branch: "main",
        commitSha: "b".repeat(40),
        missionId: "mission_current",
      }) as never,
      {
        ...observation,
        attribution: {
          project: "workstation-shell",
          projectAliases: ["workstation"],
          canonicalRepoId: "wrightpt/workstation-shell",
          branch: "agent/launch",
          commitSha: "a".repeat(40),
          missionId: "mission_1",
        },
      },
      null,
    );
    expect(result).toMatchObject({
      project: "workstation-shell",
      projectAliases: ["workstation"],
      canonicalRepoId: "wrightpt/workstation-shell",
      branch: "agent/launch",
      commitSha: "a".repeat(40),
      missionId: "mission_1",
    });
  });

  it("does not fill a partial immutable snapshot from mutable session state", async () => {
    const result = await resolveRetrievalProvenance(
      mockKV({
        ...session,
        project: "mutable-project",
        branch: "mutable-branch",
        commitSha: "b".repeat(40),
        missionId: "mutable-mission",
        agentId: "kimi",
      }) as never,
      {
        ...observation,
        agentId: undefined,
        attribution: {
          canonicalRepoId: "wrightpt/workstation-shell",
        },
      },
      null,
    );

    expect(result).toMatchObject({
      canonicalRepoId: "wrightpt/workstation-shell",
      sessionId: session.id,
    });
    expect(result).not.toHaveProperty("project");
    expect(result).not.toHaveProperty("branch");
    expect(result).not.toHaveProperty("commitSha");
    expect(result).not.toHaveProperty("missionId");
    expect(result).not.toHaveProperty("agentId");
  });

  it("projects all composite source sessions without inventing a singular session", async () => {
    const secondSession: Session = {
      ...session,
      id: "ses_2",
      agentId: "kimi",
      branch: "kimi-current-branch",
    };
    const memory: Memory = {
      id: "mem_composite",
      createdAt: "2026-08-20T01:00:00.000Z",
      updatedAt: "2026-08-20T01:00:00.000Z",
      type: "architecture",
      title: "Composite decision",
      content: "A cross-agent conclusion",
      concepts: [],
      files: [],
      sessionIds: [secondSession.id, session.id, session.id],
      strength: 8,
      version: 1,
      isLatest: true,
      attribution: {
        project: "workstation-shell",
        canonicalRepoId: "wrightpt/workstation-shell",
      },
    };
    const result = await resolveRetrievalProvenance(
      mockKV([session, secondSession]) as never,
      {
        ...observation,
        id: memory.id,
        sessionId: "memory",
        agentId: undefined,
        attribution: memory.attribution,
      },
      memory,
    );

    expect(result).toMatchObject({
      memoryId: memory.id,
      project: "workstation-shell",
      canonicalRepoId: "wrightpt/workstation-shell",
      sessionIds: [session.id, secondSession.id],
    });
    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("agentId");
    expect(result).not.toHaveProperty("branch");

    const compact = compactRetrievalProvenance(result);
    expect(compact.sessionIds).toEqual([session.id, secondSession.id]);
    expect(compact).not.toHaveProperty("sessionId");

    // Search indexes still need one locator to hydrate the Memory from KV.
    // That internal implementation detail must not become public provenance.
    expect(memoryToObservation(memory).sessionId).toBe(secondSession.id);
  });

  it("preserves singular provenance for an individual legacy memory", async () => {
    const memory: Memory = {
      id: "mem_individual",
      createdAt: "2026-08-20T01:00:00.000Z",
      updatedAt: "2026-08-20T01:00:00.000Z",
      type: "fact",
      title: "Individual fact",
      content: "One source session",
      concepts: [],
      files: [],
      sessionIds: [session.id, session.id],
      strength: 7,
      version: 1,
      isLatest: true,
    };

    const result = await resolveRetrievalProvenance(
      mockKV(session) as never,
      memoryToObservation(memory),
      memory,
    );

    expect(result.sessionId).toBe(session.id);
    expect(result).not.toHaveProperty("sessionIds");
    expect(result).toMatchObject({
      project: session.project,
      canonicalRepoId: session.canonicalRepoId,
      agentId: session.agentId,
    });
  });

  it("produces a bounded compact projection", async () => {
    const full = await resolveRetrievalProvenance(
      mockKV(session) as never,
      observation,
      null,
    );
    const compact = compactRetrievalProvenance(full);
    expect(compact).toMatchObject({
      canonicalRepoId: "wrightpt/workstation-shell",
      missionId: "mission_1",
      agentId: "codex",
      attributed: true,
    });
    expect(compact).not.toHaveProperty("repoRoot");
    expect(compact).not.toHaveProperty("files");
  });
});
