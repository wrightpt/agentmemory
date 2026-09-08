import { afterEach, describe, expect, it, vi } from "vitest";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { MAINTENANCE_REFERENCE_SCOPES } from "../src/state/maintenance-barrier.js";
import { registerStaleCleanupFunction } from "../src/functions/stale-cleanup.js";
import { fingerprint, MIN_IDLE_MS, STALE_DELETE_PROTOCOL } from "../src/functions/stale-cleanup-policy.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/functions/search.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/functions/search.js")>(),
  getSearchIndex: () => ({ remove: vi.fn() }),
  vectorIndexRemove: vi.fn(async () => {}), flushIndexSave: vi.fn(async () => {}),
}));

const old = "2026-01-01T00:00:00.000Z";
const memory = () => ({ id: "mem_one", type: "fact", content: "Fixture", isLatest: true, sessionIds: [], createdAt: old, updatedAt: old });
const lease = () => ({ id: "lse_one", actionId: "act_missing", agentId: "test", status: "released", acquiredAt: old, expiresAt: old });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

interface StateCall { function_id: string; payload: { scope: string; key?: string; value?: unknown; ops?: unknown[] } }
function fixture() {
  const sdk = mockSdk(), store = new Map<string, Map<string, unknown>>();
  store.set(KV.memories, new Map([["mem_one", memory()]]));
  store.set(KV.leases, new Map([["lse_one", lease()]]));
  const writes: StateCall[] = [];
  const hooks: { before?: (call: StateCall) => Promise<void>; after?: (call: StateCall) => Promise<void> } = {};
  const adapter = { trigger: async (call: StateCall) => {
    await hooks.before?.(call);
    const { scope, key, value } = call.payload;
    let result: unknown;
    if (call.function_id === "state::get") result = structuredClone(store.get(scope)?.get(key!));
    else if (call.function_id === "state::list") result = structuredClone([...store.get(scope)?.values() ?? []]);
    else {
      writes.push(call);
      if (call.function_id === "state::set") {
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key!, structuredClone(value)); result = value;
      } else if (call.function_id === "state::delete") store.get(scope)?.delete(key!);
      else if (call.function_id === "state::update") throw new Error("unexpected raw update");
      else throw new Error("unexpected state call");
    }
    await hooks.after?.(call);
    return result;
  } };
  const kv = new StateKV(adapter as never), secondKv = new StateKV(adapter as never);
  registerStaleCleanupFunction(sdk as never, kv);
  const request = (kind: "memory" | "lease" = "memory") => ({
    protocol: STALE_DELETE_PROTOCOL, kind,
    id: kind === "memory" ? "mem_one" : "lse_one",
    expectedFingerprint: fingerprint(kind === "memory" ? memory() : lease()),
    cutoff: new Date(Date.now() - MIN_IDLE_MS - 1000).toISOString(),
  });
  const run = (data = request()) => sdk.trigger("mem::maintenance-stale-delete", data) as Promise<Record<string, unknown>>;
  return { sdk, kv, secondKv, store, writes, hooks, request, run };
}

afterEach(() => vi.unstubAllEnvs());

