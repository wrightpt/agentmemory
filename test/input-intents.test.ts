import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInputIntentsFunction } from "../src/functions/input-intents.js";
import type { InputIntent } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const BASE_TIME = new Date("2026-08-07T02:00:00.000Z");
const PAYLOAD_SHA = "a".repeat(64);

describe("durable input intents", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    sdk = mockSdk();
    kv = mockKV();
    registerInputIntentsFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function enqueue(
    overrides: Record<string, unknown> = {},
  ): Promise<InputIntent> {
    const result = (await sdk.trigger("mem::input-enqueue", {
      idempotencyKey: "request-1",
      targetSession: "shared-auto-kimi-review",
      sourceSession: "shared-web-term-39",
      payloadRef: "payload.request-1",
      payloadSha256: PAYLOAD_SHA,
      payloadBytes: 42,
      actor: "workstation-shell",
      ...overrides,
    })) as { success: boolean; intent: InputIntent };
    expect(result.success).toBe(true);
    return result.intent;
  }

  it("deduplicates a matching enqueue and rejects conflicting reuse", async () => {
    const first = await enqueue();
    const duplicate = (await sdk.trigger("mem::input-enqueue", {
      idempotencyKey: "request-1",
      targetSession: "shared-auto-kimi-review",
      sourceSession: "shared-web-term-39",
      payloadRef: "payload.request-1",
      payloadSha256: PAYLOAD_SHA,
      payloadBytes: 42,
    })) as {
      success: boolean;
      deduplicated: boolean;
      intent: InputIntent;
    };
    expect(duplicate).toMatchObject({
      success: true,
      deduplicated: true,
      intent: { id: first.id, revision: 1 },
    });

    const conflict = await sdk.trigger("mem::input-enqueue", {
      idempotencyKey: "request-1",
      targetSession: "shared-auto-kimi-review",
      payloadRef: "payload.request-1",
      payloadSha256: "b".repeat(64),
      payloadBytes: 42,
    });
    expect(conflict).toMatchObject({
      success: false,
      error: "idempotency_conflict",
      intentId: first.id,
    });
  });

  it("requires transcript evidence before accepting a started delivery", async () => {
    const intent = await enqueue();
    const claimed = (await sdk.trigger("mem::input-claim", {
      workerId: "wsh:broker-1",
      targetSession: intent.targetSession,
    })) as {
      success: boolean;
      claimToken: string;
      intent: InputIntent;
    };
    expect(claimed.intent).toMatchObject({
      id: intent.id,
      status: "claimed",
      attempts: 1,
      claimedBy: "wsh:broker-1",
    });

    await expect(
      sdk.trigger("mem::input-start", {
        intentId: intent.id,
        workerId: "wsh:broker-1",
        claimToken: claimed.claimToken,
      }),
    ).resolves.toMatchObject({
      success: true,
      intent: { deliveryStartedAt: BASE_TIME.toISOString() },
    });

    await expect(
      sdk.trigger("mem::input-settle", {
        intentId: intent.id,
        workerId: "wsh:broker-1",
        claimToken: claimed.claimToken,
        outcome: "retry",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "unsafe_retry_after_delivery_start",
    });

    await expect(
      sdk.trigger("mem::input-settle", {
        intentId: intent.id,
        workerId: "wsh:broker-1",
        claimToken: claimed.claimToken,
        outcome: "accepted",
        evidence: {
          source: "provider_transcript",
          observedAt: BASE_TIME.toISOString(),
          messageSha256: "b".repeat(64),
        },
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "accepted_requires_matching_transcript_evidence",
    });

    const accepted = await sdk.trigger("mem::input-settle", {
      intentId: intent.id,
      workerId: "wsh:broker-1",
      claimToken: claimed.claimToken,
      outcome: "accepted",
      evidence: {
        source: "provider_transcript",
        observedAt: BASE_TIME.toISOString(),
        messageSha256: PAYLOAD_SHA,
        transcriptCursor: "wire:42",
      },
    });
    expect(accepted).toMatchObject({
      success: true,
      intent: {
        status: "accepted",
        claimedBy: undefined,
        evidence: {
          source: "provider_transcript",
          messageSha256: PAYLOAD_SHA,
          transcriptCursor: "wire:42",
        },
      },
    });
  });

  it("reclaims an expired claim only when delivery never started", async () => {
    const intent = await enqueue();
    await sdk.trigger("mem::input-claim", {
      workerId: "wsh:broker-1",
      targetSession: intent.targetSession,
      ttlMs: 1_000,
    });
    vi.advanceTimersByTime(1_001);

    const reclaimed = await sdk.trigger("mem::input-claim", {
      workerId: "wsh:broker-2",
      targetSession: intent.targetSession,
    });
    expect(reclaimed).toMatchObject({
      success: true,
      intent: {
        id: intent.id,
        status: "claimed",
        attempts: 2,
        claimedBy: "wsh:broker-2",
      },
    });
  });

  it("turns an expired started claim ambiguous instead of resending it", async () => {
    const intent = await enqueue();
    const claim = (await sdk.trigger("mem::input-claim", {
      workerId: "wsh:broker-1",
      targetSession: intent.targetSession,
      ttlMs: 1_000,
    })) as { claimToken: string };
    await sdk.trigger("mem::input-start", {
      intentId: intent.id,
      workerId: "wsh:broker-1",
      claimToken: claim.claimToken,
    });
    vi.advanceTimersByTime(1_001);

    await expect(
      sdk.trigger("mem::input-claim", {
        workerId: "wsh:broker-2",
        targetSession: intent.targetSession,
      }),
    ).resolves.toEqual({ success: true, intent: null });

    const listed = await sdk.trigger("mem::input-list", {
      intentId: intent.id,
    });
    expect(listed).toMatchObject({
      success: true,
      intents: [
        {
          status: "ambiguous",
          lastErrorCode: "claim_expired_after_delivery_start",
        },
      ],
    });
  });

  it("never stores prompt content and refuses cancellation while claimed", async () => {
    const intent = await enqueue({ content: "do not persist this prompt" });
    expect(JSON.stringify(intent)).not.toContain("do not persist");
    await sdk.trigger("mem::input-claim", {
      workerId: "wsh:broker-1",
      targetSession: intent.targetSession,
    });
    await expect(
      sdk.trigger("mem::input-cancel", {
        intentId: intent.id,
        actor: "operator",
        reason: "operator_cancelled",
      }),
    ).resolves.toMatchObject({
      success: false,
      error: "claimed_intent_cannot_be_cancelled",
    });
  });
});
