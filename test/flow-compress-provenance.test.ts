import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/audit.js", () => ({
  recordAudit: vi.fn(),
}));

const searchMocks = vi.hoisted(() => ({
  add: vi.fn(),
  scheduleIndexSave: vi.fn(),
  vectorIndexAddGuarded: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: searchMocks.add }),
  scheduleIndexSave: searchMocks.scheduleIndexSave,
  vectorIndexAddGuarded: searchMocks.vectorIndexAddGuarded,
}));

import { registerFlowCompressFunction } from "../src/functions/flow-compress.js";
import { KV } from "../src/state/schema.js";
import type {
  Action,
  CompressedObservation,
  Memory,
  MemoryProvider,
  Session,
} from "../src/types.js";

function makeMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const getCalls: Array<{ scope: string; key: string }> = [];
  return {
    store,
    getCalls,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      getCalls.push({ scope, key });
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function makeMockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const handler = functions.get(id);
      if (!handler) throw new Error(`No function registered: ${id}`);
      return handler(payload);
    },
  };
}

function makeProvider(): MemoryProvider {
  return {
    name: "mock",
    summarize: vi.fn().mockResolvedValue(
      `<summary>
        <goal>Ship canonical memory</goal>
        <outcome>Completed safely</outcome>
        <steps>One deterministic step</steps>
        <discoveries>Attribution matters</discoveries>
        <lesson>Preserve provenance</lesson>
      </summary>`,
    ),
    compress: vi.fn().mockResolvedValue(""),
    embed: vi.fn().mockResolvedValue(new Float32Array(384)),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: 384,
    compressionModel: "mock-model",
  } as MemoryProvider;
}

function makeAction(id: string, overrides: Partial<Action> = {}): Action {
  return {
    id,
    title: `Action ${id}`,
    description: "Complete the workflow",
    status: "done",
    priority: 5,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T01:00:00.000Z",
    createdBy: "codex",
    project: "agentmemory",
    tags: ["institutional-memory"],
    sourceObservationIds: [],
    sourceMemoryIds: [],
    ...overrides,
  };
}

function makeSession(
  id: string,
  canonicalRepoId: string,
  agentId: string,
): Session {
  return {
    id,
    project: "agentmemory",
    cwd: `/worktrees/${id}`,
    repoRoot: "/repos/agentmemory",
    worktree: `/worktrees/${id}`,
    branch: "mutable-current-branch",
    commitSha: "b".repeat(40),
    canonicalRepoId,
    agentId,
    startedAt: "2026-08-20T00:00:00.000Z",
    status: "completed",
    observationCount: 1,
  };
}

function makeObservation(
  id: string,
  session: Session,
  branch: string,
): CompressedObservation {
  return {
    id,
    sessionId: session.id,
    timestamp: "2026-08-20T00:30:00.000Z",
    type: "decision",
    title: "Canonical workflow decision",
    facts: [],
    narrative: "Keep the source attribution immutable.",
    concepts: ["institutional-memory"],
    files: ["src/memory.ts"],
    importance: 9,
    agentId: session.agentId,
    attribution: {
      project: session.project,
      canonicalRepoId: session.canonicalRepoId,
      repoRoot: session.repoRoot,
      worktree: session.worktree,
      branch,
      commitSha: "a".repeat(40),
    },
  };
}

