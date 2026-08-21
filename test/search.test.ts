import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSearchFunction, getSearchIndex, rebuildIndex, setVectorIndex, setEmbeddingProvider, getVectorIndex } from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Memory, Session } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
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

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("mem::search", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);

    const session: Session = {
      id: "ses_1",
      project: "demo",
      cwd: "/tmp/demo",
      repoRoot: "/tmp/demo",
      worktree: "/tmp/demo-worktree",
      branch: "agent/auth-refresh",
      canonicalRepoId: "wrightpt/demo",
      repoRemote: "https://github.com/wrightpt/demo",
      terminalSession: "shared-web-term-42",
      parentSession: "shared-web-term-1",
      missionId: "mission-auth",
      missionTitle: "Harden authentication",
      missionRole: "worker",
      commitSha: "0123456789abcdef",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
      agentId: "codex",
    };
    await kv.set(KV.sessions, session.id, session);

    const obsA: CompressedObservation = {
      id: "obs_a",
      sessionId: "ses_1",
      timestamp: "2026-01-01T00:00:00Z",
      type: "decision",
      title: "Auth middleware decision",
      subtitle: "JWT strategy",
      facts: ["Use rotating refresh tokens"],
      narrative: "Implemented auth middleware with JWT refresh rotation.",
      concepts: ["auth", "jwt"],
      files: ["src/auth.ts"],
      importance: 8,
      confidence: 0.9,
      agentId: "codex",
    };
    const obsB: CompressedObservation = {
      id: "obs_b",
      sessionId: "ses_1",
      timestamp: "2026-01-02T00:00:00Z",
      type: "file_edit",
      title: "UI button styling",
      facts: ["Updated primary button color"],
      narrative: "Adjusted button styles in the settings page.",
      concepts: ["ui", "css"],
      files: ["src/ui/button.tsx"],
      importance: 4,
    };

    await kv.set(KV.observations("ses_1"), obsA.id, obsA);
    await kv.set(KV.observations("ses_1"), obsB.id, obsB);

    // Module-level SearchIndex singleton would leak across tests; reset.
    getSearchIndex().clear();
  });

  it("returns full format by default", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth middleware",
    })) as {
      format: string;
      results: Array<{
        observation: CompressedObservation;
        provenance: Record<string, unknown>;
      }>;
    };

    expect(result.format).toBe("full");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.observation.id).toBe("obs_a");
    expect(result.results[0]?.provenance).toMatchObject({
      project: "demo",
      canonicalRepoId: "wrightpt/demo",
      repoRoot: "/tmp/demo",
      worktree: "/tmp/demo-worktree",
      branch: "agent/auth-refresh",
      commitSha: "0123456789abcdef",
      sessionId: "ses_1",
      terminalSession: "shared-web-term-42",
      parentSession: "shared-web-term-1",
      missionId: "mission-auth",
      missionTitle: "Harden authentication",
      missionRole: "worker",
      agentId: "codex",
      files: ["src/auth.ts"],
      observationId: "obs_a",
      memoryType: "decision",
      confidence: 0.9,
      importance: 8,
      attributed: true,
    });
  });

  it("returns compact format when requested", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth",
      format: "compact",
    })) as {
      format: string;
      results: Array<{
        obsId: string;
        title: string;
        provenanceAvailable: boolean;
        provenance: Record<string, unknown>;
      }>;
    };

    expect(result.format).toBe("compact");
    expect(result.results[0]?.obsId).toBe("obs_a");
    expect(result.results[0]?.title).toBe("Auth middleware decision");
    expect(result.results[0]?.provenanceAvailable).toBe(true);
    expect(result.results[0]?.provenance).toEqual({
      project: "demo",
      canonicalRepoId: "wrightpt/demo",
      sessionId: "ses_1",
      agentId: "codex",
      missionId: "mission-auth",
      branch: "agent/auth-refresh",
      commitSha: "0123456789abcdef",
      timestamp: "2026-01-01T00:00:00Z",
      memoryType: "decision",
      importance: 8,
      confidence: 0.9,
      attributed: true,
    });
  });

  it("keeps compact provenance inspectable in narrative result rows", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth middleware",
      format: "narrative",
    })) as {
      results: Array<{
        obsId: string;
        provenanceAvailable: boolean;
        provenance: Record<string, unknown>;
      }>;
      text: string;
    };

    expect(result.text).toContain("Auth middleware decision");
    expect(result.results[0]).toMatchObject({
      obsId: "obs_a",
      provenanceAvailable: true,
      provenance: {
        canonicalRepoId: "wrightpt/demo",
        sessionId: "ses_1",
        agentId: "codex",
        missionId: "mission-auth",
        attributed: true,
      },
    });
  });

  it("returns narrative text and respects token budget", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth ui",
      format: "narrative",
      token_budget: 20,
    })) as {
      format: string;
      results: Array<{ obsId: string }>;
      text: string;
      tokens_used: number;
      tokens_budget: number;
      truncated: boolean;
    };

    expect(result.format).toBe("narrative");
    expect(result.tokens_budget).toBe(20);
    expect(result.tokens_used).toBeLessThanOrEqual(20);
    expect(typeof result.text).toBe("string");
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects invalid format values", async () => {
    await expect(
      sdk.trigger("mem::search", { query: "auth", format: "verbose" }),
    ).rejects.toThrow("format must be one of");
  });

  it("surfaces saved memories from KV.memories (#265)", async () => {
    // mem::remember persists to KV.memories under a synthetic sessionId
    // ("memory") that has no corresponding KV.observations entry. mem::search
    // must fall back to KV.memories or memory_recall returns empty.
    await kv.set(KV.memories, "mem_x1", {
      id: "mem_x1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "fact",
      title: "Pineapple belongs on pizza",
      content: "Pineapple belongs on pizza for testing fallback path.",
      concepts: ["pineapple", "pizza"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
      project: "demo",
      agentId: "kimi",
    });
    // Force the rebuild to pick up the new memory (mem::search only
    // rebuilds on first call when idx.size === 0).
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "pineapple pizza",
      format: "compact",
    })) as {
      results: Array<{
        obsId: string;
        title: string;
        provenance: Record<string, unknown>;
      }>;
    };

    const hit = result.results.find((r) => r.obsId === "mem_x1");
    expect(hit).toBeDefined();
    expect(hit?.title).toBe("Pineapple belongs on pizza");
    expect(hit?.provenance).toMatchObject({
      project: "demo",
      agentId: "kimi",
      memoryType: "fact",
      importance: 7,
      attributed: true,
    });
  });

  it("keeps a composite memory's internal hydration locator out of full and compact results", async () => {
    const secondSession: Session = {
      id: "ses_2",
      project: "demo",
      cwd: "/tmp/demo-two",
      startedAt: "2026-01-03T00:00:00Z",
      status: "completed",
      observationCount: 0,
      agentId: "kimi",
    };
    await kv.set(KV.sessions, secondSession.id, secondSession);
    const memory: Memory = {
      id: "mem_composite_search",
      createdAt: "2026-02-02T00:00:00Z",
      updatedAt: "2026-02-02T00:00:00Z",
      type: "architecture",
      title: "Composite hydration sentinel",
      content: "A multi-session architecture conclusion.",
      concepts: ["composite-hydration-sentinel"],
      files: [],
      sessionIds: [secondSession.id, "ses_1"],
      strength: 9,
      version: 1,
      isLatest: true,
      attribution: {
        project: "demo",
        canonicalRepoId: "wrightpt/demo",
      },
    };
    await kv.set(KV.memories, memory.id, memory);
    await rebuildIndex(kv as never);

    const full = (await sdk.trigger("mem::search", {
      query: "composite hydration sentinel",
      format: "full",
    })) as {
      results: Array<{
        observation: CompressedObservation;
        sessionId?: string;
        provenance: Record<string, unknown>;
      }>;
    };
    const fullHit = full.results.find(
      (candidate) => candidate.observation.id === memory.id,
    );
    expect(fullHit).toBeDefined();
    expect(fullHit).not.toHaveProperty("sessionId");
    expect(fullHit?.observation.sessionId).toBe("memory");
    expect(fullHit?.provenance).toMatchObject({
      sessionIds: ["ses_1", secondSession.id],
      memoryId: memory.id,
    });
    expect(fullHit?.provenance).not.toHaveProperty("sessionId");

    const compact = (await sdk.trigger("mem::search", {
      query: "composite hydration sentinel",
      format: "compact",
    })) as {
      results: Array<{
        obsId: string;
        sessionId?: string;
        provenance: Record<string, unknown>;
      }>;
    };
    const compactHit = compact.results.find(
      (candidate) => candidate.obsId === memory.id,
    );
    expect(compactHit).toBeDefined();
    expect(compactHit).not.toHaveProperty("sessionId");
    expect(compactHit?.provenance).toMatchObject({
      sessionIds: ["ses_1", secondSession.id],
    });
    expect(compactHit?.provenance).not.toHaveProperty("sessionId");
  });

  it("rebuildIndex populates the vector index", async () => {
    const mockEmbedder = {
      name: "test",
      dimensions: 3,
      embed: async (_text: string) => new Float32Array([0.1, 0.2, 0.3]),
      embedBatch: async (_texts: string[]) =>
        _texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    };
    setEmbeddingProvider(mockEmbedder);
    setVectorIndex(new VectorIndex());

    await rebuildIndex(kv as never);

    const vi = getVectorIndex();
    expect(vi).not.toBeNull();
    expect(vi!.size).toBeGreaterThan(0);

    // Cleanup
    setVectorIndex(null);
    setEmbeddingProvider(null);
  });
});
