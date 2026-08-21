import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/audit.js", () => ({
  recordAudit: vi.fn(),
}));

const searchMocks = vi.hoisted(() => ({
  add: vi.fn(),
  remove: vi.fn(),
  scheduleIndexSave: vi.fn(),
  vectorIndexAddGuarded: vi.fn().mockResolvedValue(true),
  vectorIndexRemove: vi.fn().mockResolvedValue(true),
}));

vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({
    add: searchMocks.add,
    remove: searchMocks.remove,
  }),
  scheduleIndexSave: searchMocks.scheduleIndexSave,
  vectorIndexAddGuarded: searchMocks.vectorIndexAddGuarded,
  vectorIndexRemove: searchMocks.vectorIndexRemove,
}));

import { registerConsolidateFunction } from "../src/functions/consolidate.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  Memory,
  MemoryProvider,
  Session,
} from "../src/types.js";

function makeMockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function makeMockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string"
          ? data
          : (idOrInput as { payload: unknown }).payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function registered: ${id}`);
      return fn(payload);
    },
  };
}

function makeProvider(title = "synthesized memory title"): MemoryProvider {
  return {
    name: "mock",
    compress: vi.fn().mockResolvedValue(
      `<memory>
        <type>pattern</type>
        <title>${title}</title>
        <content>synthesized content about the concept</content>
        <concepts><concept>auth</concept></concepts>
        <files><file>src/auth.ts</file></files>
        <strength>7</strength>
      </memory>`,
    ),
    embed: vi.fn().mockResolvedValue(new Float32Array(384)),
    embedBatch: vi.fn().mockResolvedValue([]),
    dimensions: 384,
    compressionModel: "mock-model",
  };
}

function makeSession(
  id: string,
  project: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    project,
    cwd: `/srv/${project}`,
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: 5,
    ...overrides,
  };
}

function makeObs(
  id: string,
  sessionId: string,
  concept: string,
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "decision",
    title: `${concept} observation ${id}`,
    facts: [`fact about ${concept}`],
    narrative: `detailed narrative about ${concept} pattern usage`,
    concepts: [concept],
    files: ["src/auth.ts"],
    importance: 8,
    ...overrides,
  };
}

function makeExistingMemory(
  id: string,
  title: string,
  project?: string,
): Memory {
  return {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "pattern",
    title,
    content: "existing content",
    concepts: ["auth"],
    files: ["src/auth.ts"],
    sessionIds: [],
    strength: 6,
    version: 1,
    isLatest: true,
    ...(project !== undefined && { project }),
  };
}

describe("mem::consolidate — cross-project existingMatch guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not evolve a memory from a different project even when titles match", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider("synthesized memory title");

    // A memory scoped to "web" with the same title the provider will generate
    const webMemory = makeExistingMemory(
      "mem_web",
      "synthesized memory title",
      "web",
    );
    await kv.set(KV.memories, webMemory.id, webMemory);

    // Session and observations for "api" project
    const apiSession = makeSession("sess_api", "api");
    await kv.set(KV.sessions, apiSession.id, apiSession);
    for (let i = 0; i < 3; i++) {
      await kv.set(
        KV.observations(apiSession.id),
        `obs_${i}`,
        makeObs(`obs_${i}`, apiSession.id, "auth"),
      );
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    await sdk.trigger("mem::consolidate", {
      project: "api",
      minObservations: 1,
    });

    // The web memory must remain untouched — isLatest still true
    const webStored = await kv.get<Memory>(KV.memories, webMemory.id);
    expect(webStored?.isLatest).toBe(true);
    expect(webStored?.project).toBe("web");

    // A new "api" memory should have been created
    const allMemories = await kv.list<Memory>(KV.memories);
    const apiMemories = allMemories.filter(
      (m) => m.project === "api" && m.isLatest,
    );
    expect(apiMemories).toHaveLength(1);
    expect(apiMemories[0].title).toBe("synthesized memory title");
  });

  it("evolves an existing memory within the same project when titles match", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider("synthesized memory title");

    // A memory already scoped to "api" with the same title
    const apiMemory = makeExistingMemory(
      "mem_api_old",
      "synthesized memory title",
      "api",
    );
    await kv.set(KV.memories, apiMemory.id, apiMemory);

    const apiSession = makeSession("sess_api", "api");
    await kv.set(KV.sessions, apiSession.id, apiSession);
    for (let i = 0; i < 3; i++) {
      await kv.set(
        KV.observations(apiSession.id),
        `obs_${i}`,
        makeObs(`obs_${i}`, apiSession.id, "auth"),
      );
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    await sdk.trigger("mem::consolidate", {
      project: "api",
      minObservations: 1,
    });

    // The old api memory should have been marked non-latest (evolved)
    const oldMemory = await kv.get<Memory>(KV.memories, apiMemory.id);
    expect(oldMemory?.isLatest).toBe(false);

    // A new evolved memory should exist
    const allMemories = await kv.list<Memory>(KV.memories);
    const latestApi = allMemories.filter(
      (m) => m.project === "api" && m.isLatest,
    );
    expect(latestApi).toHaveLength(1);
    expect(latestApi[0].id).not.toBe(apiMemory.id);
    expect(latestApi[0].parentId).toBe(apiMemory.id);
  });

  it("does not let an unscoped run evolve a different legacy project", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider("synthesized memory title");

    // A scoped memory from a different project must not be selected merely
    // because an unscoped/background run generated the same title.
    const scopedMemory = makeExistingMemory(
      "mem_api_old",
      "synthesized memory title",
      "api",
    );
    await kv.set(KV.memories, scopedMemory.id, scopedMemory);

    // Session with no project restriction — unscoped consolidation
    const session = makeSession("sess_any", "any");
    await kv.set(KV.sessions, session.id, session);
    for (let i = 0; i < 3; i++) {
      await kv.set(
        KV.observations(session.id),
        `obs_${i}`,
        makeObs(`obs_${i}`, session.id, "auth"),
      );
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    // No project passed — unscoped consolidation
    await sdk.trigger("mem::consolidate", { minObservations: 1 });

    // Project fallback remains explicit even for a background run.
    const old = await kv.get<Memory>(KV.memories, scopedMemory.id);
    expect(old?.isLatest).toBe(true);

    // The new result remains unscoped at the legacy field while its immutable
    // attribution identifies the source project.
    const allMemories = await kv.list<Memory>(KV.memories);
    const successor = allMemories.find(
      (m) => m.isLatest && m.id !== scopedMemory.id,
    );
    expect(successor).toBeDefined();
    expect(successor?.isLatest).toBe(true);
    expect(successor?.project).toBeUndefined();
    expect(successor?.attribution?.project).toBe("any");
  });

  it("stamps the correct project on newly created memories", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider("brand new memory");

    const session = makeSession("sess_api", "api");
    await kv.set(KV.sessions, session.id, session);
    for (let i = 0; i < 3; i++) {
      await kv.set(
        KV.observations(session.id),
        `obs_${i}`,
        makeObs(`obs_${i}`, session.id, "auth"),
      );
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    await sdk.trigger("mem::consolidate", {
      project: "api",
      minObservations: 1,
    });

    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(1);
    expect(memories[0].project).toBe("api");
  });

  it("leaves project undefined on memories when consolidate is called without a project", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider("unscoped memory");

    const session = makeSession("sess_any", "any");
    await kv.set(KV.sessions, session.id, session);
    for (let i = 0; i < 3; i++) {
      await kv.set(
        KV.observations(session.id),
        `obs_${i}`,
        makeObs(`obs_${i}`, session.id, "auth"),
      );
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    await sdk.trigger("mem::consolidate", { minObservations: 1 });

    const memories = await kv.list<Memory>(KV.memories);
    expect(memories).toHaveLength(1);
    expect(memories[0].project).toBeUndefined();
  });

  it("partitions an unscoped concept by canonical repository and preserves immutable source attribution", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider("shared architecture title");
    const oldCommit = "a".repeat(40);

    const wrightpt = makeSession("sess_wrightpt", "agentmemory", {
      canonicalRepoId: "wrightpt/agentmemory",
      branch: "mutable-current-branch",
      commitSha: "b".repeat(40),
      missionId: "mutable-session-mission",
      agentId: "codex",
    });
    const other = makeSession("sess_other", "agentmemory", {
      canonicalRepoId: "other/agentmemory",
      branch: "other-current-branch",
      commitSha: "c".repeat(40),
      agentId: "kimi",
    });
    await kv.set(KV.sessions, wrightpt.id, wrightpt);
    await kv.set(KV.sessions, other.id, other);

    for (let i = 0; i < 3; i++) {
      await kv.set(
        KV.observations(wrightpt.id),
        `obs_w_${i}`,
        makeObs(`obs_w_${i}`, wrightpt.id, "auth", {
          agentId: "codex",
          attribution: {
            project: "agentmemory",
            canonicalRepoId: "wrightpt/agentmemory",
            branch: "write-time-branch",
            commitSha: oldCommit,
          },
        }),
      );
      await kv.set(
        KV.observations(other.id),
        `obs_o_${i}`,
        makeObs(`obs_o_${i}`, other.id, "auth", {
          agentId: "kimi",
          attribution: {
            project: "agentmemory",
            canonicalRepoId: "other/agentmemory",
            branch: "other-write-time-branch",
            commitSha: "d".repeat(40),
          },
        }),
      );
    }

    const existing = makeExistingMemory(
      "mem_wrightpt_old",
      "shared architecture title",
      "agentmemory",
    );
    existing.attribution = {
      project: "agentmemory",
      canonicalRepoId: "wrightpt/agentmemory",
    };
    await kv.set(KV.memories, existing.id, existing);

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    await sdk.trigger("mem::consolidate", { minObservations: 1 });

    expect(provider.compress).toHaveBeenCalledTimes(2);
    expect((await kv.get<Memory>(KV.memories, existing.id))?.isLatest).toBe(
      false,
    );
    const latest = (await kv.list<Memory>(KV.memories)).filter(
      (memory) => memory.isLatest,
    );
    expect(latest).toHaveLength(2);
    const byRepo = new Map(
      latest.map((memory) => [memory.attribution?.canonicalRepoId, memory]),
    );
    expect(byRepo.get("wrightpt/agentmemory")).toMatchObject({
      agentId: "codex",
      attribution: {
        branch: "write-time-branch",
        commitSha: oldCommit,
      },
    });
    expect(
      byRepo.get("wrightpt/agentmemory")?.attribution?.missionId,
    ).toBeUndefined();
    expect(byRepo.get("other/agentmemory")).toMatchObject({
      agentId: "kimi",
      attribution: { branch: "other-write-time-branch" },
    });
    expect(searchMocks.remove).toHaveBeenCalledWith(existing.id);
    expect(searchMocks.add).toHaveBeenCalledTimes(2);
    expect(searchMocks.vectorIndexAddGuarded).toHaveBeenCalledTimes(2);
  });

  it("does not evolve an unattributed legacy row from a canonical source", async () => {
    const sdk = makeMockSdk();
    const kv = makeMockKV();
    const provider = makeProvider("synthesized memory title");
    const legacy = makeExistingMemory(
      "mem_legacy",
      "synthesized memory title",
      "agentmemory",
    );
    await kv.set(KV.memories, legacy.id, legacy);
    const session = makeSession("sess_canonical", "agentmemory", {
      canonicalRepoId: "wrightpt/agentmemory",
      agentId: "codex",
    });
    await kv.set(KV.sessions, session.id, session);
    for (let i = 0; i < 3; i++) {
      await kv.set(
        KV.observations(session.id),
        `obs_${i}`,
        makeObs(`obs_${i}`, session.id, "auth", {
          agentId: "codex",
          attribution: {
            project: "agentmemory",
            canonicalRepoId: "wrightpt/agentmemory",
          },
        }),
      );
    }

    registerConsolidateFunction(sdk as never, kv as never, provider as never);
    await sdk.trigger("mem::consolidate", {
      project: "agentmemory",
      minObservations: 1,
    });

    expect((await kv.get<Memory>(KV.memories, legacy.id))?.isLatest).toBe(true);
    const latest = (await kv.list<Memory>(KV.memories)).filter(
      (memory) => memory.isLatest && memory.id !== legacy.id,
    );
    expect(latest).toHaveLength(1);
    expect(latest[0].attribution?.canonicalRepoId).toBe("wrightpt/agentmemory");
    expect(searchMocks.remove).not.toHaveBeenCalledWith(legacy.id);
  });
});
