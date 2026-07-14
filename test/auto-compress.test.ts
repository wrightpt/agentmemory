import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RawObservation } from "../src/types.js";

const ORIGINAL_ANTHROPIC_API_KEY = process.env["ANTHROPIC_API_KEY"];

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  const triggered: Array<{ id: string; data: unknown }> = [];
  return {
    fns,
    triggered,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
      _options?: Record<string, unknown>,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      triggered.push({ id, data: payload });
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function validPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "ses_test",
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      tool_output: "file contents here",
    },
    ...overrides,
  };
}

describe("mem::observe auto-compress gate (#138)", () => {
  beforeEach(() => {
    // Reset module cache so observe.js re-imports config.js with the
    // fresh AGENTMEMORY_AUTO_COMPRESS env state. Without this, a later
    // test that sets the env var can be undermined by cached module
    // state from an earlier test (and vice versa).
    vi.resetModules();
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
    delete process.env["AGENTMEMORY_DISABLE_LLM_TOOLS"];
  });
  afterEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
    delete process.env["AGENTMEMORY_DISABLE_LLM_TOOLS"];
    if (ORIGINAL_ANTHROPIC_API_KEY === undefined) {
      delete process.env["ANTHROPIC_API_KEY"];
    } else {
      process.env["ANTHROPIC_API_KEY"] = ORIGINAL_ANTHROPIC_API_KEY;
    }
  });

  it("default (AGENTMEMORY_AUTO_COMPRESS unset): does NOT fire mem::compress", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger(
      "mem::observe",
      validPayload(),
    )) as { observationId: string };

    expect(result.observationId).toBeTruthy();
    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls).toHaveLength(0);
  });

  it("default: stores a synthetic CompressedObservation with the raw-derived fields", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const payload = validPayload();
    await sdk.trigger("mem::observe", payload);

    const scope = `mem:obs:${payload.sessionId}`;
    const stored = kv.store.get(scope);
    expect(stored).toBeDefined();
    expect(stored!.size).toBe(1);
    const [entry] = Array.from(stored!.values());
    const obs = entry as {
      type: string;
      title: string;
      files: string[];
      confidence: number;
    };
    expect(obs.type).toBe("file_read");
    expect(obs.title).toBe("Read");
    expect(obs.files).toContain("src/foo.ts");
    expect(obs.confidence).toBe(0.3);
  });

  it("default: keeps viewer updates transient while retaining the session stream", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", validPayload());

    const callsForGroup = (groupId: string) =>
      sdk.triggered.filter(
        (call) =>
          (call.data as { group_id?: string } | undefined)?.group_id === groupId,
      );
    const viewerCalls = callsForGroup("viewer");
    expect(viewerCalls.map((call) => call.id)).toEqual([
      "stream::send",
      "stream::send",
    ]);
    expect(
      viewerCalls.map(
        (call) => (call.data as { type?: string } | undefined)?.type,
      ),
    ).toEqual(["raw_observation", "compressed_observation"]);

    const sessionCalls = callsForGroup("ses_test");
    expect(sessionCalls.map((call) => call.id)).toEqual([
      "stream::set",
      "stream::set",
    ]);
  });

  it("makes a durable queue retry idempotent after the observation is complete", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    const payload = validPayload({ observationId: "obs_durable_retry_1" });

    const first = (await sdk.trigger("mem::observe", payload)) as {
      observationId: string;
    };
    const second = (await sdk.trigger("mem::observe", payload)) as {
      observationId: string;
      deduplicated: boolean;
      durableRetry: boolean;
    };

    expect(first.observationId).toBe("obs_durable_retry_1");
    expect(second).toEqual({
      observationId: "obs_durable_retry_1",
      deduplicated: true,
      durableRetry: true,
    });
    expect(kv.store.get("mem:obs:ses_test")?.size).toBe(1);
  });

  it("resumes a durable retry after the raw write despite the duplicate filter", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const { DedupMap } = await import("../src/functions/dedup.js");
    const sdk = mockSdk();
    const kv = mockKV();
    const dedupMap = new DedupMap();
    const payload = validPayload({ observationId: "obs_partial_retry_1" });
    const toolData = payload.data as {
      tool_name: string;
      tool_input: unknown;
    };
    const dedupHash = dedupMap.computeHash(
      payload.sessionId as string,
      toolData.tool_name,
      toolData.tool_input,
    );
    dedupMap.record(dedupHash);
    await kv.set(
      `mem:obs:${payload.sessionId}`,
      "obs_partial_retry_1",
      {
        id: "obs_partial_retry_1",
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: payload.data,
        toolName: toolData.tool_name,
        toolInput: toolData.tool_input,
        toolOutput: "file contents here",
      },
    );
    registerObserveFunction(sdk as never, kv as never, dedupMap);

    try {
      const result = (await sdk.trigger("mem::observe", payload)) as {
        observationId: string;
      };
      const stored = kv.store
        .get("mem:obs:ses_test")
        ?.get("obs_partial_retry_1") as { title?: string };

      expect(result.observationId).toBe("obs_partial_retry_1");
      expect(stored.title).toBe("Read");
    } finally {
      dedupMap.stop();
    }
  });

  it("AGENTMEMORY_AUTO_COMPRESS=true: fires mem::compress exactly once", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    process.env["ANTHROPIC_API_KEY"] = "test-only-key";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", validPayload());

    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls).toHaveLength(1);
  });

  it("AGENTMEMORY_AUTO_COMPRESS=false explicitly: does NOT fire mem::compress", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", validPayload());

    const compressCalls = sdk.triggered.filter((t) => t.id === "mem::compress");
    expect(compressCalls).toHaveLength(0);
  });
});

