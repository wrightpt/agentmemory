import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompressedObservation, HybridSearchResult } from "../src/types.js";

const rerankMock = vi.hoisted(() => vi.fn());
const graphSearchMock = vi.hoisted(() => vi.fn());
const graphExpandMock = vi.hoisted(() => vi.fn());

vi.mock("../src/state/reranker.js", () => ({
  rerank: rerankMock,
}));

vi.mock("../src/functions/graph-retrieval.js", () => ({
  GraphRetrieval: class {
    searchByEntities(
      entityNames: string[],
      maxDepth: number,
      maxResults: number,
    ) {
      return graphSearchMock(entityNames, maxDepth, maxResults);
    }

    expandFromChunks(obsIds: string[], maxDepth: number, maxResults: number) {
      return graphExpandMock(obsIds, maxDepth, maxResults);
    }
  },
}));

import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import type { EmbeddingProvider } from "../src/types.js";
import type { VectorStore } from "../src/state/vector-store.js";

function observation(
  id: string,
  sessionId: string,
  agentId?: string,
): CompressedObservation {
  return {
    id,
    sessionId,
    ...(agentId ? { agentId } : {}),
    timestamp: "2026-08-21T12:00:00.000Z",
    type: "decision",
    title: `Launch authority decision ${id}`,
    subtitle: "Institutional memory",
    facts: ["The launch authority was selected deliberately"],
    narrative: `Launch authority rationale from ${agentId ?? "unattributed"}`,
    concepts: ["launch", "authority"],
    files: [],
    importance: 8,
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const get = vi.fn(async <T>(scope: string, key: string): Promise<T | null> =>
    (store.get(scope)?.get(key) as T) ?? null,
  );
  return {
    get,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

describe("HybridSearch agent authorization", () => {
  beforeEach(() => {
    rerankMock.mockReset();
    rerankMock.mockImplementation(
      async (_query: string, results: HybridSearchResult[]) => results,
    );
    graphSearchMock.mockReset();
    graphSearchMock.mockResolvedValue([]);
    graphExpandMock.mockReset();
    graphExpandMock.mockResolvedValue([]);
  });

  it("removes unauthorized candidates before invoking the reranker", async () => {
    const bm25 = new SearchIndex();
    const kv = mockKV();
    const candidates = [
      observation("obs_codex_a", "ses_codex_a", "codex"),
      observation("obs_kimi_secret", "ses_kimi", "kimi"),
      observation("obs_codex_b", "ses_codex_b", "codex"),
    ];

    for (const candidate of candidates) {
      bm25.add(candidate);
      await kv.set(
        `mem:obs:${candidate.sessionId}`,
        candidate.id,
        candidate,
      );
    }

    const hybrid = new HybridSearch(
      bm25,
      null,
      null,
      kv as never,
      0.4,
      0.6,
      0.3,
      true,
    );

    const results = await hybrid.search("launch authority", 10, {
      filterAgentId: "codex",
    });

    expect(rerankMock).toHaveBeenCalledOnce();
    const rerankerInput = rerankMock.mock.calls[0][1] as HybridSearchResult[];
    expect(rerankerInput.map((result) => result.observation.id).sort()).toEqual([
      "obs_codex_a",
      "obs_codex_b",
    ]);
    expect(
      rerankerInput.some(
        (result) => result.observation.id === "obs_kimi_secret",
      ),
    ).toBe(false);
    expect(results.map((result) => result.observation.id).sort()).toEqual([
      "obs_codex_a",
      "obs_codex_b",
    ]);
  });

  it("removes unauthorized IDs before BM25, vector, and graph ranks are assigned", async () => {
    const kv = mockKV();
    const denied = observation("obs_kimi", "ses_kimi", "kimi");
    const unattributed = observation("obs_unknown", "ses_unknown");
    const authorized = observation("obs_codex", "ses_codex", "codex");
    for (const candidate of [denied, unattributed, authorized]) {
      await kv.set(
        `mem:obs:${candidate.sessionId}`,
        candidate.id,
        candidate,
      );
    }

    const ranked = [
      { obsId: denied.id, sessionId: denied.sessionId, score: 0.99 },
      {
        obsId: unattributed.id,
        sessionId: unattributed.sessionId,
        score: 0.9,
      },
      {
        obsId: authorized.id,
        sessionId: authorized.sessionId,
        score: 0.8,
      },
    ];
    const bm25 = {
      search: vi.fn(() => ranked),
      getSessionId: vi.fn(
        (obsId: string) =>
          ranked.find((candidate) => candidate.obsId === obsId)?.sessionId,
      ),
    } as unknown as SearchIndex;
    const vector: VectorStore = {
      add: vi.fn(),
      remove: vi.fn(),
      search: vi.fn(() => ranked),
      size: ranked.length,
      clear: vi.fn(),
    };
    const embeddingProvider: EmbeddingProvider = {
      name: "authorization-test",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([1, 0, 0])),
      embedBatch: vi.fn(async (texts) =>
        texts.map(() => new Float32Array([1, 0, 0])),
      ),
    };
    graphSearchMock.mockResolvedValue(
      ranked.map((candidate) => ({
        ...candidate,
        graphContext: candidate.obsId,
        pathLength: 0,
      })),
    );

    const hybrid = new HybridSearch(
      bm25,
      vector,
      embeddingProvider,
      kv as never,
      0.4,
      0.6,
      0.3,
      false,
    );
    const results = await hybrid.searchWithExpansion(
      "launch authority",
      1,
      {
        reformulations: [],
        entityExtractions: ["LaunchAuthority"],
        temporalConcretizations: [],
      },
      { filterAgentId: "codex" },
    );

    expect(results).toHaveLength(1);
    expect(results[0].observation.id).toBe(authorized.id);
    expect(results[0].baseCombinedScore).toBeCloseTo(1 / 61, 10);
    expect(graphExpandMock).toHaveBeenCalledWith([authorized.id], 1, 5);
    const observationReads = kv.get.mock.calls.filter(([scope]) =>
      String(scope).startsWith("mem:obs:"),
    );
    expect(observationReads).toHaveLength(3);
  });

  it("excludes unauthorized graph expansions before fusion while retaining authorized expansions", async () => {
    const kv = mockKV();
    const vectorSeed = observation("obs_codex_seed", "ses_codex_seed", "codex");
    const expandedSecret = observation(
      "obs_kimi_expanded",
      "ses_kimi_expanded",
      "kimi",
    );
    const expandedAuthorized = observation(
      "obs_codex_expanded",
      "ses_codex_expanded",
      "codex",
    );
    for (const candidate of [
      vectorSeed,
      expandedSecret,
      expandedAuthorized,
    ]) {
      await kv.set(
        `mem:obs:${candidate.sessionId}`,
        candidate.id,
        candidate,
      );
    }

    const bm25 = {
      search: vi.fn(() => []),
      getSessionId: vi.fn((obsId: string) => {
        if (obsId === vectorSeed.id) return vectorSeed.sessionId;
        if (obsId === expandedSecret.id) return expandedSecret.sessionId;
        if (obsId === expandedAuthorized.id) return expandedAuthorized.sessionId;
        return undefined;
      }),
    } as unknown as SearchIndex;
    const vector: VectorStore = {
      add: vi.fn(),
      remove: vi.fn(),
      search: vi.fn(() => [
        { obsId: vectorSeed.id, sessionId: vectorSeed.sessionId, score: 0.99 },
      ]),
      size: 1,
      clear: vi.fn(),
    };
    const embeddingProvider: EmbeddingProvider = {
      name: "graph-expansion-authorization-test",
      dimensions: 3,
      embed: vi.fn(async () => new Float32Array([1, 0, 0])),
      embedBatch: vi.fn(async (texts) =>
        texts.map(() => new Float32Array([1, 0, 0])),
      ),
    };
    graphExpandMock.mockResolvedValue([
      {
        obsId: expandedSecret.id,
        sessionId: expandedSecret.sessionId,
        score: 0.95,
        graphContext: "secret expansion",
        pathLength: 1,
      },
      {
        obsId: expandedAuthorized.id,
        sessionId: expandedAuthorized.sessionId,
        score: 0.9,
        graphContext: "authorized expansion",
        pathLength: 1,
      },
    ]);

    const hybrid = new HybridSearch(
      bm25,
      vector,
      embeddingProvider,
      kv as never,
      0.4,
      0.6,
      0.3,
      true,
    );
    const results = await hybrid.search("launch authority", 10, {
      filterAgentId: "codex",
    });

    expect(graphExpandMock).toHaveBeenCalledWith([vectorSeed.id], 1, 5);
    expect(rerankMock).toHaveBeenCalledOnce();
    const rerankerInput = rerankMock.mock.calls[0][1] as HybridSearchResult[];
    expect(rerankerInput.map((result) => result.observation.id)).toEqual([
      vectorSeed.id,
      expandedAuthorized.id,
    ]);
    expect(results.map((result) => result.observation.id)).toEqual([
      vectorSeed.id,
      expandedAuthorized.id,
    ]);
    expect(
      results.find(
        (result) => result.observation.id === expandedAuthorized.id,
      )?.baseCombinedScore,
    ).toBeCloseTo((0.3 / 1.3) * (1 / 61), 10);
    expect(
      results.some((result) => result.observation.id === expandedSecret.id),
    ).toBe(false);
  });

  it("keeps the unfiltered search depth and hydration path unchanged", async () => {
    const kv = mockKV();
    const candidate = observation("obs_shared", "ses_shared", "codex");
    await kv.set(`mem:obs:${candidate.sessionId}`, candidate.id, candidate);
    const bm25 = {
      search: vi.fn(() => [
        { obsId: candidate.id, sessionId: candidate.sessionId, score: 1 },
      ]),
      getSessionId: vi.fn(() => candidate.sessionId),
    } as unknown as SearchIndex;
    const hybrid = new HybridSearch(bm25, null, null, kv as never);

    const results = await hybrid.search("launch authority", 1);

    expect(results.map((result) => result.observation.id)).toEqual([
      candidate.id,
    ]);
    expect(bm25.search).toHaveBeenCalledWith("launch authority", 2);
    const observationReads = kv.get.mock.calls.filter(([scope]) =>
      String(scope).startsWith("mem:obs:"),
    );
    expect(observationReads).toHaveLength(1);
  });
});
