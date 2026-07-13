import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("Observe REST ingestion", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let dispatched: Array<{
    function_id: string;
    payload: unknown;
    action?: unknown;
  }>;

  beforeEach(() => {
    sdk = mockSdk();
    dispatched = [];
    const invokeRegistered = sdk.trigger.bind(sdk);
    sdk.trigger = vi.fn(async (request, data?: unknown) => {
      if (
        typeof request !== "string" &&
        request.function_id === "mem::observe"
      ) {
        dispatched.push(request);
        // Model iii's acknowledgement of a void invocation. The observation
        // pipeline itself is deliberately not part of the HTTP response path.
        return undefined;
      }
      return invokeRegistered(request, data);
    }) as typeof sdk.trigger;

    registerApiTriggers(sdk as never, mockKV() as never);
  });

  it("acknowledges after dispatching observation work as a void invocation", async () => {
    const response = (await sdk.trigger("api::observe::async", {
      headers: {},
      body: {
        hookType: "post_tool_use",
        sessionId: "session-123",
        project: "agentmemory",
        cwd: "/repo/agentmemory",
        timestamp: "2026-07-13T23:00:00Z",
        data: { tool_name: "Read" },
      },
    })) as {
      status_code: number;
      body: { accepted: boolean; sessionId: string };
    };

    expect(response).toEqual({
      status_code: 202,
      body: { accepted: true, sessionId: "session-123" },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      function_id: "mem::observe",
      action: { type: "void" },
    });
  });

  it("keeps the original observe endpoint synchronous for API callers", async () => {
    const response = (await sdk.trigger("api::observe", {
      headers: {},
      body: {
        hookType: "prompt_submit",
        sessionId: "session-sync",
        project: "agentmemory",
        cwd: "/repo/agentmemory",
        timestamp: "2026-07-13T23:00:00Z",
        data: { prompt: "remember this" },
      },
    })) as { status_code: number };

    expect(response.status_code).toBe(201);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBeUndefined();
  });
});
