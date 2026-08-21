import { SearchIndex } from "./search-index.js";
import type { VectorSearchResult, VectorStore } from "./vector-store.js";
import type {
  EmbeddingProvider,
  HybridSearchResult,
  CompressedObservation,
  Memory,
  QueryExpansion,
  RetrievalProvenance,
} from "../types.js";
import { memoryToObservation } from "./memory-utils.js";
import type { StateKV } from "./kv.js";
import { KV } from "./schema.js";
import {
  GraphRetrieval,
  type GraphRetrievalResult,
} from "../functions/graph-retrieval.js";
import { extractEntitiesFromQuery } from "../functions/query-expansion.js";
import { rerank } from "./reranker.js";
import {
  applyRetrievalPolicy,
  type RetrievalPolicyContext,
} from "./retrieval-policy.js";
import { resolveRetrievalProvenance } from "./provenance.js";
import { shouldSemanticallyIndexObservation } from "./indexing-policy.js";

const RRF_K = 60;
const AUTHORIZATION_BATCH_SIZE = 32;

type CandidateReference = {
  obsId: string;
  sessionId: string;
};

type ResolvedCandidateSource = {
  observation: CompressedObservation;
  provenance: RetrievalProvenance;
};

type CandidateSourceCache = Map<
  string,
  Promise<ResolvedCandidateSource | null>
>;

export class HybridSearch {
  private graphRetrieval: GraphRetrieval;

  constructor(
    private bm25: SearchIndex,
    private vector: VectorStore | null,
    private embeddingProvider: EmbeddingProvider | null,
    private kv: StateKV,
    private bm25Weight = 0.4,
    private vectorWeight = 0.6,
    private graphWeight = 0.3,
    private rerankEnabled = process.env.RERANK_ENABLED === "true",
  ) {
    this.graphRetrieval = new GraphRetrieval(kv);
  }

  async search(
    query: string,
    limit = 20,
    context: RetrievalPolicyContext = {},
  ): Promise<HybridSearchResult[]> {
    const sourceCache = context.filterAgentId === undefined
      ? undefined
      : new Map<string, Promise<ResolvedCandidateSource | null>>();
    return this.tripleStreamSearch(
      query,
      limit,
      undefined,
      context,
      sourceCache,
    );
  }

  async searchWithExpansion(
    query: string,
    limit: number,
    expansion: QueryExpansion,
    context: RetrievalPolicyContext = {},
  ): Promise<HybridSearchResult[]> {
    const allQueries = [
      query,
      ...expansion.reformulations,
      ...expansion.temporalConcretizations,
    ];

    const allEntities = [
      ...expansion.entityExtractions,
      ...extractEntitiesFromQuery(query),
    ];
    const sourceCache = context.filterAgentId === undefined
      ? undefined
      : new Map<string, Promise<ResolvedCandidateSource | null>>();

    const resultSets = await Promise.all(
      allQueries.map((q) =>
        this.tripleStreamSearch(q, limit, allEntities, context, sourceCache),
      ),
    );

    const merged = new Map<string, HybridSearchResult>();
    for (const results of resultSets) {
      for (const r of results) {
        const existing = merged.get(r.observation.id);
        if (!existing || r.combinedScore > existing.combinedScore) {
          merged.set(r.observation.id, r);
        }
      }
    }

    return Array.from(merged.values())
      .sort(
        (a, b) =>
          b.combinedScore - a.combinedScore ||
          a.observation.id.localeCompare(b.observation.id),
      )
      .slice(0, limit);
  }

