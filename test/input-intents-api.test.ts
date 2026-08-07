import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("input intent REST boundaries", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never);
  });

  it("whitelists enqueue fields and maps a new receipt to 201", async () => {
    let received: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::input-enqueue", async (data) => {
      received = data as Record<string, unknown>;
      return {
        success: true,
        deduplicated: false,
        receipt: { intentId: "inp_1", revision: 1 },
      };
    });

    const response = (await sdk.trigger("api::input-enqueue", {
      headers: {},
      body: {
        idempotencyKey: "request-1",
        targetSession: "shared-auto-kimi-review",
        payloadRef: "payload.request-1",
        payloadSha256: "a".repeat(64),
        payloadBytes: 42,
        content: "must not cross this boundary",
        injectedInternalFlag: true,
      },
    })) as { status_code: number };

    expect(response.status_code).toBe(201);
    expect(received).toMatchObject({
      idempotencyKey: "request-1",
      targetSession: "shared-auto-kimi-review",
      payloadRef: "payload.request-1",
      payloadBytes: 42,
    });
    expect(received).not.toHaveProperty("content");
    expect(received).not.toHaveProperty("injectedInternalFlag");
  });

  it("maps duplicate receipts and idempotency conflicts distinctly", async () => {
    sdk.registerFunction("mem::input-enqueue", async () => ({
      success: true,
      deduplicated: true,
    }));
    await expect(
      sdk.trigger("api::input-enqueue", {
        headers: {},
        body: { idempotencyKey: "request-1" },
      }),
    ).resolves.toMatchObject({ status_code: 200 });

    sdk.registerFunction("mem::input-enqueue", async () => ({
      success: false,
      error: "idempotency_conflict",
    }));
    await expect(
      sdk.trigger("api::input-enqueue", {
        headers: {},
        body: { idempotencyKey: "request-1" },
      }),
    ).resolves.toMatchObject({ status_code: 409 });
  });

  it("rejects invalid list limits before dispatch", async () => {
    await expect(
      sdk.trigger("api::input-list", {
        headers: {},
        query_params: { limit: "0" },
      }),
    ).resolves.toEqual({
      status_code: 400,
      body: { error: "limit must be a positive integer" },
    });
  });
});
