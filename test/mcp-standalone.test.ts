import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../src/mcp/transport.js", () => ({
  createStdioTransport: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock("../src/config.js", () => ({
  getStandalonePersistPath: vi.fn(() => "/tmp/test-standalone.json"),
  getAgentId: vi.fn(() => {
    const value = process.env["AGENT_ID"]?.trim();
    return value || undefined;
  }),
  isAgentScopeIsolated: vi.fn(
    () =>
      process.env["AGENTMEMORY_AGENT_SCOPE"] === "isolated" &&
      Boolean(process.env["AGENT_ID"]?.trim()),
  ),
}));

import {
  getAllTools,
  CORE_TOOLS,
  V040_TOOLS,
} from "../src/mcp/tools-registry.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { handleToolCall } from "../src/mcp/standalone.js";
import {
  resetHandleForTests,
  setLivezProbe,
} from "../src/mcp/rest-proxy.js";
import { writeFileSync } from "node:fs";

// Issue #449: hard-coded fetch() against :3111 in the livez probe was racing
// with vitest's mock setup, making this file the "10-11 pre-existing failures"
// referenced in the last 5 release notes. Stub the probe with an instant
// ok:false response so the shim takes the deterministic InMemoryKV fallback
// path on every test. Guard the real network with a fetch trap so any
// regression that bypasses the DI seam fails loudly instead of timing out.
const instantLocalFallbackProbe = vi.fn(async () => ({
  ok: false,
  status: 0,
  statusText: "stubbed: forced local fallback",
}));

const fetchTrap = vi.fn(async (url: unknown) => {
  throw new Error(
    `unexpected real fetch() call in mcp-standalone.test.ts: ${String(url)} — the livez probe DI stub should have absorbed this`,
  );
});

describe("Tools Registry", () => {
  it("getAllTools returns all tools with unique names", () => {
    const tools = getAllTools();
    expect(tools).toHaveLength(61);
    const names = new Set(tools.map((t) => t.name));
    expect(names.size).toBe(tools.length);
    for (const required of [
      "memory_verify",
      "memory_lesson_save",
      "memory_lesson_recall",
      "memory_obsidian_export",
      "memory_save",
      "memory_recall",
    ]) {
      expect(tools.some((t) => t.name === required)).toBe(true);
    }
  });

  it("CORE_TOOLS has 14 items", () => {
    expect(CORE_TOOLS.length).toBe(14);
  });

  it("V040_TOOLS has 8 items", () => {
    expect(V040_TOOLS.length).toBe(8);
  });

  it("all tools have required name, description, inputSchema fields", () => {
    const tools = getAllTools();
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });
});

describe("InMemoryKV", () => {
  let kv: InMemoryKV;

  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it("get/set/list/delete operations work", async () => {
    await kv.set("scope1", "key1", { value: "hello" });
    const result = await kv.get<{ value: string }>("scope1", "key1");
    expect(result).toEqual({ value: "hello" });

    const list = await kv.list("scope1");
    expect(list.length).toBe(1);

    await kv.delete("scope1", "key1");
    const afterDelete = await kv.get("scope1", "key1");
    expect(afterDelete).toBeNull();
  });

  it("list returns empty array for unknown scope", async () => {
    const result = await kv.list("nonexistent");
    expect(result).toEqual([]);
  });

  it("persist writes JSON", async () => {
    const kvWithPersist = new InMemoryKV("/tmp/test-kv.json");
    await kvWithPersist.set("scope1", "key1", { data: "test" });
    kvWithPersist.persist();

    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/test-kv.json",
      expect.any(String),
      "utf-8",
    );
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.scope1.key1).toEqual({ data: "test" });
  });

  it("set overwrites existing values", async () => {
    await kv.set("scope1", "key1", "first");
    await kv.set("scope1", "key1", "second");
    const result = await kv.get("scope1", "key1");
    expect(result).toBe("second");
    const list = await kv.list("scope1");
    expect(list.length).toBe(1);
  });
});

