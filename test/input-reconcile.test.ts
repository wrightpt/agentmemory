import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInputIntentsFunction } from "../src/functions/input-intents.js";
import type { AuditEntry, InputIntent } from "../src/types.js";
import { listAuditEntries } from "../src/state/partitioned-ledgers.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const BASE_TIME = new Date("2026-11-20T05:33:50.000Z");
const PAYLOAD_SHA = "c".repeat(64);
const INCARNATION = "d".repeat(64);
const PROVIDER = "7ceff68e-1a36-4819-b576-aeedeb21af20";
const TARGET = "shared-auto-launch-interactive-claude-a3f2aef00";
const WORKER = "wsh:broker-1";

describe("evidence-only reconciliation of an ambiguous input", () => {
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

  // An ambiguous row is produced the only way production produces one: a claim
  // that started delivery and then lost its lease.
  async function ambiguous(): Promise<InputIntent> {
    const enqueued = (await sdk.trigger("mem::input-enqueue", {
      idempotencyKey: "closeout-owner-recovery-wrap-1635",
      targetSession: TARGET,
      sourceSession: "agent:chatgpt-private-orchestrator",
      payloadRef: "payload.wrap-1635",
      payloadSha256: PAYLOAD_SHA,
      payloadBytes: 2752,
      actor: "workstation-shell",
    })) as { intent: InputIntent };
    const claimed = (await sdk.trigger("mem::input-claim", {
      workerId: WORKER,
      targetSession: TARGET,
    })) as { claimToken: string };
    await sdk.trigger("mem::input-start", {
      intentId: enqueued.intent.id,
      workerId: WORKER,
      claimToken: claimed.claimToken,
    });
    const settled = (await sdk.trigger("mem::input-settle", {
      intentId: enqueued.intent.id,
      workerId: WORKER,
      claimToken: claimed.claimToken,
      outcome: "ambiguous",
      errorCode: "claude_session_context_required",
    })) as { intent: InputIntent };
    expect(settled.intent).toMatchObject({
      status: "ambiguous",
      attempts: 1,
      lastErrorCode: "claude_session_context_required",
    });
    return settled.intent;
  }

  const proofFor = (intent: InputIntent, overrides: Record<string, unknown> = {}) => ({
    intentId: intent.id,
    operationId: "recon-1635-001",
    expectedRevision: intent.revision,
    targetSession: intent.targetSession,
    payloadSha256: intent.payloadSha256,
    deliveryStartedAt: intent.deliveryStartedAt,
    providerSessionId: PROVIDER,
    providerIncarnation: INCARNATION,
    evidence: {
      source: "provider_transcript",
      observedAt: new Date(BASE_TIME.getTime() + 60_000).toISOString(),
      messageSha256: intent.payloadSha256,
      transcriptCursor: `${PROVIDER}:2026-11-20T05:34:50.000Z:1602`,
    },
    actor: "wsh:recovery",
    ...overrides,
  });

  it("reconciles a proven delivery without touching claim, attempts or delivery facts", async () => {
    const intent = await ambiguous();
    // The in-memory store keeps the same object, so snapshot what the row said
    // before the transition instead of reading it back through the alias.
    const priorRevision = intent.revision;
    const startedAt = intent.deliveryStartedAt;
    const result = (await sdk.trigger(
      "mem::input-reconcile",
      proofFor(intent),
    )) as { success: boolean; intent: InputIntent };

    expect(result.success).toBe(true);
    expect(result.intent).toMatchObject({
      status: "reconciled",
      attempts: 1,
      deliveryStartedAt: startedAt,
      revision: priorRevision + 1,
    });
    // Never `accepted`: that predicate needs a completed exchange observed at
    // delivery time, which a later read cannot establish.
    expect(result.intent.status).not.toBe("accepted");
    expect(result.intent.reconciliation).toMatchObject({
      source: "evidence_only_reconciliation",
      operationId: "recon-1635-001",
      priorStatus: "ambiguous",
      priorRevision,
      priorErrorCode: "claude_session_context_required",
      deliveryStartedAt: startedAt,
      attemptsAtReconciliation: 1,
      providerSessionId: PROVIDER,
      providerIncarnation: INCARNATION,
    });
    expect(result.intent.claimToken).toBeUndefined();
    expect(result.intent.claimedBy).toBeUndefined();
  });

  it("appends its own audit entry and leaves the earlier ones intact", async () => {
    const intent = await ambiguous();
    await sdk.trigger("mem::input-reconcile", proofFor(intent));
    const audit = await listAuditEntries(kv as never);
    const operations = audit.map((entry) => entry.operation);
    expect(operations).toContain("input_enqueue");
    expect(operations).toContain("input_settle");
    expect(operations.filter((o) => o === "input_reconcile")).toHaveLength(1);
    const reconcileEntry = audit.find((e) => e.operation === "input_reconcile");
    expect(reconcileEntry?.details).toMatchObject({
      operationId: "recon-1635-001",
      priorStatus: "ambiguous",
      priorErrorCode: "claude_session_context_required",
      status: "reconciled",
    });
  });

  it("is idempotent for the same operation and refuses a conflicting replay", async () => {
    const intent = await ambiguous();
    const priorRevision = intent.revision;
    const first = (await sdk.trigger("mem::input-reconcile", proofFor(intent))) as {
      intent: InputIntent;
    };
    const repeat = (await sdk.trigger("mem::input-reconcile", proofFor(intent))) as {
      success: boolean;
      idempotent?: boolean;
      intent: InputIntent;
    };
    expect(repeat.success).toBe(true);
    expect(repeat.idempotent).toBe(true);
    expect(repeat.intent.revision).toBe(priorRevision + 1);
    expect(first.intent.revision).toBe(priorRevision + 1);

    await expect(
      sdk.trigger(
        "mem::input-reconcile",
        proofFor(intent, { operationId: "recon-1635-002" }),
      ),
    ).resolves.toMatchObject({ success: false, error: "input_already_reconciled" });

    const audit = await listAuditEntries(kv as never);
    expect(
      audit.filter((e) => e.operation === "input_reconcile"),
    ).toHaveLength(1);
  });

  it("refuses a stale revision", async () => {
    const intent = await ambiguous();
    await expect(
      sdk.trigger(
        "mem::input-reconcile",
        proofFor(intent, { expectedRevision: intent.revision - 1 }),
      ),
    ).resolves.toMatchObject({ success: false, error: "input_revision_conflict" });
  });

  it("refuses a wrong target or a wrong payload hash", async () => {
    const intent = await ambiguous();
    await expect(
      sdk.trigger(
        "mem::input-reconcile",
        proofFor(intent, { targetSession: "shared-auto-launch-interactive-claude-other" }),
      ),
    ).resolves.toMatchObject({ success: false, error: "input_target_mismatch" });
    await expect(
      sdk.trigger(
        "mem::input-reconcile",
        proofFor(intent, { payloadSha256: "e".repeat(64) }),
      ),
    ).resolves.toMatchObject({ success: false, error: "input_payload_mismatch" });
  });

  it("refuses a delivery boundary that is not the one this receipt recorded", async () => {
    const intent = await ambiguous();
    await expect(
      sdk.trigger(
        "mem::input-reconcile",
        proofFor(intent, { deliveryStartedAt: "2026-11-20T04:00:00.000Z" }),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: "input_delivery_boundary_mismatch",
    });
  });

  for (const [name, evidence] of [
    ["missing", undefined],
    ["a bare assertion", true],
    ["an empty object", {}],
    ["the wrong source", { source: "pane_text", observedAt: BASE_TIME.toISOString(), messageSha256: PAYLOAD_SHA, transcriptCursor: `${PROVIDER}:x:1` }],
    ["a mismatched message hash", { source: "provider_transcript", observedAt: BASE_TIME.toISOString(), messageSha256: "f".repeat(64), transcriptCursor: `${PROVIDER}:x:1` }],
    ["no cursor at all", { source: "provider_transcript", observedAt: BASE_TIME.toISOString(), messageSha256: PAYLOAD_SHA }],
    ["a cursor from another provider session", { source: "provider_transcript", observedAt: BASE_TIME.toISOString(), messageSha256: PAYLOAD_SHA, transcriptCursor: "someone-else:x:1" }],
    ["an observation before the delivery boundary", { source: "provider_transcript", observedAt: "2026-11-20T05:00:00.000Z", messageSha256: PAYLOAD_SHA, transcriptCursor: `${PROVIDER}:x:1` }],
    ["a malformed timestamp", { source: "provider_transcript", observedAt: "not-a-time", messageSha256: PAYLOAD_SHA, transcriptCursor: `${PROVIDER}:x:1` }],
  ] as const) {
    it(`refuses ${name} as proof`, async () => {
      const intent = await ambiguous();
      await expect(
        sdk.trigger("mem::input-reconcile", proofFor(intent, { evidence })),
      ).resolves.toMatchObject({
        success: false,
        error: "reconciliation_requires_unique_post_boundary_proof",
      });
      const stored = (await kv.get(KV.inputIntents, intent.id)) as InputIntent;
      expect(stored.status).toBe("ambiguous");
      expect(stored.revision).toBe(intent.revision);
    });
  }

  it("refuses an actor, hash or boolean standing in for the required fields", async () => {
    const intent = await ambiguous();
    for (const payload of [
      { intentId: intent.id, actor: "root", reconciled: true },
      { intentId: intent.id, operationId: "x", expectedRevision: intent.revision },
      { ...proofFor(intent), providerIncarnation: "not-a-digest" },
      { ...proofFor(intent), providerSessionId: "" },
      { ...proofFor(intent), expectedRevision: "3" },
      { ...proofFor(intent), operationId: "" },
    ]) {
      await expect(
        sdk.trigger("mem::input-reconcile", payload),
      ).resolves.toMatchObject({ success: false, error: "invalid_reconciliation" });
    }
  });

  it("refuses a record that is not ambiguous, including an active claim", async () => {
    const enqueued = (await sdk.trigger("mem::input-enqueue", {
      idempotencyKey: "queued-only",
      targetSession: TARGET,
      payloadRef: "payload.queued",
      payloadSha256: PAYLOAD_SHA,
      payloadBytes: 10,
    })) as { intent: InputIntent };
    await expect(
      sdk.trigger("mem::input-reconcile", proofFor(enqueued.intent, {
        deliveryStartedAt: BASE_TIME.toISOString(),
      })),
    ).resolves.toMatchObject({ success: false, error: "intent_not_ambiguous" });

    const claimed = (await sdk.trigger("mem::input-claim", {
      workerId: WORKER,
      targetSession: TARGET,
    })) as { claimToken: string; intent: InputIntent };
    await expect(
      sdk.trigger("mem::input-reconcile", proofFor(claimed.intent, {
        deliveryStartedAt: BASE_TIME.toISOString(),
      })),
    ).resolves.toMatchObject({ success: false, error: "intent_not_ambiguous" });

    // An ambiguous row that somehow carries a live claim is refused on the claim,
    // so reconciliation can never race an in-flight delivery.
    const intent = await ambiguous();
    const withClaim = {
      ...intent,
      claimedBy: WORKER,
      claimToken: "ict_live",
      claimExpiresAt: new Date(BASE_TIME.getTime() + 60_000).toISOString(),
    };
    await kv.set(KV.inputIntents, intent.id, withClaim);
    await expect(
      sdk.trigger("mem::input-reconcile", proofFor(intent)),
    ).resolves.toMatchObject({ success: false, error: "input_claim_active" });
  });

  it("refuses an unknown intent", async () => {
    await expect(
      sdk.trigger("mem::input-reconcile", {
        intentId: "inp_missing",
        operationId: "recon-x",
        expectedRevision: 1,
        targetSession: TARGET,
        payloadSha256: PAYLOAD_SHA,
        deliveryStartedAt: BASE_TIME.toISOString(),
        providerSessionId: PROVIDER,
        providerIncarnation: INCARNATION,
        evidence: {
          source: "provider_transcript",
          observedAt: BASE_TIME.toISOString(),
          messageSha256: PAYLOAD_SHA,
          transcriptCursor: `${PROVIDER}:x:1`,
        },
      }),
    ).resolves.toMatchObject({ success: false, error: "intent_not_found" });
  });

  it("settles exactly one of two concurrent reconciliations", async () => {
    const intent = await ambiguous();
    const priorRevision = intent.revision;
    const results = (await Promise.all([
      sdk.trigger("mem::input-reconcile", proofFor(intent, { operationId: "recon-a" })),
      sdk.trigger("mem::input-reconcile", proofFor(intent, { operationId: "recon-b" })),
    ])) as { success: boolean; error?: string }[];
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => !r.success)).toHaveLength(1);
    const stored = (await kv.get(KV.inputIntents, intent.id)) as InputIntent;
    expect(stored.status).toBe("reconciled");
    expect(stored.revision).toBe(priorRevision + 1);
    const audit = await listAuditEntries(kv as never);
    expect(audit.filter((e) => e.operation === "input_reconcile")).toHaveLength(1);
  });

  it("still refuses an unsafe retry after reconciliation, and lists the new status", async () => {
    const intent = await ambiguous();
    await sdk.trigger("mem::input-reconcile", proofFor(intent));
    await expect(
      sdk.trigger("mem::input-settle", {
        intentId: intent.id,
        workerId: WORKER,
        claimToken: "ict_whatever",
        outcome: "retry",
      }),
    ).resolves.toMatchObject({ success: false, error: "claim_mismatch" });

    const listed = (await sdk.trigger("mem::input-list", {
      intentId: intent.id,
      statuses: ["reconciled"],
    })) as { success: boolean; intents: InputIntent[] };
    expect(listed.success).toBe(true);
    expect(listed.intents).toHaveLength(1);
    expect(listed.intents[0]?.status).toBe("reconciled");
  });

  it("survives a restart: the reconciled row and its provenance are read back", async () => {
    const intent = await ambiguous();
    await sdk.trigger("mem::input-reconcile", proofFor(intent));
    const reread = (await kv.get(KV.inputIntents, intent.id)) as InputIntent;
    expect(reread.status).toBe("reconciled");
    expect(reread.reconciliation?.operationId).toBe("recon-1635-001");
    expect(reread.reconciliation?.priorStatus).toBe("ambiguous");
    expect(reread.reconciliation?.transcriptCursor).toContain(PROVIDER);
    expect(reread.evidence?.messageSha256).toBe(PAYLOAD_SHA);
  });
});
