import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const configState = {
  agentId: "agent_a" as string | undefined,
  isolated: true,
};

vi.mock("../src/config.js", () => ({
  getAgentId: () => configState.agentId,
  isAgentScopeIsolated: () => configState.isolated,
  getFollowupWindowSeconds: () => 30,
}));

import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  HybridSearchResult,
  Session,
} from "../src/types.js";

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
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
  };
}

function mockSdk() {
  const functions = new Map<string, (payload: any) => unknown>();
  return {
    registerFunction: (
      idOrOptions: string | { id: string },
      handler: (payload: any) => unknown,
    ) => {
      const id =
        typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      functions.set(id, handler);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload?: unknown },
      payload?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const data = typeof idOrInput === "string" ? payload : idOrInput.payload;
      const handler = functions.get(id);
      if (!handler) throw new Error(`No function registered: ${id}`);
      return handler(data ?? {});
    },
  };
}

function observation(
  id: string,
  sessionId: string,
  agentId: string,
): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-08-21T12:00:00.000Z",
    type: "decision",
    title: "shared launch authority decision",
    facts: ["workstation-shell owns process launch"],
    narrative: "The workstation shell is the launch authority.",
    concepts: ["launch-authority"],
    files: ["src/launch.ts"],
    importance: 8,
    agentId,
  };
}

describe("smart-search agent isolation", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let results: HybridSearchResult[];

  beforeEach(async () => {
    configState.agentId = "agent_a";
    configState.isolated = true;
    sdk = mockSdk();
    kv = mockKV();

    const obsA = observation("obs_a", "ses_a", "agent_a");
    const obsB = observation("obs_b", "ses_b", "agent_b");
    const sessions: Session[] = [
      {
        id: "ses_a",
        project: "agentmemory",
        cwd: "/worktrees/a",
        canonicalRepoId: "wrightpt/agentmemory",
        startedAt: "2026-08-21T11:00:00.000Z",
        status: "active",
        observationCount: 1,
        agentId: "agent_a",
      },
      {
        id: "ses_b",
        project: "agentmemory",
        cwd: "/worktrees/b",
        canonicalRepoId: "wrightpt/agentmemory",
        startedAt: "2026-08-21T11:00:00.000Z",
        status: "active",
        observationCount: 1,
        agentId: "agent_b",
      },
    ];
    for (const session of sessions) {
      await kv.set(KV.sessions, session.id, session);
    }
    await kv.set(KV.observations("ses_a"), obsA.id, obsA);
    await kv.set(KV.observations("ses_b"), obsB.id, obsB);

    results = [obsA, obsB].map((item, index) => ({
      observation: item,
      bm25Score: 1 - index * 0.1,
      vectorScore: 0,
      graphScore: 0,
      combinedScore: 1 - index * 0.1,
      sessionId: item.sessionId,
    }));
    registerSmartSearchFunction(
      sdk as never,
      kv as never,
      async () => results,
    );
  });

  it("filters both compact results and expansion before returning another agent's row", async () => {
    const compact = (await sdk.trigger("mem::smart-search", {
      query: "launch authority",
      includeLessons: false,
    })) as { results: Array<{ obsId: string }> };
    expect(compact.results.map((result) => result.obsId)).toEqual(["obs_a"]);

    const expanded = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_a", "obs_b"],
      includeLessons: false,
    })) as { results: Array<{ obsId: string }> };
    expect(expanded.results.map((result) => result.obsId)).toEqual(["obs_a"]);
  });

  it("fails closed when isolated mode has no resolvable agent", async () => {
    configState.agentId = undefined;

    await expect(
      sdk.trigger("mem::smart-search", {
        query: "launch authority",
        includeLessons: false,
      }),
    ).rejects.toThrow(/AGENTMEMORY_AGENT_SCOPE=isolated/);
  });

  it("retains the explicit wildcard as an opt-in shared read", async () => {
    const compact = (await sdk.trigger("mem::smart-search", {
      query: "launch authority",
      includeLessons: false,
      agentId: "*",
    })) as { results: Array<{ obsId: string }> };

    expect(compact.results.map((result) => result.obsId)).toEqual([
      "obs_a",
      "obs_b",
    ]);
  });
});