describe("conditional stale deletion", () => {
  it("reports capability without touching state", async () => {
    const f = fixture();
    const result = await f.sdk.trigger("mem::maintenance-stale-delete", { protocol: STALE_DELETE_PROTOCOL, kind: "capabilities" });
    expect(result).toMatchObject({ conditional: true, minIdleMs: MIN_IDLE_MS, protocol: STALE_DELETE_PROTOCOL });
    expect(f.writes).toEqual([]);
  });

  it("deletes an unchanged idle memory and its access log with intent and completion audit", async () => {
    const f = fixture();
    await f.kv.set(KV.accessLog, "mem_one", { memoryId: "mem_one", lastAt: old, recent: [] });
    expect(await f.run()).toMatchObject({ outcome: "deleted", deleted: 1, id: "mem_one" });
    expect(await f.kv.get(KV.memories, "mem_one")).toBeNull();
    expect(await f.kv.get(KV.accessLog, "mem_one")).toBeNull();
    const audit = await f.kv.list<{ details: { phase: string } }>(KV.audit);
    expect(audit.map(row => row.details.phase)).toEqual(["intent", "completed"]);
  });

  it("deletes only terminal old orphan leases", async () => {
    const f = fixture();
    expect(await f.run(f.request("lease"))).toMatchObject({ outcome: "deleted", kind: "lease" });
    expect(await f.kv.get(KV.leases, "lse_one")).toBeNull();
    expect(await f.kv.get(KV.memories, "mem_one")).not.toBeNull();
  });

  it.each(["project", "access"])("preserves fresh %s committed after the client's final check", async change => {
    const f = fixture(), planned = f.request();
    if (change === "project") await f.kv.set(KV.memories, "mem_one", { ...memory(), project: "repo" });
    else await f.kv.set(KV.accessLog, "mem_one", { memoryId: "mem_one", lastAt: new Date().toISOString(), recent: [] });
    expect(await f.run(planned)).toMatchObject({ outcome: "retained", deleted: 0 });
    expect(await f.kv.get(KV.memories, "mem_one")).not.toBeNull();
    expect(f.writes.some(call => call.function_id === "state::delete")).toBe(false);
  });

  it.each(MAINTENANCE_REFERENCE_SCOPES)("preserves references in %s", async scope => {
    const f = fixture();
    await f.kv.set(scope, "other", { id: "other", sourceMemoryIds: ["mem_one"] });
    expect(await f.run()).toMatchObject({ outcome: "retained", reason: "referenced" });
    expect(await f.kv.get(KV.memories, "mem_one")).not.toBeNull();
  });

  it.each(["scope", "access", "reference"])("skips a %s writer during the server's final inventory", async change => {
    const f = fixture(); let injected = false;
    f.hooks.after = async call => {
      if (injected || call.function_id !== "state::list" || call.payload.scope !== KV.crystals) return;
      injected = true;
      if (change === "scope") await f.secondKv.set(KV.memories, "mem_one", { ...memory(), project: "new-repo" });
      if (change === "access") await f.secondKv.set(KV.accessLog, "mem_one", { memoryId: "mem_one", lastAt: new Date().toISOString(), recent: [] });
      if (change === "reference") await f.secondKv.set(KV.actions, "act_new", { id: "act_new", sourceMemoryIds: ["mem_one"] });
    };
    expect(await f.run()).toMatchObject({ outcome: "retained", reason: "concurrent-write" });
    expect(injected).toBe(true);
    expect(await f.kv.get(KV.memories, "mem_one")).not.toBeNull();
  });

  it.each(["renewal", "action"])("skips a lease when %s arrives after the last action lookup", async change => {
    const f = fixture(); let injected = false;
    f.hooks.after = async call => {
      if (injected || call.function_id !== "state::get" || call.payload.scope !== KV.actions) return;
      injected = true;
      if (change === "renewal") await f.secondKv.set(KV.leases, "lse_one", { ...lease(), status: "active", expiresAt: new Date(Date.now() + 100000).toISOString() });
      else await f.secondKv.set(KV.actions, "act_missing", { id: "act_missing" });
    };
    expect(await f.run(f.request("lease"))).toMatchObject({ outcome: "retained", reason: "concurrent-write" });
    expect(await f.kv.get(KV.leases, "lse_one")).not.toBeNull();
  });

  it("skips an in-flight writer even when its mutation has not reached storage", async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.hooks.before = async call => {
      if (call.function_id === "state::set" && call.payload.scope === KV.memories) { entered.resolve(); await release.promise; }
    };
    const writer = f.secondKv.set(KV.memories, "mem_one", { ...memory(), project: "repo" });
    await entered.promise;
    expect(await f.run()).toMatchObject({ outcome: "retained", reason: "concurrent-write" });
    release.resolve(); await writer;
    expect(await f.kv.get(KV.memories, "mem_one")).toMatchObject({ project: "repo" });
  });

  it.each(["set", "update", "delete"])("rejects stale %s queued during delete; unrelated writes resume", async method => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.hooks.before = async call => {
      if (call.function_id === "state::delete" && call.payload.scope === KV.memories) { entered.resolve(); await release.promise; }
    };
    const deletion = f.run(); await entered.promise;
    const conflicting = method === "set"
      ? f.secondKv.set(KV.actions, "act_new", { id: "act_new", sourceMemoryIds: ["mem_one"] })
      : method === "update" ? f.secondKv.update(KV.memories, "mem_one", [{ type: "set", path: "project", value: "repo" }])
        : f.secondKv.delete(KV.memories, "mem_one");
    const failure = expect(conflicting).rejects.toThrow("maintenance_write_conflict");
    const unrelated = f.secondKv.set(KV.actions, "act_other", { id: "act_other", title: "Unrelated" });
    expect(f.store.get(KV.actions)?.has("act_other")).not.toBe(true);
    release.resolve();
    expect(await deletion).toMatchObject({ outcome: "deleted" });
    await failure; await unrelated;
    expect(await f.kv.get(KV.actions, "act_new")).toBeNull();
    expect(await f.kv.get(KV.actions, "act_other")).not.toBeNull();
  });

  it("propagates inventory and audit failures before deletion", async () => {
    for (const failure of ["inventory", "audit"]) {
      const f = fixture();
      f.hooks.before = async call => {
        if (failure === "inventory" && call.function_id === "state::list") throw new Error("inventory unavailable");
        if (failure === "audit" && call.function_id === "state::set" && call.payload.scope === KV.audit) throw new Error("audit unavailable");
      };
      await expect(f.run()).rejects.toThrow(`${failure} unavailable`);
      expect(await f.kv.get(KV.memories, "mem_one")).not.toBeNull();
      f.hooks.before = undefined;
      await expect(f.secondKv.set(KV.memories, "mem_one", { ...memory(), project: "repo" })).resolves.toBeDefined();
    }
  });

  it("rejects malformed, oversized and duplicate reference inventories", async () => {
    for (const rows of [null, [{ id: "repeat" }, { id: "repeat" }], Array.from({ length: 5001 }, (_, i) => ({ id: `mem_${i}` }))]) {
      const f = fixture(), original = f.kv.list.bind(f.kv);
      f.kv.list = (async (scope: string) => scope === KV.memories ? rows : original(scope)) as typeof f.kv.list;
      await expect(f.run()).rejects.toThrow(/maintenance_inventory/);
      expect(await f.kv.get(KV.memories, "mem_one")).not.toBeNull();
    }
  });

  it("blocks later cleanup after a failed state write with an uncertain outcome", async () => {
    const f = fixture();
    f.hooks.before = async call => {
      if (call.function_id === "state::set") throw new Error("state write timed out");
    };
    await expect(f.secondKv.set(KV.actions, "act_late", { id: "act_late", sourceMemoryIds: ["mem_one"] })).rejects.toThrow("timed out");
    f.hooks.before = undefined;
    expect(await f.run()).toMatchObject({ outcome: "retained", reason: "state-write-uncertain" });
    expect(await f.sdk.trigger("mem::maintenance-stale-delete", { protocol: STALE_DELETE_PROTOCOL, kind: "capabilities" })).toMatchObject({ requiresReconciliation: true });
    expect(await f.kv.get(KV.memories, "mem_one")).not.toBeNull();
    await expect(f.kv.set(KV.actions, "act_other", { id: "act_other" })).resolves.toBeDefined();
  });

  it("keeps intent evidence and rejects queued stale writes after an uncertain delete", async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    f.hooks.after = async call => {
      if (call.function_id === "state::delete" && call.payload.scope === KV.memories) {
        entered.resolve(); await release.promise; throw new Error("delete response lost");
      }
    };
    const deletion = expect(f.run()).rejects.toThrow("response lost");
    await entered.promise;
    const writer = expect(f.secondKv.set(KV.memories, "mem_one", { ...memory(), project: "repo" })).rejects.toThrow("maintenance_write_conflict");
    release.resolve(); await deletion; await writer;
    const audit = await f.kv.list<{ details: { phase: string } }>(KV.audit);
    expect(audit.map(row => row.details.phase)).toEqual(["intent"]);
    expect(f.kv.maintenanceBarrier.needsReconciliation).toBe(true);
    expect(await f.kv.get(KV.memories, "mem_one")).toBeNull();
  });

  it.each([{ cutoff: new Date().toISOString() }, { cutoff: "2026-02-30T00:00:00Z" }, { expectedFingerprint: "bad" }, { protocol: "legacy" }, { id: "" }])("rejects invalid policy input %j", async patch => {
    const f = fixture();
    expect(await f.run({ ...f.request(), ...patch })).toMatchObject({ success: false });
    expect(f.writes).toEqual([]);
  });

  it("protects exact age boundary and malformed access evidence", async () => {
    for (const access of [{ memoryId: "wrong", lastAt: old, recent: [] }, { memoryId: "mem_one", lastAt: "bad", recent: [] }, { memoryId: "mem_one", lastAt: old, recent: [NaN] }]) {
      const f = fixture(); await f.kv.set(KV.accessLog, "mem_one", access);
      expect(await f.run()).toMatchObject({ outcome: "retained", reason: "invalid-access-log" });
    }
    const f = fixture(), req = f.request(), row = { ...memory(), updatedAt: req.cutoff };
    await f.kv.set(KV.memories, "mem_one", row);
    expect(await f.run({ ...req, expectedFingerprint: fingerprint(row) })).toMatchObject({ reason: "recent" });
  });

  it("authenticates the REST endpoint and forwards only the protocol fields", async () => {
    vi.stubEnv("AGENTMEMORY_SECRET", "synthetic-test-secret");
    const f = fixture(), handler = vi.fn(async () => ({ success: true }));
    f.sdk.registerFunction("mem::maintenance-stale-delete", handler);
    registerApiTriggers(f.sdk as never, f.kv, "synthetic-test-secret");
    expect(await f.sdk.trigger("api::maintenance-stale-delete", { headers: {}, body: f.request() })).toMatchObject({ status_code: 401 });
    expect(handler).not.toHaveBeenCalled();
    const req = f.request();
    expect(await f.sdk.trigger("api::maintenance-stale-delete", {
      headers: { authorization: "Bearer synthetic-test-secret" }, body: { ...req, bypass: true },
    })).toMatchObject({ status_code: 200 });
    expect(handler).toHaveBeenCalledWith(req);
  });
});
