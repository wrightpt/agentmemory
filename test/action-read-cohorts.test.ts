import { describe, expect, it, vi } from "vitest";
import {
  persistAction, readActionStoreSnapshot, withActionStoreLock,
} from "../src/functions/action-store.js";
import { registerActionsFunction } from "../src/functions/actions.js";
import {
  actionEventPartitionScope, actionEventImportPartitionScope, actionEventBucket,
  listActionEventsForAction, listActionEventsForActions,
} from "../src/state/partitioned-ledgers.js";
import { KV } from "../src/state/schema.js";
import type { Action, ActionEvent } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const at = "2026-11-20T00:00:00.000Z";
function action(id: string): Action {
  return { id, title: id, status: "pending", project: "agentmemory", priority: 5,
    createdAt: at, updatedAt: at, tags: [] };
}
function event(id: string, actionId: string, revision: number, extra: Partial<ActionEvent> = {}): ActionEvent {
  return { schemaVersion: 2, id, actionId, entityType: "action", revision,
    type: "fields_changed", actor: "test", timestamp: at, ...extra };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function heldLock() {
  const entered = deferred(), release = deferred();
  const done = withActionStoreLock(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  return { release: release.resolve, done };
}
function countReads(kv: ReturnType<typeof mockKV>) {
  const reads = new Map<string, number>();
  const list = kv.list;
  kv.list = async <T>(scope: string) => {
    reads.set(scope, (reads.get(scope) ?? 0) + 1);
    return list<T>(scope);
  };
  return reads;
}

describe("native action read cohorts", () => {
  it("64 installed scalar calls share one coherent action/edge/legacy scan, preserve native response semantics", async () => {
    const kv = mockKV(), sdk = mockSdk();
    const ids = ["a", "b", "c", "d"];
    for (const id of ids) {
      await kv.set(KV.actions, id, action(id));
      await kv.set(KV.actionEvents, `${id}-legacy`, event(`${id}-legacy`, id, 1));
      await kv.set(actionEventPartitionScope(at, id), `${id}-new`, event(`${id}-new`, id, 2));
    }
    await kv.set(KV.actions, "closed", { ...action("closed"), lifecycle: "done", status: "done" });
    await kv.set(KV.actionState, "current", { schemaVersion: 2, revision: 2, updatedAt: at });
    registerActionsFunction(sdk as never, kv as never);
    const reads = countReads(kv);
    const held = await heldLock();
    const pending = Array.from({ length: 64 }, (_, index) =>
      sdk.trigger("mem::action-get", { actionId: ids[index % ids.length] }));
    held.release(); await held.done;
    const results = await Promise.all(pending) as Array<{ action: Action; events: ActionEvent[]; revision: number; workAuthority: unknown }>;
    expect(reads.get(KV.actions)).toBe(1);
    expect(reads.get(KV.actionEdges)).toBe(1);
    expect(reads.get(KV.actionEvents)).toBe(1);
    for (const result of results) {
      expect(result.events.map(e => e.id)).toEqual([`${result.action.id}-legacy`, `${result.action.id}-new`]);
      expect(result.events.every(e => e.actionId === result.action.id)).toBe(true);
      expect(result.revision).toBe(2);
      expect(result.workAuthority).toBeNull();
    }
    expect((await readActionStoreSnapshot(kv as never)).actions.some(a => a.status === "done")).toBe(true);
  });

  it("preserves all legacy, monthly, imported and correction history, including late legacy rollback writes", async () => {
    const kv = mockKV();
    const old = event("old", "a", 1, { type: "created" });
    const correction = event("corrected", "a", 3, { type: "corrected", correctionOf: "old" });
    const imported = event("imported", "b", 2, { timestamp: "+010000-01-01T00:00:00.000Z" });
    await kv.set(KV.actionEvents, old.id, old);
    await kv.set(actionEventPartitionScope(at, "a"), old.id, old); // migrated duplicate
    await kv.set(actionEventPartitionScope(at, "a"), correction.id, correction);
    await kv.set(actionEventImportPartitionScope("b"), imported.id, imported);
    await kv.set(KV.actionEvents, "foreign", event("foreign", "other", 4));
    const expected = [...await listActionEventsForAction(kv as never, "a"), ...await listActionEventsForAction(kv as never, "b")]
      .sort((a, b) => a.revision - b.revision);
    expect(await listActionEventsForActions(kv as never, ["a", "b", "a"])).toEqual(expected);
    await kv.set(KV.actionEvents, "late", event("late", "a", 5));
    expect((await listActionEventsForActions(kv as never, ["a", "b"])).map(e => e.id))
      .toEqual(["old", "imported", "corrected", "late"]);
    expect(await listActionEventsForActions(kv as never, [])).toEqual([]);
    await expect(listActionEventsForActions(kv as never, Array(65).fill("a"))).rejects.toThrow("64 IDs");
  });

  it("keeps per-caller no-history/scalar/full-history modes and mutable results isolated", async () => {
    const kv = mockKV();
    await kv.set(KV.actions, "a", action("a"));
    await kv.set(KV.actionEvents, "ea", event("ea", "a", 1));
    await kv.set(KV.actionEvents, "eb", event("eb", "b", 2));
    const held = await heldLock();
    const pending = [readActionStoreSnapshot(kv as never),
      readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: "a" }),
      readActionStoreSnapshot(kv as never, { includeEvents: true })];
    held.release(); await held.done;
    const [plain, scalar, full] = await Promise.all(pending);
    expect(plain.events).toEqual([]);
    expect(scalar.events.map(e => e.id)).toEqual(["ea"]);
    expect(full.events.map(e => e.id)).toEqual(["ea", "eb"]);
    scalar.actions[0].title = "mutated by caller";
    expect(plain.actions[0].title).toBe("a");
    expect(full.actions[0].title).toBe("a");
    expect((await kv.get<Action>(KV.actions, "a"))?.title).toBe("a");
  });

  it("bounds a cohort's caller and unique-ID populations without dropping or truncating any result", async () => {
    for (const [count, distinct] of [[257, false], [65, true]] as const) {
      const kv = mockKV(), reads = countReads(kv), held = await heldLock();
      const pending = Array.from({ length: count }, (_, i) => readActionStoreSnapshot(kv as never,
        { includeEvents: true, eventActionId: distinct ? `a-${i}` : "a" }));
      held.release(); await held.done;
      expect(await Promise.all(pending)).toHaveLength(count);
      expect(reads.get(KV.actions)).toBe(2);
      expect(reads.get(KV.actionEdges)).toBe(2);
      expect(reads.get(KV.actionEvents)).toBe(2);
    }
  });

  it("does not let later readers extend an active scan or jump ahead of a queued native writer", async () => {
    const kv = mockKV();
    const initial = (await persistAction(kv as never, action("a"))).action;
    const entered = deferred(), resume = deferred();
    const list = kv.list;
    let first = true;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.actions && first) { first = false; entered.resolve(); await resume.promise; }
      return list<T>(scope);
    };
    const oldRead = readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: "a" });
    await entered.promise;
    let written = false;
    const write = persistAction(kv as never, { ...initial, title: "new" }, { before: initial }).then(value => { written = true; return value; });
    const waiting = Array.from({ length: 100 }, () => readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: "a" }));
    expect(written).toBe(false);
    resume.resolve();
    const old = await oldRead;
    const committed = await write;
    const fresh = await Promise.all(waiting);
    expect(old.actions[0].title).toBe("a");
    expect(old.state.revision).toBe(1);
    expect(written).toBe(true);
    expect(fresh.every(row => row.state.revision === committed.state.revision && row.actions[0].title === "new")).toBe(true);
    expect(fresh.every(row => row.events.at(-1)?.revision === committed.state.revision)).toBe(true);
  });

  it("recovers pending native journal projection under the existing lock before exposing a cohort", async () => {
    const kv = mockKV();
    const pending = event("pending", "a", 9, { after: { ...action("a"), title: "recovered" } });
    await kv.set(KV.actionEvents, pending.id, pending);
    await kv.set(KV.actionState, "current", { schemaVersion: 2, revision: 8, updatedAt: at,
      pending: { eventId: pending.id, revision: 9, eventScope: KV.actionEvents } });
    const held = await heldLock();
    const calls = Array.from({ length: 32 }, () => readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: "a" }));
    held.release(); await held.done;
    const results = await Promise.all(calls);
    expect(results.every(row => row.state.revision === 9 && !row.state.pending && row.actions[0].title === "recovered")).toBe(true);
    expect(results.every(row => row.events[0].id === "pending")).toBe(true);
  });

  it("does not cache failures or completed snapshots, including changes made at the same revision", async () => {
    const kv = mockKV(), held = await heldLock();
    const list = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => { if (scope === KV.actionEvents) throw new Error("legacy unavailable"); return list<T>(scope); };
    const calls = Array.from({ length: 10 }, () => readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: "a" }));
    const settled = Promise.allSettled(calls);
    held.release(); await held.done;
    expect((await settled).every(row => row.status === "rejected")).toBe(true);
    kv.list = list;
    expect((await readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: "a" })).events).toEqual([]);
    await kv.set(KV.actionEvents, "late", event("late", "a", 1));
    expect((await readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: "a" })).events.map(e => e.id)).toEqual(["late"]);
  });

  it("never shares cohorts between native StateKV instances", async () => {
    const left = mockKV(), right = mockKV(), held = await heldLock();
    await left.set(KV.actions, "a", action("a"));
    await right.set(KV.actions, "b", action("b"));
    const l = readActionStoreSnapshot(left as never), r = readActionStoreSnapshot(right as never);
    held.release(); await held.done;
    expect((await l).actions.map(a => a.id)).toEqual(["a"]);
    expect((await r).actions.map(a => a.id)).toEqual(["b"]);
  });

  it("preserves solo history for cross-action duplicate IDs regardless of scalar or full-history cohort peers (F1)", async () => {
    const kv = mockKV();
    const x = "act_x", y = "act_y";
    expect(actionEventBucket(x)).not.toBe(actionEventBucket(y));
    const legacy = event("dup", y, 1), partition = event("dup", x, 2);
    await kv.set(KV.actionEvents, legacy.id, legacy);
    await kv.set(actionEventPartitionScope(at, x), partition.id, partition);
    const solo = await readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: y });
    expect(solo.events).toEqual([legacy]);
    const reads = countReads(kv), held = await heldLock();
    const calls = [
      readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: y }),
      readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: x }),
      readActionStoreSnapshot(kv as never, { includeEvents: true }),
    ];
    held.release(); await held.done;
    const [ys, xs, full] = await Promise.all(calls);
    expect(ys.events).toEqual(solo.events);
    expect(xs.events).toEqual([partition]);
    expect(full.events).toEqual([partition]); // full-history's original global precedence
    expect(Object.keys(ys).sort()).toEqual(["actions", "edges", "events", "state"]);
    expect(reads.get(KV.actionEvents)).toBe(1);
    expect(reads.get(actionEventPartitionScope(at, x))).toBe(1);
  });

  it("an older capped cohort cannot erase a newer waiting cohort's sharing identity (F2)", async () => {
    const kv = mockKV(), reads = countReads(kv), held = await heldLock();
    const entered = deferred(), resume = deferred(), list = kv.list;
    let first = true;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.actions && first) { first = false; entered.resolve(); await resume.promise; }
      return list<T>(scope);
    };
    const calls = Array.from({ length: 65 }, (_, i) => readActionStoreSnapshot(kv as never,
      { includeEvents: true, eventActionId: `a-${i}` }));
    held.release(); await entered.promise;
    const late = readActionStoreSnapshot(kv as never, { includeEvents: true, eventActionId: "a-64" });
    resume.resolve(); await held.done;
    await Promise.all([...calls, late]);
    expect(reads.get(KV.actions)).toBe(2);
    expect(reads.get(KV.actionEvents)).toBe(2);
  });
});
