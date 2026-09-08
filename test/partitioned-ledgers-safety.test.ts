import { afterEach, describe, expect, it, vi } from "vitest";
import { KV } from "../src/state/schema.js";
import {
  getActionEvent,
  listActionEventsForAction,
  listAuditEntries,
  writeActionEvent,
  writeAuditEntry,
} from "../src/state/partitioned-ledgers.js";
import { readActionStoreSnapshot } from "../src/functions/action-store.js";
import { registerActionsFunction } from "../src/functions/actions.js";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import type { ActionEvent, ExportData } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function event(id: string, revision: number, type: ActionEvent["type"]): ActionEvent {
  return { schemaVersion: 2, id, actionId: "act_existing", entityType: "action", revision, type, actor: "test", timestamp: "2026-09-05T00:00:00.000Z" };
}

describe("partitioned history integrity", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps history readable across legacy write rollback and reactivation", async () => {
    const kv = mockKV();
    const initial = event("initial", 1, "created");
    await writeActionEvent(kv, initial);
    const audit = { id: "partitioned-audit", timestamp: initial.timestamp, operation: "observe" as const, functionId: "test::rollback", targetIds: [], details: {} };
    await writeAuditEntry(kv, audit);

    vi.stubEnv("AGENTMEMORY_LEDGER_WRITE_MODE", "legacy");
    const rollbackUpdate = event("rollback-update", 2, "fields_changed");
    await writeActionEvent(kv, rollbackUpdate);
    await writeAuditEntry(kv, { ...audit, id: "legacy-audit" });
    expect(await kv.list(KV.actionEvents)).toEqual([rollbackUpdate]);
    expect(await kv.list(KV.audit)).toEqual([{ ...audit, id: "legacy-audit" }]);
    expect(await getActionEvent(kv, initial.id)).toEqual(initial);
    expect((await listActionEventsForAction(kv, initial.actionId)).map(row => row.id)).toEqual(["initial", "rollback-update"]);

    vi.stubEnv("AGENTMEMORY_LEDGER_WRITE_MODE", "partitioned");
    await writeActionEvent(kv, event("reactivated", 3, "fields_changed"));
    expect((await listActionEventsForAction(kv, initial.actionId)).map(row => row.id)).toEqual(["initial", "rollback-update", "reactivated"]);
    expect((await listAuditEntries(kv)).map(row => row.id).sort()).toEqual(["legacy-audit", "partitioned-audit"]);
  });

  it("rejects an unknown write mode before changing storage", async () => {
    const kv = mockKV();
    vi.stubEnv("AGENTMEMORY_LEDGER_WRITE_MODE", "typo");
    await expect(writeActionEvent(kv, event("initial", 1, "created"))).rejects.toThrow("Invalid AGENTMEMORY_LEDGER_WRITE_MODE");
    expect(await kv.listGroups()).toEqual([]);
  });

  it("keeps legacy updates when an imported creation event is in a partition", async () => {
    const kv = mockKV();
    await kv.set(KV.actionEvents, "legacy-update", event("legacy-update", 2, "fields_changed"));
    await writeActionEvent(kv, event("initial", 1, "created"), { imported: true });
    expect((await listActionEventsForAction(kv, "act_existing")).map(row => row.id)).toEqual(["initial", "legacy-update"]);
  });

  it("keeps legacy history when an existing action is migrated into partitions", async () => {
    const kv = mockKV();
    await kv.set(KV.actionEvents, "legacy-update", event("legacy-update", 2, "fields_changed"));
    await writeActionEvent(kv, event("migration", 3, "migrated"));
    expect((await listActionEventsForAction(kv, "act_existing")).map(row => row.id)).toEqual(["legacy-update", "migration"]);
  });

  it.each([KV.actions, KV.actionEdges, KV.actionEvents])("rejects a snapshot when %s cannot be read", async scope => {
    const kv = mockKV();
    const list = kv.list;
    kv.list = async <T>(requested: string): Promise<T[]> => {
      if (requested === scope) throw new Error("state read unavailable");
      return list<T>(requested);
    };
    await expect(readActionStoreSnapshot(kv as never, { includeEvents: true })).rejects.toThrow("state read unavailable");
  });

  it("rejects a history snapshot when partition discovery fails", async () => {
    const kv = mockKV();
    kv.listGroups = async () => { throw new Error("partition discovery unavailable"); };
    await expect(readActionStoreSnapshot(kv as never, { includeEvents: true })).rejects.toThrow("partition discovery unavailable");
  });

  it("does not import an event when its existing identity cannot be checked", async () => {
    const source = mockKV();
    const sourceSdk = mockSdk();
    registerActionsFunction(sourceSdk as never, source as never);
    registerExportImportFunction(sourceSdk as never, source as never);
    await sourceSdk.trigger("mem::action-create", { title: "Import identity fixture", project: "test" });
    const exported = await sourceSdk.trigger("mem::export", {}) as ExportData;
    expect(exported.actionEvents?.length).toBeGreaterThan(0);
    const target = mockKV();
    const targetSdk = mockSdk();
    registerExportImportFunction(targetSdk as never, target as never);
    const get = target.get;
    target.get = async <T>(scope: string, key: string): Promise<T | null> => {
      if (scope.startsWith("mem:action-event-locations:")) throw new Error("event identity unavailable");
      return get<T>(scope, key);
    };
    const result = await targetSdk.trigger("mem::import", { exportData: exported, strategy: "merge" });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("event identity unavailable") });
    expect(await target.list(KV.actions)).toEqual([]);
  });
});
