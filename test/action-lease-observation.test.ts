import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerActionsFunction } from "../src/functions/actions.js";
import { registerLeasesFunction } from "../src/functions/leases.js";
import { registerDiagnosticsFunction } from "../src/functions/diagnostics.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { observeActionLease, projectActionLease } from "../src/functions/action-lease-observation.js";
import { persistAction } from "../src/functions/action-store.js";
import { leaseRetentionReason } from "../src/functions/stale-cleanup-policy.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import { KV } from "../src/state/schema.js";
import type { Action, ActionLeaseObservation, Lease } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const start = Date.parse("2026-11-21T01:00:00.000Z");
const iso = (delta = 0) => new Date(start + delta).toISOString();
const project = "lease-tests";
function action(): Action {
  return { id: "act_target", title: "Target", project, projectId: project, status: "pending",
    priority: 5, tags: [], createdAt: iso(), updatedAt: iso() };
}
function legacy(extra: Partial<Lease> = {}): Lease {
  return { id: "lse_legacy", actionId: "act_target", agentId: "wsh:worker", acquiredAt: iso(-1000),
    expiresAt: iso(1000), status: "active", ...extra };
}
type Get = { success: boolean; error?: string; action: Action; leaseObservation: ActionLeaseObservation; revision: number; events?: unknown[]; readMode?: string };

