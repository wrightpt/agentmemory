import { describe, expect, it } from "vitest";
import {
  applyRetrievalPolicy,
  type RetrievalPolicyCandidate,
  type RetrievalProvenance,
} from "../src/state/retrieval-policy.js";

function provenance(
  id: string,
  overrides: Partial<RetrievalProvenance> = {},
): RetrievalProvenance {
  return {
    files: [],
    timestamp: "2026-01-01T00:00:00.000Z",
    observationId: id,
    importance: 5,
    confidence: 0.5,
    attributed: true,
    ...overrides,
  };
}

function candidate(
  id: string,
  baseScore: number,
  overrides: Partial<RetrievalProvenance> = {},
): RetrievalPolicyCandidate<string> {
  return { id, baseScore, value: id, provenance: provenance(id, overrides) };
}

describe("scope-aware retrieval policy", () => {
  it("prefers current-repo evidence over a slightly stronger distractor", () => {
    const ranked = applyRetrievalPolicy(
      [
        candidate("related", 0.0165, { canonicalRepoId: "acme/dependency" }),
        candidate("local", 0.0158, { canonicalRepoId: "acme/service" }),
      ],
      {
        currentRepoId: "acme/service",
        relatedRepoIds: ["acme/dependency"],
        includeRelatedProjects: true,
      },
    );
    expect(ranked.map((item) => item.id)).toEqual(["local", "related"]);
    expect(ranked[0].scope).toBe("current_repo");
  });

  it("admits explicitly related repositories and suppresses unrelated ones", () => {
    const candidates = [
      candidate("related", 0.016, { canonicalRepoId: "acme/dependency" }),
      candidate("unrelated", 0.019, { canonicalRepoId: "other/dependency" }),
    ];
    const ranked = applyRetrievalPolicy(candidates, {
      currentRepoId: "acme/service",
      relatedRepoIds: ["acme/dependency"],
      includeRelatedProjects: true,
    });
    expect(ranked.map((item) => item.id)).toEqual(["related"]);
    expect(ranked[0].scope).toBe("related_repo");
  });

  it("does not let a related-project alias override conflicting canonical evidence", () => {
    const ranked = applyRetrievalPolicy(
      [
        candidate("canonical-conflict", 0.02, {
          canonicalRepoId: "other/dependency",
          project: "acme/dependency",
          projectAliases: ["dependency"],
        }),
      ],
      {
        currentRepoId: "acme/service",
        relatedRepoIds: ["acme/dependency", "dependency"],
        includeRelatedProjects: true,
      },
    );
    expect(ranked).toEqual([]);
  });

  it("does not let a shared basename override conflicting canonical repositories", () => {
    const ranked = applyRetrievalPolicy(
      [
        candidate("other-agentmemory", 0.02, {
          project: "agentmemory",
          canonicalRepoId: "other/agentmemory",
        }),
        candidate("wrightpt-agentmemory", 0.015, {
          project: "agentmemory",
          canonicalRepoId: "wrightpt/agentmemory",
        }),
      ],
      {
        currentProject: "agentmemory",
        currentRepoId: "wrightpt/agentmemory",
        includeCrossRepo: true,
      },
    );
    expect(ranked.map((item) => [item.id, item.scope])).toEqual([
      ["wrightpt-agentmemory", "current_repo"],
      ["other-agentmemory", "cross_repo"],
    ]);
  });

  it("matches deterministic legacy project aliases when canonical identity is absent", () => {
    const ranked = applyRetrievalPolicy(
      [
        candidate("legacy", 0.015, {
          project: "old-agentmemory-name",
          projectAliases: ["agentmemory"],
        }),
      ],
      {
        currentProject: "agentmemory",
        currentProjectAliases: ["old-agentmemory-name"],
      },
    );
    expect(ranked[0]).toMatchObject({
      id: "legacy",
      scope: "current_repo",
      scopeReason: "same legacy project identity or alias",
    });
  });

  it("filters stale/superseded memories before ranking", () => {
    const ranked = applyRetrievalPolicy(
      [
        candidate("stale", 0.02, {
          canonicalRepoId: "acme/service",
          isLatest: false,
        }),
        candidate("current", 0.015, {
          canonicalRepoId: "acme/service",
          isLatest: true,
        }),
      ],
      { currentRepoId: "acme/service" },
    );
    expect(ranked.map((item) => item.id)).toEqual(["current"]);
  });

  it("authorizes agent scope before applying relevance boosts", () => {
    const ranked = applyRetrievalPolicy(
      [
        candidate("private", 0.02, {
          canonicalRepoId: "acme/service",
          agentId: "kimi",
        }),
        candidate("shared", 0.015, {
          canonicalRepoId: "acme/service",
          agentId: "codex",
        }),
      ],
      { currentRepoId: "acme/service", filterAgentId: "codex" },
    );
    expect(ranked.map((item) => item.id)).toEqual(["shared"]);
  });

  it("uses recency only after score, scope, importance, and confidence ties", () => {
    const ranked = applyRetrievalPolicy(
      [
        candidate("older-authoritative", 0.016, {
          canonicalRepoId: "acme/service",
          memoryType: "architecture",
          importance: 10,
          timestamp: "2020-01-01T00:00:00.000Z",
        }),
        candidate("recent-casual", 0.016, {
          canonicalRepoId: "acme/service",
          importance: 2,
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
      ],
      { currentRepoId: "acme/service" },
    );
    expect(ranked[0].id).toBe("older-authoritative");
  });

  it("is deterministic when every ranking signal ties", () => {
    const input = [candidate("z", 0.016), candidate("a", 0.016)];
    expect(applyRetrievalPolicy(input).map((item) => item.id)).toEqual(["a", "z"]);
    expect(applyRetrievalPolicy([...input].reverse()).map((item) => item.id)).toEqual([
      "a",
      "z",
    ]);
  });
});