describe("buildSyntheticCompression", () => {
  it("maps common tool names to the right ObservationType", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const base: RawObservation = {
      id: "obs_1",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      raw: {},
    };
    const cases: Array<[string, string]> = [
      ["Read", "file_read"],
      ["Write", "file_write"],
      ["Edit", "file_edit"],
      ["Bash", "command_run"],
      ["Grep", "search"],
      ["WebFetch", "web_fetch"],
      ["Task", "subagent"],
      ["UnknownTool", "other"],
    ];
    for (const [name, expectedType] of cases) {
      const synthetic = (
        await import("../src/functions/compress-synthetic.js")
      ).buildSyntheticCompression({ ...base, toolName: name });
      expect(synthetic.type, `${name} -> ${expectedType}`).toBe(expectedType);
    }
    // silence unused warning — buildSyntheticCompression is used above
    expect(typeof buildSyntheticCompression).toBe("function");
  });

  it("extracts file paths from tool_input into the files array", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const synth = buildSyntheticCompression({
      id: "obs_2",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      toolName: "Edit",
      toolInput: { file_path: "/app/src/bar.ts", pattern: "foo" },
      raw: {},
    });
    expect(synth.files).toContain("/app/src/bar.ts");
    expect(synth.files).toContain("foo");
    expect(synth.type).toBe("file_edit");
  });

  it("truncates long narratives so it can't blow up the index", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const longInput = "x".repeat(2000);
    const synth = buildSyntheticCompression({
      id: "obs_3",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_use",
      toolName: "Bash",
      toolInput: { command: longInput },
      toolOutput: longInput,
      raw: {},
    });
    expect(synth.narrative.length).toBeLessThanOrEqual(400);
  });

  it("maps post_tool_failure to the error type even with no tool name", async () => {
    const { buildSyntheticCompression } = await import(
      "../src/functions/compress-synthetic.js"
    );
    const synth = buildSyntheticCompression({
      id: "obs_4",
      sessionId: "ses_1",
      timestamp: new Date().toISOString(),
      hookType: "post_tool_failure",
      raw: {},
    });
    expect(synth.type).toBe("error");
  });
});