describe("action-lease-observation/v1", () => {
  let kv: ReturnType<typeof mockKV>, sdk: ReturnType<typeof mockSdk>;
  const get = (extra: Record<string, unknown> = {}) => sdk.trigger("mem::action-get", {
    actionId: "act_target", projectId: project, includeLeaseObservation: true, ...extra,
  }) as Promise<Get>;
  const acquire = (agentId = "wsh:worker", ttlMs = 1000) => sdk.trigger("mem::lease-acquire", { actionId: "act_target", agentId, ttlMs }) as Promise<{ success: boolean; lease: Lease }>;
  beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    kv = mockKV(); sdk = mockSdk();
    registerActionsFunction(sdk as never, kv as never);
    registerLeasesFunction(sdk as never, kv as never);
    registerDiagnosticsFunction(sdk as never, kv as never);
    await kv.set(KV.actions, "act_target", action());
  });
  afterEach(() => vi.useRealTimers());

  it("is optional; full history shape remains unchanged unless explicitly requested", async () => {
    const old = await sdk.trigger("mem::action-get", { actionId: "act_target" }) as Get;
    expect(old.success).toBe(true); expect(old).not.toHaveProperty("leaseObservation");
    const seen = await get();
    expect(seen.success).toBe(true); expect(seen.events).toEqual([]);
    expect(seen.leaseObservation).toMatchObject({ protocol: "action-lease-observation/v1", actionId: "act_target", projectId: project,
      state: "none", lease: null, observedAt: iso(), watermark: { sequence: 0 } });
  });

  it("leaseOnly uses exact action + native lease ledger and never action/edge/event scans or lease writes", async () => {
    await acquire();
    const lists: string[] = [], writes: string[] = [];
    const list = kv.list, set = kv.set;
    kv.list = async <T>(scope: string) => { lists.push(scope); return list<T>(scope); };
    kv.set = async <T>(scope: string, key: string, value: T) => { writes.push(scope); return set(scope, key, value); };
    const seen = await get({ leaseOnly: true });
    expect(seen.success).toBe(true); expect(seen.readMode).toBe("lease-only");
    expect(seen).not.toHaveProperty("events"); expect(seen).not.toHaveProperty("edges");
    expect(lists).toEqual([KV.leases]); expect(writes).toEqual([]);
    expect(seen.leaseObservation).toMatchObject({ state: "active", watermark: { sequence: 2 }, lease: { agentId: "wsh:worker" } });
  });

  it("cheap observation refuses pending native journal recovery without any writes or history reads", async () => {
    await kv.set(KV.actionState, "current", { schemaVersion: 2, revision: 3,
      pending: { revision: 4, eventId: "unsettled" } });
    const set = vi.spyOn(kv, "set"), list = vi.spyOn(kv, "list");
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_action_pending" });
    expect(set).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
  });

  it("renewal changes durable lease order without changing action revision; time alone does not change active watermark", async () => {
    const acquired = await acquire();
    const first = await get({ leaseOnly: true });
    vi.setSystemTime(start + 100);
    const later = await get({ leaseOnly: true });
    expect(later.leaseObservation.watermark).toEqual(first.leaseObservation.watermark);
    expect(later.leaseObservation.observedAt).not.toBe(first.leaseObservation.observedAt);
    const renewed = await sdk.trigger("mem::lease-renew", { actionId: "act_target", agentId: "wsh:worker", ttlMs: 1000 }) as { lease: Lease };
    const next = await get({ leaseOnly: true });
    expect(next.action.revision).toBe(first.action.revision);
    expect(renewed.lease.id).toBe(acquired.lease.id);
    expect(next.leaseObservation.watermark.sequence).toBe(4);
    expect(next.leaseObservation.watermark.digest).not.toBe(first.leaseObservation.watermark.digest);
    expect(next.leaseObservation.lease?.renewedAt).toBe(iso(100));
    const again = await acquire(); // existing same-owner acquisition remains idempotent
    expect(again.lease.observationVersion).toBe(2);
  });

  it("expiry advances before cleanup with unchanged action revision, then cleanup and reacquisition advance again", async () => {
    await acquire(); const initial = await get({ leaseOnly: true });
    vi.setSystemTime(start + 1000);
    const expired = await get({ leaseOnly: true });
    expect(expired.action.revision).toBe(initial.action.revision);
    expect(expired.leaseObservation).toMatchObject({ state: "none", lease: null, watermark: { sequence: 3 } });
    await sdk.trigger("mem::lease-cleanup", {});
    const cleaned = await get({ leaseOnly: true });
    expect(cleaned.leaseObservation.watermark.sequence).toBe(4);
    expect(cleaned.leaseObservation.state).toBe("none");
    await acquire("wsh:successor");
    const successor = await get({ leaseOnly: true });
    expect(successor.leaseObservation.watermark.sequence).toBe(6);
    expect(successor.leaseObservation.lease?.agentId).toBe("wsh:successor");
  });

  it("release and heal expiration also carry the native monotone version", async () => {
    await acquire();
    await sdk.trigger("mem::lease-release", { actionId: "act_target", agentId: "wsh:worker" });
    expect((await get({ leaseOnly: true })).leaseObservation.watermark.sequence).toBe(4);
    await acquire(); vi.setSystemTime(start + 2000);
    await sdk.trigger("mem::heal", { categories: ["leases"], dryRun: false });
    const result = await get({ leaseOnly: true });
    expect(result.success).toBe(true); expect(result.leaseObservation.state).toBe("none");
    expect(result.leaseObservation.watermark.sequence).toBe(8);
  });

  it("supports valid legacy rows without writes, stamps next native renewal, and detects older-binary changes", async () => {
    await kv.set(KV.actions, "act_target", { ...action(), status: "active", lifecycle: "active", assignedTo: "wsh:worker" });
    await kv.set(KV.leases, "lse_legacy", legacy());
    expect((await get({ leaseOnly: true })).leaseObservation.watermark.sequence).toBe(0);
    expect(await kv.get(KV.leases, "lse_legacy")).not.toHaveProperty("observationVersion");
    await sdk.trigger("mem::lease-renew", { actionId: "act_target", agentId: "wsh:worker", ttlMs: 1000 });
    expect((await get({ leaseOnly: true })).leaseObservation.watermark.sequence).toBe(2);
    const row = await kv.get<Lease>(KV.leases, "lse_legacy");
    await kv.set(KV.leases, "lse_legacy", { ...row, expiresAt: iso(5000) }); // old binary preserves additive metadata but does not update it
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_unversioned_change" });
    expect(await sdk.trigger("mem::action-get", { actionId: "act_target" })).not.toHaveProperty("leaseObservation");
  });

  it("detects legacy-only inserts or edits made by a rolled-back binary after versioned mutations", async () => {
    await acquire();
    await sdk.trigger("mem::lease-release", { actionId: "act_target", agentId: "wsh:worker" });
    await kv.set(KV.leases, "lse_old_binary", legacy({ id: "lse_old_binary" }));
    await kv.set(KV.actions, "act_target", { ...action(), status: "active", lifecycle: "active", assignedTo: "wsh:worker" });
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_unversioned_change" });
    await sdk.trigger("mem::lease-renew", { actionId: "act_target", agentId: "wsh:worker", ttlMs: 1000 });
    const next = await get({ leaseOnly: true });
    expect(next.success).toBe(true); expect(next.leaseObservation.watermark.sequence).toBe(6);
  });

  it("keeps the durable version floor after restart and retains terminal rows while an action exists", async () => {
    await acquire();
    await sdk.trigger("mem::lease-release", { actionId: "act_target", agentId: "wsh:worker" });
    const before = await get({ leaseOnly: true });
    const rows = await kv.list<Lease>(KV.leases);
    expect(leaseRetentionReason(rows[0], action(), start + 100000)).toBe("action-exists");
    sdk = mockSdk(); registerActionsFunction(sdk as never, kv as never); registerLeasesFunction(sdk as never, kv as never);
    expect((await get({ leaseOnly: true })).leaseObservation.watermark).toEqual(before.leaseObservation.watermark);
    await acquire(); expect((await get({ leaseOnly: true })).leaseObservation.watermark.sequence).toBe(6);
  });

  it("legacy expiry, successor acquisition and late cleanup of old rows keep order and the current holder", async () => {
    await kv.set(KV.actions, "act_target", { ...action(), status: "active", lifecycle: "active", assignedTo: "wsh:worker" });
    await kv.set(KV.leases, "lse_legacy", legacy());
    vi.setSystemTime(start + 1000);
    expect((await get({ leaseOnly: true })).leaseObservation.watermark.sequence).toBe(1);
    await acquire("wsh:worker"); // same durable holder, but a new lease after expiry
    expect((await get({ leaseOnly: true })).leaseObservation.watermark.sequence).toBe(2);
    await sdk.trigger("mem::lease-cleanup", {});
    const final = await get({ leaseOnly: true });
    expect(final.leaseObservation.state).toBe("active");
    expect(final.leaseObservation.watermark.sequence).toBe(4);
    expect(final.action.assignedTo).toBe("wsh:worker");
  });

  it("refuses conflicting holders, inconsistent action state and malformed/missing observations rather than none", async () => {
    await kv.set(KV.actions, "act_target", { ...action(), status: "active", lifecycle: "active", assignedTo: "wsh:worker" });
    await kv.set(KV.leases, "lse_legacy", legacy());
    await kv.set(KV.leases, "lse_other", legacy({ id: "lse_other", agentId: "wsh:other" }));
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_conflict" });
    await kv.delete(KV.leases, "lse_other");
    await kv.set(KV.actions, "act_target", { ...action(), status: "active", assignedTo: "wsh:other" });
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_holder_conflict" });
    await kv.set(KV.leases, "bad", { id: "bad" });
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_unscoped_row" });
    kv.list = async () => { throw Error("native read failed"); };
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_unavailable" });
  });

  it("requires the same explicit scope/opt-in and refuses migrated or frozen authority without fallback", async () => {
    expect(await get({ projectId: undefined })).toMatchObject({ success: false, error: "lease_observation_scope_required" });
    expect(await get({ projectId: "other", leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_scope_mismatch" });
    expect(await get({ includeLeaseObservation: false, leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_scope_required" });
    // A malformed or committed non-null authority is never explicit unmigrated null.
    await kv.set(KV.workAuthority, project, { projectId: project, phase: "frozen" });
    const result = await get({ leaseOnly: true });
    expect(result.success).toBe(false); expect(result).not.toHaveProperty("leaseObservation");
  });

  it("refuses an action change between full history and the lease cut", async () => {
    await acquire();
    const old = (await kv.get<Action>(KV.actions, "act_target"))!;
    const list = kv.list; let write: Promise<unknown> | undefined;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.actionEvents && !write) write = persistAction(kv as never, { ...old, title: "concurrently changed" }, { before: old });
      return list<T>(scope);
    };
    const result = await get(); await write;
    expect(result).toMatchObject({ success: false, error: "lease_observation_action_changed" });
  });

  it("serializes final observation with existing renew lock and keeps read/write lock order live", async () => {
    await acquire();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(yes => { release = yes; }), inside = new Promise<void>(yes => { entered = yes; });
    const held = withKeyedLock("mem:action:act_target", async () => { entered(); await gate; });
    await inside;
    const renew = sdk.trigger("mem::lease-renew", { actionId: "act_target", agentId: "wsh:worker", ttlMs: 1000 });
    const observed = get({ leaseOnly: true });
    release(); await held; await renew;
    expect((await observed).leaseObservation.watermark.sequence).toBe(4);
  });

  it("acquire compensation never exposes its transient lease or advances an observed version floor", async () => {
    await acquire();
    await sdk.trigger("mem::lease-release", { actionId: "act_target", agentId: "wsh:worker" });
    const before = (await get({ leaseOnly: true })).leaseObservation;
    const set = kv.set;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(yes => { release = yes; }), inside = new Promise<void>(yes => { entered = yes; });
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (scope === KV.actionState && value && typeof value === "object" && "pending" in value) {
        entered(); await gate; throw Error("native journal write failed");
      }
      return set(scope, key, value);
    };
    const failed = acquire("wsh:successor").catch(error => error);
    await inside;
    let observed = false;
    const read = get({ leaseOnly: true }).then(value => { observed = true; return value; });
    await Promise.resolve(); expect(observed).toBe(false);
    release(); expect(await failed).toBeInstanceOf(Error);
    const after = (await read).leaseObservation;
    expect(after.state).toBe("none"); expect(after.watermark).toEqual(before.watermark);
    expect(await kv.list(KV.leases)).toHaveLength(1);
  });

  it("clock/restore regressions cannot pretend to be new monotone evidence", async () => {
    await acquire(); const active = (await get({ leaseOnly: true })).leaseObservation;
    vi.setSystemTime(start + 1000); const expired = (await get({ leaseOnly: true })).leaseObservation;
    expect(expired.watermark.sequence).toBeGreaterThan(active.watermark.sequence);
    vi.setSystemTime(start + 500); const regressed = (await get({ leaseOnly: true })).leaseObservation;
    // Consumers compare cuts and must reject this source-order regression.
    expect(regressed.watermark.sequence).toBeLessThan(expired.watermark.sequence);
    vi.setSystemTime(start - 1);
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_clock_invalid" });
  });

  it("native errors and malformed target rows remain errors even for expired or released data", async () => {
    for (const patch of [{ acquiredAt: "bad" }, { expiresAt: iso(-2000) }, { observationVersion: -1 },
      { observationVersion: 1 }, { observationDigest: "bad" }]) {
      expect(() => projectActionLease(action(), [legacy({ status: "released", ...patch })], project, start)).toThrow();
    }
    await expect(observeActionLease(kv as never, project, "missing")).rejects.toThrow("lease_observation_action_missing");
  });

  it("REST forwards strict opt-in and cheap mode without changing legacy payload shape", async () => {
    registerApiTriggers(sdk as never, kv as never);
    const old = await sdk.trigger("api::action-get", { headers: {}, query_params: { actionId: "act_target" } }) as { body: Get };
    expect(old.body).not.toHaveProperty("leaseObservation");
    const result = await sdk.trigger("api::action-get", { headers: {}, query_params: {
      actionId: "act_target", projectId: project, includeLeaseObservation: "true", leaseOnly: "true",
    } }) as { status_code: number; body: Get };
    expect(result.body.readMode).toBe("lease-only"); expect(result.body.leaseObservation.state).toBe("none");
    for (const query of [{ includeLeaseObservation: "yes" }, { leaseOnly: "true" },
      { includeLeaseObservation: "true" }, { includeLeaseObservation: "true", projectId: project, leaseOnly: "yes" }]) {
      const response = await sdk.trigger("api::action-get", { headers: {}, query_params: { actionId: "act_target", ...query } }) as { status_code: number };
      expect(response.status_code).toBe(400);
    }
  });
});
