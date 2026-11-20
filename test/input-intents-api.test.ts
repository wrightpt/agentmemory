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

  it("whitelists reconcile fields and maps a refusal to 409", async () => {
    // This endpoint refuses outright without a configured secret, so the
    // whitelist is exercised through an authenticated request.
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, "configured-secret");
    let received: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::input-reconcile", async (data) => {
      received = data as Record<string, unknown>;
      return { success: false, error: "input_revision_conflict" };
    });

    const response = (await sdk.trigger("api::input-reconcile", {
      headers: { authorization: "Bearer configured-secret" },
      body: {
        intentId: "inp_1",
        operationId: "recon-1",
        expectedRevision: 4,
        targetSession: "shared-auto-launch-interactive-claude-a3f2aef00",
        payloadSha256: "c".repeat(64),
        deliveryStartedAt: "2026-11-20T05:33:51.294Z",
        providerSessionId: "7ceff68e-1a36-4819-b576-aeedeb21af20",
        providerIncarnation: "d".repeat(64),
        evidence: { source: "provider_transcript" },
        actor: "wsh:recovery",
        // None of these may reach the function: a caller must not be able to
        // name a status, force a claim or assert proof across this boundary.
        status: "accepted",
        reconciled: true,
        claimToken: "ict_forged",
        workerId: "wsh:forged",
        content: "must not cross this boundary",
      },
    })) as { status_code: number };

    expect(response.status_code).toBe(409);
    expect(Object.keys(received ?? {}).sort()).toEqual([
      "actor",
      "deliveryStartedAt",
      "evidence",
      "expectedRevision",
      "intentId",
      "operationId",
      "payloadSha256",
      "providerIncarnation",
      "providerSessionId",
      "targetSession",
    ]);
  });
});

describe("input reconciliation authentication boundary", () => {
  // `checkAuth` permits every request when no secret is configured, and the
  // installed engine currently runs without one. The only transition out of a
  // terminal ambiguous receipt must not be reachable on that basis.
  it("refuses reconciliation outright when no secret is configured", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never);
    let reached = false;
    sdk.registerFunction("mem::input-reconcile", async () => {
      reached = true;
      return { success: true };
    });

    const response = (await sdk.trigger("api::input-reconcile", {
      headers: {},
      body: { intentId: "inp_1" },
    })) as { status_code: number; body: { error?: string } };

    expect(response.status_code).toBe(503);
    expect(response.body.error).toContain("AGENTMEMORY_SECRET");
    expect(reached).toBe(false);
  });

  it("still requires a bearer token once a secret is configured", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, "configured-secret");
    let reached = false;
    sdk.registerFunction("mem::input-reconcile", async () => {
      reached = true;
      return { success: true };
    });

    const unauthorized = (await sdk.trigger("api::input-reconcile", {
      headers: {},
      body: { intentId: "inp_1" },
    })) as { status_code: number };
    expect(unauthorized.status_code).toBe(401);
    expect(reached).toBe(false);

    const authorized = (await sdk.trigger("api::input-reconcile", {
      headers: { authorization: "Bearer configured-secret" },
      body: { intentId: "inp_1" },
    })) as { status_code: number };
    expect(authorized.status_code).toBe(200);
    expect(reached).toBe(true);
  });
});
