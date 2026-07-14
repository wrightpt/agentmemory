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
  let rejectQueue: boolean;

  beforeEach(() => {
    sdk = mockSdk();
    dispatched = [];
    rejectQueue = false;
    const invokeRegistered = sdk.trigger.bind(sdk);
    sdk.trigger = vi.fn(async (request, data?: unknown) => {
      if (
        typeof request !== "string" &&
        request.function_id === "mem::observe"
      ) {
        dispatched.push(request);
        if (request.action && (request.action as { type?: string }).type === "enqueue") {
          if (rejectQueue) throw new Error("queue store unavailable");
          return { messageReceiptId: "receipt-123" };
        }
        return undefined;
      }
      return invokeRegistered(request, data);
    }) as typeof sdk.trigger;

    registerApiTriggers(sdk as never, mockKV() as never);
  });

  it("acknowledges only after the durable observation queue returns a receipt", async () => {
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
      body: {
        accepted: boolean;
        sessionId: string;
        observationId: string;
        messageReceiptId: string;
      };
    };

    expect(response).toMatchObject({
      status_code: 202,
      body: {
        accepted: true,
        sessionId: "session-123",
        messageReceiptId: "receipt-123",
      },
    });
    expect(response.body.observationId).toMatch(/^obs_/);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      function_id: "mem::observe",
      action: { type: "enqueue", queue: "agentmemory-observations" },
      payload: { observationId: response.body.observationId },
    });
  });

  it("returns a retryable 503 when durable queue acceptance fails", async () => {
    rejectQueue = true;

    const response = (await sdk.trigger("api::observe::async", {
      headers: {},
      body: {
        hookType: "post_tool_use",
        sessionId: "session-queue-down",
        project: "agentmemory",
        cwd: "/repo/agentmemory",
        timestamp: "2026-07-13T23:00:00Z",
        data: { tool_name: "Read" },
      },
    })) as { status_code: number; body: unknown };

    expect(response).toEqual({
      status_code: 503,
      body: {
        accepted: false,
        retryable: true,
        error: "observation_queue_unavailable",
      },
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
