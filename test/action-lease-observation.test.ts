import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerActionsFunction } from "../src/functions/actions.js";
import { registerLeasesFunction } from "../src/functions/leases.js";
import { registerDiagnosticsFunction } from "../src/functions/diagnostics.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { observeActionLease, projectActionLease, rebuildLeaseIndex } from "../src/functions/action-lease-observation.js";
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
    await rebuildLeaseIndex(kv); // the boot rebuild started by registration
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
    expect(lists).toEqual([]); expect(writes).toEqual([]);
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
    await rebuildLeaseIndex(kv); // a restart indexes rows that predate this binary
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
    await rebuildLeaseIndex(kv); // the rolled-back binary's insert is seen after this binary restarts
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
    await rebuildLeaseIndex(kv);
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
    await rebuildLeaseIndex(kv);
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_conflict" });
    await kv.delete(KV.leases, "lse_other");
    await kv.set(KV.actions, "act_target", { ...action(), status: "active", assignedTo: "wsh:other" });
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_holder_conflict" });
    await kv.set(KV.leases, "bad", { id: "bad" });
    await rebuildLeaseIndex(kv);
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_unscoped_row" });
    await kv.delete(KV.leases, "bad"); await rebuildLeaseIndex(kv);
    const getRow = kv.get;
    kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      if (scope === KV.leases) throw Error("native read failed");
      return getRow<T>(scope, key);
    };
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_unavailable" });
    kv.get = getRow;
    kv.list = async () => { throw Error("native read failed"); };
    await expect(rebuildLeaseIndex(kv)).rejects.toThrow("native read failed");
    expect(await get({ leaseOnly: true })).toMatchObject({ success: false, error: "lease_observation_index_unavailable" });
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

  it("reads one action's indexed rows: unrelated retained leases add no storage work and no collection list", async () => {
    await acquire();
    const measure = async () => {
      const calls: string[] = [];
      const list = kv.list, getRow = kv.get;
      kv.list = async <T>(scope: string) => { calls.push(`list:${scope}`); return list<T>(scope); };
      kv.get = async <T>(scope: string, key: string) => { calls.push(`get:${scope}`); return getRow<T>(scope, key); };
      try { expect((await get({ leaseOnly: true })).success).toBe(true); } finally { kv.list = list; kv.get = getRow; }
      return calls;
    };
    const before = await measure();
    for (let i = 0; i < 2000; i++) {
      await kv.set(KV.leases, `lse_other_${i}`, legacy({ id: `lse_other_${i}`, actionId: `act_other_${i % 50}`, status: "released" }));
    }
    await rebuildLeaseIndex(kv);
    const after = await measure();
    expect(after).toEqual(before);
    expect(after.some(call => call.startsWith("list:"))).toBe(false);
  });

  it("an unrelated action read and mutation complete while an observation reads its lease rows", async () => {
    await acquire();
    const unrelated = { ...action(), id: "act_unrelated", title: "Unrelated" };
    await kv.set(KV.actions, "act_unrelated", unrelated);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(yes => { release = yes; }), inside = new Promise<void>(yes => { entered = yes; });
    const getRow = kv.get;
    kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
      if (scope === KV.leases) { entered(); await gate; }
      return getRow<T>(scope, key);
    };
    const observed = get({ leaseOnly: true });
    await inside;
    expect((await sdk.trigger("mem::action-get", { actionId: "act_unrelated" }) as Get).success).toBe(true);
    await persistAction(kv as never, { ...unrelated, title: "changed meanwhile" }, { before: unrelated });
    kv.get = getRow; release();
    const result = await observed;
    expect(result.success).toBe(true); expect(result.leaseObservation.state).toBe("active");
  });

  it("a restart rebuild indexes older rows, keeps rows written during it and drops deleted ones", async () => {
    await kv.set(KV.actions, "act_target", { ...action(), status: "active", lifecycle: "active", assignedTo: "wsh:worker" });
    await kv.set(KV.leases, "lse_legacy", legacy());
    await kv.set(KV.leaseIndex, "act_target", { actionId: "act_target", leaseIds: ["lse_deleted"] });
    await rebuildLeaseIndex(kv);
    expect(await kv.get(KV.leaseIndex, "act_target")).toEqual({ actionId: "act_target", leaseIds: ["lse_legacy"] });
    expect((await get({ leaseOnly: true })).leaseObservation).toMatchObject({ state: "active", watermark: { sequence: 0 } });
    await kv.set(KV.actions, "act_second", { ...action(), id: "act_second" });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(yes => { release = yes; }), inside = new Promise<void>(yes => { entered = yes; });
    const list = kv.list;
    kv.list = async <T>(scope: string) => {
      const rows = await list<T>(scope);
      if (scope === KV.leaseIndex) { entered(); await gate; }
      return rows;
    };
    const rebuilt = rebuildLeaseIndex(kv);
    await inside;
    const acquired = await sdk.trigger("mem::lease-acquire", { actionId: "act_second", agentId: "wsh:second", ttlMs: 1000 }) as { success: boolean; lease: Lease };
    expect(acquired.success).toBe(true);
    kv.list = list; release(); await rebuilt;
    expect(await kv.get(KV.leaseIndex, "act_second")).toEqual({ actionId: "act_second", leaseIds: [acquired.lease.id] });
  });

  it("a project-scoped full read returns only that project's children and edges; the unscoped read is unchanged", async () => {
    await kv.set(KV.actions, "act_child_own", { ...action(), id: "act_child_own", parentId: "act_target" });
    await kv.set(KV.actions, "act_child_foreign", { ...action(), id: "act_child_foreign", project: "other-project",
      projectId: "other-project", parentId: "act_target", description: "foreign detail" });
    await kv.set(KV.actionEdges, "edge_own", { id: "edge_own", type: "requires", sourceActionId: "act_target",
      targetActionId: "act_child_own", createdAt: iso() });
    await kv.set(KV.actionEdges, "edge_foreign", { id: "edge_foreign", type: "requires", sourceActionId: "act_target",
      targetActionId: "act_child_foreign", createdAt: iso() });
    type Full = Get & { children: Action[]; edges: Array<{ id: string }> };
    const unscoped = await sdk.trigger("mem::action-get", { actionId: "act_target" }) as Full;
    expect(unscoped.children.map(child => child.id).sort()).toEqual(["act_child_foreign", "act_child_own"]);
    expect(unscoped.edges.map(edge => edge.id).sort()).toEqual(["edge_foreign", "edge_own"]);
    const scoped = await get() as Full;
    expect(scoped.success).toBe(true);
    expect(scoped.children.map(child => child.id)).toEqual(["act_child_own"]);
    expect(scoped.edges.map(edge => edge.id)).toEqual(["edge_own"]);
    expect(JSON.stringify(scoped)).not.toContain("other-project");
    expect(JSON.stringify(scoped)).not.toContain("foreign detail");
  });

  it("observes opaque holder IDs accepted by native lease callers, before and after release", async () => {
    const holderId = "agent/review@example";
    expect((await acquire(holderId)).success).toBe(true);
    const held = await get({ leaseOnly: true });
    expect(held.success).toBe(true);
    expect(held.leaseObservation).toMatchObject({ state: "active", lease: { agentId: holderId } });
    await sdk.trigger("mem::lease-release", { actionId: "act_target", agentId: holderId });
    const released = await get({ leaseOnly: true });
    expect(released.success).toBe(true); expect(released.leaseObservation.state).toBe("none");
    for (const bad of ["", "x".repeat(513), "agent\u0007bell", "agent\u202eflip"]) {
      expect(() => projectActionLease(action(), [legacy({ agentId: bad, status: "released" })], project, start)).toThrow("lease_observation_row_invalid");
    }
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