describe("handleToolCall", () => {
  const originalFetch = globalThis.fetch;
  const originalAgentId = process.env["AGENT_ID"];
  const originalAgentScope = process.env["AGENTMEMORY_AGENT_SCOPE"];

  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
    instantLocalFallbackProbe.mockClear();
    fetchTrap.mockClear();
    // Order matters: resetHandleForTests() restores the default probe and
    // clears the cached handle. Install the stub AFTER the reset so the
    // shim's next resolveHandle() call hits the stubbed instant-fail path
    // instead of the real 2s AbortController fetch.
    resetHandleForTests();
    setLivezProbe(instantLocalFallbackProbe);
    (globalThis as { fetch: typeof fetch }).fetch = fetchTrap as unknown as typeof fetch;
    delete process.env["AGENT_ID"];
    delete process.env["AGENTMEMORY_AGENT_SCOPE"];
  });

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    resetHandleForTests();
    if (originalAgentId === undefined) delete process.env["AGENT_ID"];
    else process.env["AGENT_ID"] = originalAgentId;
    if (originalAgentScope === undefined) {
      delete process.env["AGENTMEMORY_AGENT_SCOPE"];
    } else {
      process.env["AGENTMEMORY_AGENT_SCOPE"] = originalAgentScope;
    }
  });

  it("livez probe stub is invoked instead of the real fetch (issue #449)", async () => {
    const kv = new InMemoryKV();
    await handleToolCall("memory_save", { content: "regression guard" }, kv);
    expect(instantLocalFallbackProbe).toHaveBeenCalledTimes(1);
    expect(fetchTrap).not.toHaveBeenCalled();
  });

  it("memory_save persists to disk immediately after saving", async () => {
    const kv = new InMemoryKV("/tmp/test-handle.json");
    const result = await handleToolCall(
      "memory_save",
      { content: "Test memory content" },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.saved).toMatch(/^mem_/);
    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/test-handle.json",
      expect.any(String),
      "utf-8",
    );
  });

  it("memory_save without persist path does not call writeFileSync", async () => {
    const kv = new InMemoryKV();
    await handleToolCall("memory_save", { content: "No persist path" }, kv);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("memory_save throws when content is missing", async () => {
    const kv = new InMemoryKV();
    await expect(
      handleToolCall("memory_save", {}, kv),
    ).rejects.toThrow("content is required");
  });

  it("memory_save rejects non-string content safely (no runtime TypeError)", async () => {
    const kv = new InMemoryKV();
    // These would have crashed on .trim() before the type-guard fix.
    for (const bogus of [42, {}, [], null, undefined, true]) {
      await expect(
        handleToolCall("memory_save", { content: bogus }, kv),
      ).rejects.toThrow("content is required");
    }
  });

  it("memory_recall returns matching memories", async () => {
    const kv = new InMemoryKV();
    await handleToolCall("memory_save", { content: "TypeScript is great" }, kv);
    await handleToolCall("memory_save", { content: "Python is also great" }, kv);
    const result = await handleToolCall(
      "memory_recall",
      { query: "typescript" },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].content).toBe("TypeScript is great");
  });

  it("memory_save accepts concepts/files as arrays (plugin skill format, #139)", async () => {
    const kv = new InMemoryKV();
    const result = await handleToolCall(
      "memory_save",
      {
        content: "Use HMAC for API auth",
        concepts: ["hmac", "api-auth", "security"],
        files: ["src/auth.ts", "src/middleware.ts"],
      },
      kv,
    );
    const saved = JSON.parse(result.content[0].text);
    const mem = await kv.get<{ concepts: string[]; files: string[] }>(
      "mem:memories",
      saved.saved,
    );
    expect(mem?.concepts).toEqual(["hmac", "api-auth", "security"]);
    expect(mem?.files).toEqual(["src/auth.ts", "src/middleware.ts"]);
  });

  it("memory_save persists canonical project scope in local fallback", async () => {
    const kv = new InMemoryKV();
    const result = await handleToolCall(
      "memory_save",
      { content: "Scoped local memory", project: " agentmemory " },
      kv,
    );
    const saved = JSON.parse(result.content[0].text);
    const mem = await kv.get<{ project?: string }>(
      "mem:memories",
      saved.saved,
    );
    expect(mem?.project).toBe("agentmemory");
  });

  it("memory_save attributes local fallback rows to the configured agent", async () => {
    process.env["AGENT_ID"] = "codex";
    process.env["AGENTMEMORY_AGENT_SCOPE"] = "shared";
    const kv = new InMemoryKV();
    const saved = JSON.parse(
      (
        await handleToolCall(
          "memory_save",
          { content: "Attributed local memory" },
          kv,
        )
      ).content[0].text,
    );
    const memory = await kv.get<{ agentId?: string }>(
      "mem:memories",
      saved.saved,
    );
    expect(memory?.agentId).toBe("codex");
  });

  it("memory_save still accepts concepts/files as comma-separated strings (legacy)", async () => {
    const kv = new InMemoryKV();
    const result = await handleToolCall(
      "memory_save",
      {
        content: "JWT refresh rotation",
        concepts: "jwt, refresh, rotation",
        files: "src/auth.ts",
      },
      kv,
    );
    const saved = JSON.parse(result.content[0].text);
    const mem = await kv.get<{ concepts: string[]; files: string[] }>(
      "mem:memories",
      saved.saved,
    );
    expect(mem?.concepts).toEqual(["jwt", "refresh", "rotation"]);
    expect(mem?.files).toEqual(["src/auth.ts"]);
  });

  it("memory_smart_search falls back to substring match in the standalone shim (#139)", async () => {
    const kv = new InMemoryKV();
    await handleToolCall(
      "memory_save",
      { content: "Use bcrypt for password hashing" },
      kv,
    );
    await handleToolCall(
      "memory_save",
      { content: "Use argon2id for new projects" },
      kv,
    );
    const result = await handleToolCall(
      "memory_smart_search",
      { query: "bcrypt", limit: 5 },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].content).toBe("Use bcrypt for password hashing");
  });

  it("memory_smart_search rejects empty query to prevent match-all in forget flow (#139)", async () => {
    const kv = new InMemoryKV();
    await handleToolCall("memory_save", { content: "anything" }, kv);
    await expect(
      handleToolCall("memory_smart_search", {}, kv),
    ).rejects.toThrow("query or expandIds is required");
    await expect(
      handleToolCall("memory_smart_search", { query: "" }, kv),
    ).rejects.toThrow("query or expandIds is required");
    await expect(
      handleToolCall("memory_smart_search", { query: "   " }, kv),
    ).rejects.toThrow("query or expandIds is required");
  });

  it("memory_smart_search expands returned memory IDs without another query", async () => {
    const kv = new InMemoryKV();
    const saved = JSON.parse(
      (
        await handleToolCall(
          "memory_save",
          { content: "architecture provenance" },
          kv,
        )
      ).content[0].text,
    );
    const result = await handleToolCall(
      "memory_smart_search",
      { expandIds: saved.saved },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mode).toBe("expanded");
    expect(parsed.results[0].id).toBe(saved.saved);
  });

  it("applies explicit and isolated agent filters to compact and expanded local results", async () => {
    const kv = new InMemoryKV();
    process.env["AGENT_ID"] = "codex";
    const codex = JSON.parse(
      (
        await handleToolCall(
          "memory_save",
          { content: "shared isolation marker" },
          kv,
        )
      ).content[0].text,
    ).saved;
    process.env["AGENT_ID"] = "kimi";
    const kimi = JSON.parse(
      (
        await handleToolCall(
          "memory_save",
          { content: "shared isolation marker" },
          kv,
        )
      ).content[0].text,
    ).saved;

    process.env["AGENTMEMORY_AGENT_SCOPE"] = "shared";
    const explicit = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { query: "isolation marker", agentId: "codex" },
          kv,
        )
      ).content[0].text,
    );
    expect(explicit.results.map((row: { id: string }) => row.id)).toEqual([
      codex,
    ]);

    process.env["AGENT_ID"] = "codex";
    process.env["AGENTMEMORY_AGENT_SCOPE"] = "isolated";
    const compact = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { query: "isolation marker" },
          kv,
        )
      ).content[0].text,
    );
    expect(compact.results.map((row: { id: string }) => row.id)).toEqual([
      codex,
    ]);
    expect(compact.results[0].provenance.agentId).toBe("codex");

    const expanded = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { expandIds: [codex, kimi] },
          kv,
        )
      ).content[0].text,
    );
    expect(expanded.results.map((row: { id: string }) => row.id)).toEqual([
      codex,
    ]);

    const wildcard = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { expandIds: [codex, kimi], agentId: "*" },
          kv,
        )
      ).content[0].text,
    );
    expect(
      wildcard.results.map((row: { id: string }) => row.id).sort(),
    ).toEqual([codex, kimi].sort());
  });

  it("fails closed in isolated local fallback when no agent identity is available", async () => {
    process.env["AGENTMEMORY_AGENT_SCOPE"] = "isolated";
    delete process.env["AGENT_ID"];
    const kv = new InMemoryKV();
    await kv.set("mem:memories", "mem_unscoped", {
      id: "mem_unscoped",
      content: "private marker",
      isLatest: true,
    });
    await expect(
      handleToolCall(
        "memory_smart_search",
        { query: "private marker" },
        kv,
      ),
    ).rejects.toThrow(/AGENTMEMORY_AGENT_SCOPE=isolated/);
  });

  it("honors mission, repository, related, global, and cross-repo scope in local fallback", async () => {
    const kv = new InMemoryKV();
    const sessions = [
      {
        id: "sess_current",
        project: "agentmemory",
        projectAliases: ["memory-engine"],
        canonicalRepoId: "wrightpt/agentmemory",
        missionId: "mission-fleet-memory",
        cwd: "/repos/agentmemory",
        startedAt: "2026-08-21T10:00:00.000Z",
        status: "active",
        observationCount: 0,
      },
      {
        id: "sess_related",
        project: "workstation-shell",
        canonicalRepoId: "wrightpt/workstation-shell",
        missionId: "mission-other",
        cwd: "/repos/workstation-shell",
        startedAt: "2026-08-21T09:00:00.000Z",
        status: "completed",
        observationCount: 0,
      },
      {
        id: "sess_unrelated",
        project: "distractor",
        canonicalRepoId: "elsewhere/distractor",
        missionId: "mission-other",
        cwd: "/repos/distractor",
        startedAt: "2026-08-21T08:00:00.000Z",
        status: "completed",
        observationCount: 0,
      },
    ];
    for (const session of sessions) {
      await kv.set("mem:sessions", session.id, session);
    }
    const save = async (content: string, args: Record<string, unknown>) =>
      JSON.parse(
        (
          await handleToolCall(
            "memory_save",
            { content, ...args },
            kv,
          )
        ).content[0].text,
      ).saved as string;
    const current = await save("scope architecture marker current", {
      sessionId: "sess_current",
    });
    const related = await save("scope architecture marker related", {
      sessionId: "sess_related",
    });
    const unrelated = await save("scope architecture marker unrelated", {
      sessionId: "sess_unrelated",
    });
    const global = await save("scope architecture marker global", {
      project: "global",
    });

    const localOnly = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          {
            query: "scope architecture marker",
            sessionId: "sess_current",
            includeGlobal: false,
          },
          kv,
        )
      ).content[0].text,
    );
    expect(localOnly.results.map((row: { id: string }) => row.id)).toEqual([
      current,
    ]);
    expect(localOnly.results[0]).toMatchObject({
      scope: "current_mission",
      provenance: {
        project: "agentmemory",
        canonicalRepoId: "wrightpt/agentmemory",
        missionId: "mission-fleet-memory",
      },
    });

    const relatedSearch = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          {
            query: "scope architecture marker",
            currentRepo: "https://github.com/wrightpt/agentmemory.git",
            currentProject: "agentmemory",
            missionId: "mission-fleet-memory",
            includeRelatedProjects: true,
            relatedProjects: ["https://github.com/wrightpt/workstation-shell.git"],
            includeGlobal: true,
            includeCrossRepo: false,
          },
          kv,
        )
      ).content[0].text,
    );
    const byId = new Map(
      relatedSearch.results.map((row: { id: string; scope: string }) => [
        row.id,
        row.scope,
      ]),
    );
    expect(byId.get(current)).toBe("current_mission");
    expect(byId.get(related)).toBe("related_repo");
    expect(byId.get(global)).toBe("global");
    expect(byId.has(unrelated)).toBe(false);

    const wide = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          {
            query: "scope architecture marker",
            currentRepo: "wrightpt/agentmemory",
            currentProject: "agentmemory",
            includeCrossRepo: true,
          },
          kv,
        )
      ).content[0].text,
    );
    expect(wide.results.some((row: { id: string }) => row.id === unrelated)).toBe(
      true,
    );
  });

  it("rejects implicit relationship resolution and suppresses stale rows locally", async () => {
    const kv = new InMemoryKV();
    for (const [id, extra] of [
      ["mem_superseded", { isLatest: false }],
      ["mem_stale", { stale: true }],
      ["mem_expired", { forgetAfter: "2020-01-01T00:00:00.000Z" }],
    ] as const) {
      await kv.set("mem:memories", id, {
        id,
        type: "fact",
        title: "stale marker",
        content: "stale marker",
        concepts: [],
        files: [],
        sessionIds: [],
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
        strength: 7,
        version: 1,
        isLatest: true,
        ...extra,
      });
    }
    const compact = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { query: "stale marker" },
          kv,
        )
      ).content[0].text,
    );
    expect(compact.results).toEqual([]);
    const expanded = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { expandIds: ["mem_superseded", "mem_stale", "mem_expired"] },
          kv,
        )
      ).content[0].text,
    );
    expect(expanded.results).toEqual([]);
    await expect(
      handleToolCall(
        "memory_smart_search",
        {
          query: "stale marker",
          currentRepo: "wrightpt/agentmemory",
          includeRelatedProjects: true,
        },
        kv,
      ),
    ).rejects.toThrow(/pass explicit relatedProjects/i);
  });

  it("memory_smart_search searches files and concepts, not just title/content (#139)", async () => {
    const kv = new InMemoryKV();
    await handleToolCall(
      "memory_save",
      {
        content: "generic note",
        concepts: ["oauth", "token-rotation"],
        files: ["src/auth/refresh.ts"],
      },
      kv,
    );
    await handleToolCall("memory_save", { content: "unrelated" }, kv);

    // Find by file path
    const byFile = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { query: "src/auth/refresh.ts" },
          kv,
        )
      ).content[0].text,
    );
    expect(byFile.results).toHaveLength(1);
    expect(byFile.results[0].files).toContain("src/auth/refresh.ts");

    // Find by concept
    const byConcept = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { query: "token-rotation" },
          kv,
        )
      ).content[0].text,
    );
    expect(byConcept.results).toHaveLength(1);
  });

  it("memory_sessions honours the limit arg (#139)", async () => {
    const kv = new InMemoryKV();
    for (let i = 0; i < 5; i++) {
      await kv.set("mem:sessions", `ses_${i}`, {
        id: `ses_${i}`,
        project: "demo",
        cwd: "/demo",
        startedAt: `2026-07-0${i + 1}T00:00:00Z`,
        status: "completed",
        observationCount: i,
      });
    }
    const result = await handleToolCall(
      "memory_sessions",
      { limit: 2 },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.pagination).toMatchObject({ total: 5, hasMore: true });
  });

  it("parseLimit clamps bad/malicious limit values to a safe range", async () => {
    const kv = new InMemoryKV();
    for (let i = 0; i < 150; i++) {
      await handleToolCall("memory_save", { content: `mem ${i}` }, kv);
    }

    // Negative / NaN / Infinity / string / object — all should fall back
    // to the default (10) for memory_smart_search.
    for (const bogus of [-1, NaN, Infinity, "abc", {}, true]) {
      const r = await handleToolCall(
        "memory_smart_search",
        { query: "mem", limit: bogus },
        kv,
      );
      expect(JSON.parse(r.content[0].text).results).toHaveLength(10);
    }

    // An absurdly large limit gets clamped to MAX_LIMIT (100).
    const huge = await handleToolCall(
      "memory_smart_search",
      { query: "mem", limit: 99999 },
      kv,
    );
    expect(JSON.parse(huge.content[0].text).results).toHaveLength(100);
  });

  it("memory_governance_delete removes memories by id array (#139)", async () => {
    const kv = new InMemoryKV();
    const a = JSON.parse(
      (await handleToolCall("memory_save", { content: "one" }, kv)).content[0]
        .text,
    );
    const b = JSON.parse(
      (await handleToolCall("memory_save", { content: "two" }, kv)).content[0]
        .text,
    );
    const c = JSON.parse(
      (await handleToolCall("memory_save", { content: "three" }, kv)).content[0]
        .text,
    );
    const result = await handleToolCall(
      "memory_governance_delete",
      { memoryIds: [a.saved, c.saved] },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(2);
    expect(parsed.requested).toBe(2);

    const remaining = await kv.list<Record<string, unknown>>("mem:memories");
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as { id: string }).id).toBe(b.saved);
  });

  it("memory_governance_delete accepts CSV-string memoryIds too", async () => {
    const kv = new InMemoryKV();
    const saved = JSON.parse(
      (await handleToolCall("memory_save", { content: "x" }, kv)).content[0]
        .text,
    );
    const result = await handleToolCall(
      "memory_governance_delete",
      { memoryIds: saved.saved, reason: "test csv" },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(1);
    expect(parsed.reason).toBe("test csv");
  });

  it("memory_governance_delete throws when memoryIds is missing or empty", async () => {
    const kv = new InMemoryKV();
    await expect(
      handleToolCall("memory_governance_delete", {}, kv),
    ).rejects.toThrow("memoryIds is required");
    await expect(
      handleToolCall("memory_governance_delete", { memoryIds: [] }, kv),
    ).rejects.toThrow("memoryIds is required");
  });

  it("memory_governance_delete silently skips unknown ids", async () => {
    const kv = new InMemoryKV();
    const saved = JSON.parse(
      (await handleToolCall("memory_save", { content: "real" }, kv)).content[0]
        .text,
    );
    const result = await handleToolCall(
      "memory_governance_delete",
      { memoryIds: [saved.saved, "mem_does_not_exist"] },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(1);
    expect(parsed.requested).toBe(2);
  });
});