  private async tripleStreamSearch(
    query: string,
    limit: number,
    entityHints?: string[],
    context: RetrievalPolicyContext = {},
    sourceCache?: CandidateSourceCache,
  ): Promise<HybridSearchResult[]> {
    const filterAgentId = context.filterAgentId;
    const requiresAuthorization = filterAgentId !== undefined;
    const authorizationCache = requiresAuthorization
      ? sourceCache ?? new Map<string, Promise<ResolvedCandidateSource | null>>()
      : undefined;
    const shouldOverFetch = Boolean(
      context.currentMissionId ||
        context.currentRepoId ||
        context.currentProject ||
        requiresAuthorization,
    );
    const candidateLimit = shouldOverFetch
      ? Math.min(Math.max(limit * 5, 100), 500)
      : limit;
    let bm25Results = this.bm25.search(query, candidateLimit * 2);

    let vectorResults: VectorSearchResult[] = [];
    if (this.vector && this.embeddingProvider && this.vector.size > 0) {
      try {
        const queryEmbedding = await this.embeddingProvider.embed(query);
        vectorResults = await this.vector.search(queryEmbedding, {
          limit: candidateLimit * 2,
        });
      } catch {
        // fall through to BM25-only
      }
    }

    const entities =
      entityHints && entityHints.length > 0
        ? entityHints
        : extractEntitiesFromQuery(query);
    let graphResults: GraphRetrievalResult[] = [];
    if (entities.length > 0) {
      try {
        graphResults = await this.graphRetrieval.searchByEntities(
          entities,
          2,
          candidateLimit,
        );
      } catch {
        // graph search is best-effort
      }
    }

    if (filterAgentId !== undefined && authorizationCache) {
      const authorizedIds = await this.authorizedCandidateIds(
        [...bm25Results, ...vectorResults, ...graphResults],
        filterAgentId,
        authorizationCache,
      );
      bm25Results = bm25Results.filter((result) =>
        authorizedIds.has(result.obsId),
      );
      vectorResults = vectorResults.filter((result) =>
        authorizedIds.has(result.obsId),
      );
      graphResults = graphResults.filter((result) =>
        authorizedIds.has(result.obsId),
      );
    }

    const topVectorObs = vectorResults.slice(0, 5).map((r) => r.obsId);
    if (topVectorObs.length > 0) {
      try {
        let expansionResults =
          await this.graphRetrieval.expandFromChunks(topVectorObs, 1, 5);
        if (filterAgentId !== undefined && authorizationCache) {
          const authorizedIds = await this.authorizedCandidateIds(
            expansionResults,
            filterAgentId,
            authorizationCache,
          );
          expansionResults = expansionResults.filter((result) =>
            authorizedIds.has(result.obsId),
          );
        }
        graphResults = [...graphResults, ...expansionResults];
      } catch {
        // expansion is best-effort
      }
    }

    const scores = new Map<
      string,
      {
        bm25Rank: number;
        vectorRank: number;
        graphRank: number;
        sessionId: string;
        bm25Score: number;
        vectorScore: number;
        graphScore: number;
        graphContext?: string;
      }
    >();

    bm25Results.forEach((r, i) => {
      scores.set(r.obsId, {
        bm25Rank: i + 1,
        vectorRank: Infinity,
        graphRank: Infinity,
        sessionId: r.sessionId,
        bm25Score: r.score,
        vectorScore: 0,
        graphScore: 0,
      });
    });

    vectorResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.vectorRank = i + 1;
        existing.vectorScore = r.score;
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: i + 1,
          graphRank: Infinity,
          sessionId:
            r.sessionId || this.bm25.getSessionId(r.obsId) || "memory",
          bm25Score: 0,
          vectorScore: r.score,
          graphScore: 0,
        });
      }
    });

    graphResults.forEach((r, i) => {
      const existing = scores.get(r.obsId);
      if (existing) {
        existing.graphRank = Math.min(existing.graphRank, i + 1);
        existing.graphScore = Math.max(existing.graphScore, r.score);
        if (r.graphContext && !existing.graphContext) {
          existing.graphContext = r.graphContext;
        }
      } else {
        scores.set(r.obsId, {
          bm25Rank: Infinity,
          vectorRank: Infinity,
          graphRank: i + 1,
          sessionId:
            r.sessionId || this.bm25.getSessionId(r.obsId) || "memory",
          bm25Score: 0,
          vectorScore: 0,
          graphScore: r.score,
          graphContext: r.graphContext,
        });
      }
    });

    const hasVector = vectorResults.length > 0;
    const hasGraph = graphResults.length > 0;

    let effectiveBm25W = this.bm25Weight;
    let effectiveVectorW = hasVector ? this.vectorWeight : 0;
    let effectiveGraphW = hasGraph ? this.graphWeight : 0;

    const totalW = effectiveBm25W + effectiveVectorW + effectiveGraphW;
    if (totalW > 0) {
      effectiveBm25W /= totalW;
      effectiveVectorW /= totalW;
      effectiveGraphW /= totalW;
    }

    const combined = Array.from(scores.entries()).map(([obsId, s]) => ({
      obsId,
      sessionId: s.sessionId,
      bm25Score: s.bm25Score,
      vectorScore: s.vectorScore,
      graphScore: s.graphScore,
      graphContext: s.graphContext,
      combinedScore:
        effectiveBm25W * (1 / (RRF_K + s.bm25Rank)) +
        effectiveVectorW * (1 / (RRF_K + s.vectorRank)) +
        effectiveGraphW * (1 / (RRF_K + s.graphRank)),
    }));

    combined.sort(
      (a, b) => b.combinedScore - a.combinedScore || a.obsId.localeCompare(b.obsId),
    );

    const retrievalDepth = Math.max(candidateLimit, 20);
    const rerankWindow = 20;
    const diversified = this.diversifyBySession(combined, retrievalDepth);
    const enriched = await this.enrichResults(
      diversified,
      retrievalDepth,
      authorizationCache,
    );
    const authorized = this.filterAgentAuthorized(enriched, context);
    const qualityFiltered = this.filterLegacySemanticOnlyNoise(authorized);

    if (this.rerankEnabled && qualityFiltered.length > 1) {
      try {
        const head = qualityFiltered.slice(0, rerankWindow);
        const tail = qualityFiltered.slice(rerankWindow);
        const reranked = await rerank(query, head, rerankWindow);
        return this.applyPolicy(reranked.concat(tail), context, limit);
      } catch {
        return this.applyPolicy(qualityFiltered, context, limit);
      }
    }

    return this.applyPolicy(qualityFiltered, context, limit);
  }

  private async authorizedCandidateIds(
    candidates: CandidateReference[],
    agentId: string,
    sourceCache: CandidateSourceCache,
  ): Promise<Set<string>> {
    const uniqueCandidates = new Map<string, string>();
    for (const candidate of candidates) {
      if (uniqueCandidates.has(candidate.obsId)) continue;
      uniqueCandidates.set(
        candidate.obsId,
        candidate.sessionId ||
          this.bm25.getSessionId(candidate.obsId) ||
          "memory",
      );
    }

    const authorizedIds = new Set<string>();
    const entries = [...uniqueCandidates.entries()];
    for (let index = 0; index < entries.length; index += AUTHORIZATION_BATCH_SIZE) {
      const batch = entries.slice(index, index + AUTHORIZATION_BATCH_SIZE);
      const resolved = await Promise.all(
        batch.map(async ([obsId, sessionId]) => ({
          obsId,
          source: await this.cachedCandidateSource(
            obsId,
            sessionId,
            sourceCache,
          ),
        })),
      );
      for (const candidate of resolved) {
        if (candidate.source?.provenance.agentId === agentId) {
          authorizedIds.add(candidate.obsId);
        }
      }
    }
    return authorizedIds;
  }

  private cachedCandidateSource(
    obsId: string,
    sessionId: string,
    sourceCache: CandidateSourceCache,
  ): Promise<ResolvedCandidateSource | null> {
    const existing = sourceCache.get(obsId);
    if (existing) return existing;
    const pending = this.resolveCandidateSource(obsId, sessionId).catch(
      () => null,
    );
    sourceCache.set(obsId, pending);
    return pending;
  }

  private async resolveCandidateSource(
    obsId: string,
    sessionId: string,
  ): Promise<ResolvedCandidateSource | null> {
    const observation = await this.kv
      .get<CompressedObservation>(KV.observations(sessionId), obsId)
      .catch(() => null);
    const memory = observation
      ? null
      : await this.kv.get<Memory>(KV.memories, obsId).catch(() => null);
    const resolvedObservation = observation ??
      (memory ? memoryToObservation(memory) : null);
    if (!resolvedObservation) return null;
    const provenance = await resolveRetrievalProvenance(
      this.kv,
      resolvedObservation,
      memory,
    );
    return { observation: resolvedObservation, provenance };
  }

  private filterAgentAuthorized(
    results: HybridSearchResult[],
    context: RetrievalPolicyContext,
  ): HybridSearchResult[] {
    if (context.filterAgentId === undefined) return results;
    return results.filter(
      (result) => result.provenance?.agentId === context.filterAgentId,
    );
  }

  /**
   * Old persisted vector indexes can contain routine observations written
   * before the memory-quality policy existed. Keep those rows stored and keep
   * exact lexical/graph retrieval intact, but do not let a vector-only legacy
   * hit consume the reranker window. Newly indexed rows already obey this
   * policy; applying it at read time makes restored legacy indexes consistent.
   */
  private filterLegacySemanticOnlyNoise(
    results: HybridSearchResult[],
  ): HybridSearchResult[] {
    return results.filter((result) => {
      const semanticOnly =
        result.vectorScore > 0 &&
        result.bm25Score <= 0 &&
        result.graphScore <= 0;
      return (
        !semanticOnly ||
        shouldSemanticallyIndexObservation(result.observation)
      );
    });
  }

  private applyPolicy(
    results: HybridSearchResult[],
    context: RetrievalPolicyContext,
    limit: number,
  ): HybridSearchResult[] {
    return applyRetrievalPolicy(
      results.map((result) => ({
        id: result.observation.id,
        baseScore: result.combinedScore,
        value: result,
        provenance: result.provenance!,
      })),
      context,
    )
      .map((candidate) => ({
        ...candidate.value,
        baseCombinedScore: candidate.baseScore,
        combinedScore: candidate.adjustedScore,
        scope: candidate.scope,
        scopeReason: candidate.scopeReason,
      }))
      .slice(0, limit);
  }

  private diversifyBySession(
    results: Array<{
      obsId: string;
      sessionId: string;
      bm25Score: number;
      vectorScore: number;
      graphScore: number;
      combinedScore: number;
      graphContext?: string;
    }>,
    limit: number,
    maxPerSession = 3,
  ): typeof results {
    const selected: typeof results = [];
    const sessionCounts = new Map<string, number>();

    for (const r of results) {
      const count = sessionCounts.get(r.sessionId) || 0;
      if (count >= maxPerSession) continue;
      selected.push(r);
      sessionCounts.set(r.sessionId, count + 1);
      if (selected.length >= limit) break;
    }

    if (selected.length < limit) {
      for (const r of results) {
        if (selected.length >= limit) break;
        if (!selected.some(s => s.obsId === r.obsId)) {
          selected.push(r);
        }
      }
    }

    return selected;
  }

  private async enrichResults(
    results: Array<{
      obsId: string;
      sessionId: string;
      bm25Score: number;
      vectorScore: number;
      graphScore: number;
      combinedScore: number;
      graphContext?: string;
    }>,
    limit: number,
    sourceCache?: CandidateSourceCache,
  ): Promise<HybridSearchResult[]> {
    const sliced = results.slice(0, limit);
    if (sourceCache) {
      const sources = await Promise.all(
        sliced.map((result) =>
          this.cachedCandidateSource(
            result.obsId,
            result.sessionId,
            sourceCache,
          ),
        ),
      );
      return sliced.flatMap((result, index) => {
        const source = sources[index];
        if (!source) return [];
        return [
          {
            observation: source.observation,
            bm25Score: result.bm25Score,
            vectorScore: result.vectorScore,
            graphScore: result.graphScore,
            combinedScore: result.combinedScore,
            sessionId: result.sessionId,
            graphContext: result.graphContext,
            provenance: source.provenance,
          },
        ];
      });
    }
    const observations = await Promise.all(
      sliced.map(async (r) => {
        const obs = await this.kv
          .get<CompressedObservation>(KV.observations(r.sessionId), r.obsId)
          .catch(() => null);
        if (obs) return { observation: obs, memory: null as Memory | null };
        // Fallback: indexed entry may originate from mem::remember, which
        // writes to KV.memories with a synthetic sessionId ("memory" or the
        // memory's first associated session). Coerce the Memory record into
        // a CompressedObservation so search/recall surface saved memories.
        const mem = await this.kv
          .get<Memory>(KV.memories, r.obsId)
          .catch(() => null);
        return mem
          ? { observation: memoryToObservation(mem), memory: mem }
          : null;
      }),
    );
    const enriched: HybridSearchResult[] = [];
    for (let i = 0; i < sliced.length; i++) {
      const source = observations[i];
      if (source) {
        const provenance = await resolveRetrievalProvenance(
          this.kv,
          source.observation,
          source.memory,
        );
        enriched.push({
          observation: source.observation,
          bm25Score: sliced[i].bm25Score,
          vectorScore: sliced[i].vectorScore,
          graphScore: sliced[i].graphScore,
          combinedScore: sliced[i].combinedScore,
          sessionId: sliced[i].sessionId,
          graphContext: sliced[i].graphContext,
          provenance,
        });
      }
    }
    return enriched;
  }
}