describe("mem::flow-compress provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds a workflow memory to its uniquely resolved source session and immutable observation attribution", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider();
    const session = makeSession("ses_source", "wrightpt/agentmemory", "codex");
    session.missionId = "mutable-session-mission";
    const observation = makeObservation(
      "obs_source",
      session,
      "write-time-branch",
    );
    const action = makeAction("act_source", {
      project: undefined,
      sourceObservationIds: [observation.id],
    });
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), observation.id, observation);
    await kv.set(KV.actions, action.id, action);

    registerFlowCompressFunction(sdk as never, kv as never, provider);
    const result = (await sdk.trigger("mem::flow-compress", {
      actionIds: [action.id],
    })) as { memoryId: string };
    const memory = await kv.get<Memory>(KV.memories, result.memoryId);

    expect(memory).toMatchObject({
      project: "agentmemory",
      sessionIds: [session.id],
      sourceObservationIds: [observation.id],
      agentId: "codex",
      attribution: {
        canonicalRepoId: "wrightpt/agentmemory",
        branch: "write-time-branch",
        commitSha: "a".repeat(40),
      },
    });
    expect(searchMocks.add).toHaveBeenCalledTimes(1);
    expect(memory?.attribution?.missionId).toBeUndefined();
    expect(searchMocks.vectorIndexAddGuarded).toHaveBeenCalledWith(
      result.memoryId,
      session.id,
      expect.any(String),
      { kind: "memory", logId: result.memoryId },
    );
  });

  it("retains deterministic action project and worktree context without a source observation", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider();
    const action = makeAction("act_structured", {
      project: undefined,
      projectId: "agentmemory",
      projectAliases: ["memory-engine"],
      repoRoot: "/repos/agentmemory",
      worktree: "/worktrees/memory",
      branch: "feature/memory",
    });
    await kv.set(KV.actions, action.id, action);

    registerFlowCompressFunction(sdk as never, kv as never, provider);
    const result = (await sdk.trigger("mem::flow-compress", {
      actionIds: [action.id],
    })) as { memoryId: string };
    const memory = await kv.get<Memory>(KV.memories, result.memoryId);

    expect(memory).toMatchObject({
      project: "agentmemory",
      sessionIds: [],
      sourceObservationIds: [],
      agentId: "codex",
      attribution: {
        project: "agentmemory",
        projectAliases: ["memory-engine"],
        repoRoot: "/repos/agentmemory",
        worktree: "/worktrees/memory",
        branch: "feature/memory",
      },
    });
  });

  it("rejects source observations that span canonical repositories before synthesis or storage", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider();
    const firstSession = makeSession(
      "ses_first",
      "wrightpt/agentmemory",
      "codex",
    );
    const secondSession = makeSession(
      "ses_second",
      "other/agentmemory",
      "kimi",
    );
    const firstObservation = makeObservation(
      "obs_first",
      firstSession,
      "first-write",
    );
    const secondObservation = makeObservation(
      "obs_second",
      secondSession,
      "second-write",
    );
    const firstAction = makeAction("act_first", {
      createdBy: "codex",
      sourceObservationIds: [firstObservation.id],
    });
    const secondAction = makeAction("act_second", {
      createdBy: "kimi",
      sourceObservationIds: [secondObservation.id],
    });
    for (const session of [firstSession, secondSession]) {
      await kv.set(KV.sessions, session.id, session);
    }
    await kv.set(
      KV.observations(firstSession.id),
      firstObservation.id,
      firstObservation,
    );
    await kv.set(
      KV.observations(secondSession.id),
      secondObservation.id,
      secondObservation,
    );
    await kv.set(KV.actions, firstAction.id, firstAction);
    await kv.set(KV.actions, secondAction.id, secondAction);

    registerFlowCompressFunction(sdk as never, kv as never, provider);
    const result = await sdk.trigger("mem::flow-compress", {
      actionIds: [firstAction.id, secondAction.id],
    });

    expect(result).toMatchObject({
      success: false,
      error: "flow sources have conflicting repository identities",
      compressed: 0,
    });
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(await kv.list<Memory>(KV.memories)).toEqual([]);
    expect(searchMocks.add).not.toHaveBeenCalled();
  });

  it("rejects conflicting action projects before source lookup, synthesis, or storage", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider();
    const first = makeAction("act_first_project", { project: "agentmemory" });
    const second = makeAction("act_second_project", {
      project: "trading-system",
    });
    await kv.set(KV.actions, first.id, first);
    await kv.set(KV.actions, second.id, second);

    registerFlowCompressFunction(sdk as never, kv as never, provider);
    const result = await sdk.trigger("mem::flow-compress", {
      actionIds: [first.id, second.id],
    });

    expect(result).toMatchObject({
      success: false,
      error: "flow actions have conflicting project identities",
      compressed: 0,
    });
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(await kv.list<Memory>(KV.memories)).toEqual([]);
    expect(
      kv.getCalls.filter(({ scope }) => scope.startsWith("mem:obs:")),
    ).toEqual([]);
  });

  it("rejects an explicit project that conflicts with the selected actions", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider();
    const action = makeAction("act_explicit_mismatch", {
      project: "agentmemory",
    });
    await kv.set(KV.actions, action.id, action);

    registerFlowCompressFunction(sdk as never, kv as never, provider);
    const result = await sdk.trigger("mem::flow-compress", {
      actionIds: [action.id],
      project: "trading-system",
    });

    expect(result).toMatchObject({
      success: false,
      error: "requested project trading-system conflicts with flow actions",
      compressed: 0,
    });
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(await kv.list<Memory>(KV.memories)).toEqual([]);
  });

  it("rejects a resolved source project that conflicts with the action project", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider();
    const session = makeSession(
      "ses_source_project",
      "wrightpt/agentmemory",
      "codex",
    );
    const observation = makeObservation(
      "obs_source_project",
      session,
      "write-time-branch",
    );
    const action = makeAction("act_source_project", {
      project: "trading-system",
      sourceObservationIds: [observation.id],
    });
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), observation.id, observation);
    await kv.set(KV.actions, action.id, action);

    registerFlowCompressFunction(sdk as never, kv as never, provider);
    const result = await sdk.trigger("mem::flow-compress", {
      actionIds: [action.id],
    });

    expect(result).toMatchObject({
      success: false,
      error: "flow source project conflicts with flow actions",
      compressed: 0,
    });
    expect(provider.summarize).not.toHaveBeenCalled();
    expect(await kv.list<Memory>(KV.memories)).toEqual([]);
  });

  it("bounds legacy source resolution and retains action-derived attribution", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider();
    const sourceObservationIds = Array.from(
      { length: 256 },
      (_, index) => `obs_${index.toString().padStart(3, "0")}`,
    );
    const action = makeAction("act_bounded", {
      sourceObservationIds,
      repoRoot: "/repos/agentmemory",
      branch: "feature/bounded-flow",
    });
    await kv.set(KV.actions, action.id, action);
    for (let index = 0; index < 17; index++) {
      const session = makeSession(
        `ses_${index.toString().padStart(2, "0")}`,
        "wrightpt/agentmemory",
        "codex",
      );
      await kv.set(KV.sessions, session.id, session);
    }

    registerFlowCompressFunction(sdk as never, kv as never, provider);
    const result = (await sdk.trigger("mem::flow-compress", {
      actionIds: [action.id],
    })) as { success: true; memoryId: string };
    const memory = await kv.get<Memory>(KV.memories, result.memoryId);

    expect(result.success).toBe(true);
    expect(memory).toMatchObject({
      project: "agentmemory",
      sessionIds: [],
      sourceObservationIds,
      attribution: {
        project: "agentmemory",
        repoRoot: "/repos/agentmemory",
        branch: "feature/bounded-flow",
      },
    });
    expect(
      kv.getCalls.filter(({ scope }) => scope.startsWith("mem:obs:")),
    ).toEqual([]);
    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });
});
