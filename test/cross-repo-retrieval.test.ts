import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompressedObservation, Memory, Session } from "../src/types.js";
import { SearchIndex } from "../src/state/search-index.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { upsertProjectRelationship } from "../src/functions/project-relationships.js";
import { memoryToObservation } from "../src/state/memory-utils.js";

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

function memoryKV() {
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

function sdkHarness() {
  const functions = new Map<string, (data: any) => unknown>();
  return {
    registerFunction: (id: string, fn: (data: any) => unknown) => {
      functions.set(id, fn);
    },
    trigger: async (
      request: string | { function_id: string; payload?: unknown },
      directPayload?: unknown,
    ) => {
      const id = typeof request === "string" ? request : request.function_id;
      const payload =
        typeof request === "string" ? directPayload : request.payload;
      const fn = functions.get(id);
      if (!fn) {
        if (id === "mem::lesson-recall") return { success: true, lessons: [] };
        throw new Error(`missing function ${id}`);
      }
      return fn(payload ?? {});
    },
  };
}

function session(
  id: string,
  project: string,
  canonicalRepoId: string,
  agentId: string,
): Session {
  return {
    id,
    project,
    cwd: `/worktrees/${id}`,
    repoRoot: `/repos/${project}`,
    worktree: `/worktrees/${id}`,
    branch: `agent/${id}`,
    canonicalRepoId,
    missionId: id === "ses_current" ? "mission_dsh" : undefined,
    commitSha: id.slice(-1).repeat(40).replace(/[^a-f0-9]/g, "a"),
    startedAt: "2026-08-20T00:00:00.000Z",
    status: "active",
    observationCount: 1,
    agentId,
  };
}

function observation(
  id: string,
  sessionId: string,
  agentId: string,
  importance: number,
): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-08-20T00:00:00.000Z",
    type: "decision",
    title: "launch authority DSH broker decision",
    facts: ["workstation-shell owns interactive launches"],
    narrative:
      "The architecture uses workstation-shell as launch authority for DeepSeek Harness.",
    concepts: ["DSH", "launch-authority"],
    files: ["src/launch.ts"],
    importance,
    confidence: 0.9,
    agentId,
  };
}

describe("cross-repository institutional retrieval", () => {
  const originalScope = process.env.AGENTMEMORY_AGENT_SCOPE;

  beforeEach(() => {
    process.env.AGENTMEMORY_AGENT_SCOPE = "shared";
  });

  afterEach(() => {
    if (originalScope === undefined) delete process.env.AGENTMEMORY_AGENT_SCOPE;
    else process.env.AGENTMEMORY_AGENT_SCOPE = originalScope;
  });

  it("prefers current repo, admits explicit relations, suppresses distractors, and expands provenance", async () => {
    const kv = memoryKV();
    const bm25 = new SearchIndex();
    const sessions = [
      session(
        "ses_current",
        "trading-system",
        "wrightpt/trading-system",
        "codex",
      ),
      session(
        "ses_related",
        "workstation-shell",
        "wrightpt/workstation-shell",
        "kimi",
      ),
      session(
        "ses_unrelated",
        "other-shell",
        "unrelated/workstation-shell",
        "pi",
      ),
    ];
    const observations = [
      observation("obs_current", "ses_current", "codex", 7),
      observation("obs_related", "ses_related", "kimi", 9),
      observation("obs_unrelated", "ses_unrelated", "pi", 10),
    ];
    for (const item of sessions) await kv.set("mem:sessions", item.id, item);
    for (const item of observations) {
      bm25.add(item);
      await kv.set(`mem:obs:${item.sessionId}`, item.id, item);
    }
    await upsertProjectRelationship(kv as never, {
      sourceRepoId: "wrightpt/trading-system",
      targetRepoId: "wrightpt/workstation-shell",
      relationType: "orchestrates_through",
      provenance: {
        kind: "registry",
        source: "projects.yaml",
        recordedAt: "2026-08-20T00:00:00.000Z",
      },
    });

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const sdk = sdkHarness();
    registerSmartSearchFunction(
      sdk as never,
      kv as never,
      (query, limit, context) => hybrid.search(query, limit, context),
    );
    const compact = (await sdk.trigger("mem::smart-search", {
      query: "Why is workstation-shell the DSH launch authority?",
      currentRepo: "wrightpt/trading-system",
      missionId: "mission_dsh",
      includeRelatedProjects: true,
      includeLessons: false,
      limit: 10,
    })) as any;

    expect(compact.results.map((result: any) => result.obsId)).toEqual([
      "obs_current",
      "obs_related",
    ]);
    expect(compact.results[0]).toMatchObject({
      scope: "current_mission",
      provenanceAvailable: true,
      provenance: {
        canonicalRepoId: "wrightpt/trading-system",
        agentId: "codex",
        missionId: "mission_dsh",
      },
    });
    expect(compact.results[1]).toMatchObject({
      scope: "related_repo",
      provenance: {
        canonicalRepoId: "wrightpt/workstation-shell",
        agentId: "kimi",
      },
    });

    const expanded = (await sdk.trigger("mem::smart-search", {
      expandIds: [compact.results[1].obsId],
      currentRepo: "wrightpt/trading-system",
      includeRelatedProjects: true,
      includeLessons: false,
    })) as any;
    expect(expanded.results[0]).toMatchObject({
      obsId: "obs_related",
      scope: "related_repo",
      provenance: {
        repoRoot: "/repos/workstation-shell",
        worktree: "/worktrees/ses_related",
        branch: "agent/ses_related",
        canonicalRepoId: "wrightpt/workstation-shell",
        agentId: "kimi",
      },
    });
  });

  it("keeps exact-symbol BM25 retrieval authoritative without vectors", async () => {
    const kv = memoryKV();
    const bm25 = new SearchIndex();
    const exact = {
      ...observation("obs_symbol", "ses_current", "codex", 8),
      title: "resolveLaunchAuthorityV2 contract",
      narrative: "The exact interface symbol is resolveLaunchAuthorityV2.",
    };
    bm25.add(exact);
    await kv.set("mem:obs:ses_current", exact.id, exact);
    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("resolveLaunchAuthorityV2", 5);
    expect(results[0].observation.id).toBe("obs_symbol");
    expect(results[0].bm25Score).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBe(0);
  });

  it("retains but never returns a superseded durable memory", async () => {
    const kv = memoryKV();
    const bm25 = new SearchIndex();
    const base: Memory = {
      id: "mem_old",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      type: "architecture",
      title: "DSH authority",
      content: "Use the obsolete direct launcher",
      concepts: ["DSH"],
      files: [],
      sessionIds: [],
      strength: 10,
      version: 1,
      isLatest: false,
      project: "global",
    };
    const current: Memory = {
      ...base,
      id: "mem_current",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      content: "Use workstation-shell as launch authority",
      version: 2,
      parentId: "mem_old",
      supersedes: ["mem_old"],
      isLatest: true,
    };
    for (const memory of [base, current]) {
      bm25.add(memoryToObservation(memory));
      await kv.set("mem:memories", memory.id, memory);
    }
    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("DSH authority launcher", 10);
    expect(results.map((result) => result.observation.id)).toEqual([
      "mem_current",
    ]);
    expect(await kv.get("mem:memories", "mem_old")).toMatchObject({
      isLatest: false,
    });
  });
});
