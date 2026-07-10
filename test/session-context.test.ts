import { describe, expect, it } from "vitest";
import { registerSessionContextFunction } from "../src/functions/session-context.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    update: async (scope: string, key: string, updates: Array<{ path: string; value: unknown }>) => {
      const value = (store.get(scope)?.get(key) as Record<string, unknown>) ?? {};
      for (const update of updates) value[update.path] = update.value;
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const handlers = new Map<string, Function>();
  return {
    handlers,
    registerFunction: (id: string, handler: Function) => handlers.set(id, handler),
    trigger: async (input: { function_id: string; payload: unknown }) => {
      const handler = handlers.get(input.function_id);
      if (!handler) throw new Error(`missing handler ${input.function_id}`);
      return handler(input.payload);
    },
  };
}

describe("session context updates", () => {
  it("updates context, keeps the old project as an alias, and writes an audit row", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerSessionContextFunction(sdk as never, kv as never);
    await kv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "/legacy/path",
      cwd: "/legacy/path",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 2,
    });

    const result = await sdk.trigger({
      function_id: "mem::session-context-update",
      payload: {
        sessionId: "ses_1",
        project: "canonical-project",
        cwd: "/repo/worktree",
        repoRoot: "/repo/main",
        worktree: "/repo/worktree",
        branch: "feat/context",
        taskSlug: "context-v1",
      },
    }) as { success: boolean; changed: string[]; context: Record<string, unknown> };

    expect(result.success).toBe(true);
    expect(result.changed).toContain("project");
    expect(result.context).toMatchObject({
      project: "canonical-project",
      cwd: "/repo/worktree",
      repoRoot: "/repo/main",
      worktree: "/repo/worktree",
      branch: "feat/context",
      taskSlug: "context-v1",
      projectAliases: ["/legacy/path"],
    });
    expect((await kv.list("mem:audit"))).toHaveLength(1);
  });

  it("is idempotent when context is unchanged", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerSessionContextFunction(sdk as never, kv as never);
    await kv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "canonical-project",
      cwd: "/repo",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    });

    const result = await sdk.trigger({
      function_id: "mem::session-context-update",
      payload: { sessionId: "ses_1", project: "canonical-project", cwd: "/repo" },
    }) as { success: boolean; changed: string[] };

    expect(result).toMatchObject({ success: true, changed: [] });
    expect((await kv.list("mem:audit"))).toHaveLength(0);
  });

  it("returns a typed miss instead of creating a malformed session", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerSessionContextFunction(sdk as never, kv as never);
    const result = await sdk.trigger({
      function_id: "mem::session-context-update",
      payload: { sessionId: "missing", project: "canonical-project" },
    }) as { success: boolean; error: string };
    expect(result).toEqual({ success: false, error: "session not found", sessionId: "missing" });
  });
});
