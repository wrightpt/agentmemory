import { describe, expect, it } from "vitest";
import type { ActionEvent, AuditEntry } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import {
  actionEventBucket,
  actionEventImportPartitionScope,
  actionEventLocationScope,
  actionEventPartitionScope,
  auditPartitionScope,
  getActionEvent,
  listActionEventLedgerEntries,
  listActionEvents,
  listActionEventsForAction,
  listAuditEntries,
  writeActionEvent,
  writeAuditEntry,
} from "../src/state/partitioned-ledgers.js";
import { mockKV } from "./helpers/mocks.js";

function audit(id: string, timestamp: string): AuditEntry {
  return {
    id,
    timestamp,
    operation: "observe",
    functionId: "test::partition",
    targetIds: [],
    details: {},
  };
}

function actionEvent(
  id: string,
  actionId: string,
  timestamp: string,
  type: ActionEvent["type"] = "fields_changed",
): ActionEvent {
  return {
    schemaVersion: 2,
    id,
    actionId,
    entityType: "action",
    revision: id === "created" ? 1 : 2,
    type,
    actor: "test",
    timestamp,
  };
}

describe("partitioned append-only ledgers", () => {
  it("normalizes audit partitions to UTC days and rejects bad timestamps", () => {
    expect(auditPartitionScope("2026-09-04T23:30:00-04:00")).toBe(
      "mem:audit:day:2026-09-05",
    );
    expect(() => auditPartitionScope("not-a-date")).toThrow(
      "Invalid ledger timestamp",
    );
  });

  it("keeps the legacy audit scope read-only while returning old and new rows", async () => {
    const kv = mockKV();
    const legacy = audit("legacy", "2026-09-03T10:00:00.000Z");
    const current = audit("current", "2026-09-04T10:00:00.000Z");
    await kv.set(KV.audit, legacy.id, legacy);

    await writeAuditEntry(kv, current);

    expect(await kv.list(KV.audit)).toEqual([legacy]);
    expect(await kv.list(auditPartitionScope(current.timestamp))).toEqual([
      current,
    ]);
    expect(await listAuditEntries(kv)).toEqual([legacy, current]);
  });

  it("uses stable 64-way monthly action-event buckets", () => {
    const bucket = actionEventBucket("act_example");
    expect(bucket).toMatch(/^b(?:[0-5]\d|6[0-3])$/);
    expect(actionEventBucket("act_example")).toBe(bucket);
    expect(
      actionEventPartitionScope("2026-09-30T23:59:59.000Z", "act_example"),
    ).toBe(`mem:action-events:month:2026-09:${bucket}`);
    expect(() =>
      actionEventPartitionScope("bad", "act_example"),
    ).toThrow("Invalid ledger timestamp");
    expect(() =>
      actionEventPartitionScope("+010000-01-01T00:00:00.000Z", "act_example"),
    ).toThrow("outside the partition range");
  });

  it("uses fixed bounded buckets for imported events with extreme dates", async () => {
    const kv = mockKV();
    const imported = actionEvent(
      "far_future",
      "act_future",
      "+010000-01-01T00:00:00.000Z",
      "created",
    );
    await writeActionEvent(kv, imported, { imported: true });

    const location = await kv.get<{ scope: string }>(
      actionEventLocationScope(imported.id),
      imported.id,
    );
    expect(location?.scope).toBe(
      actionEventImportPartitionScope(imported.actionId),
    );
    expect(
      await getActionEvent(kv, imported.id, {
        timestamp: imported.timestamp,
        actionId: imported.actionId,
      }),
    ).toEqual(imported);
  });

  it("combines legacy and partitioned action events without duplicate IDs", async () => {
    const kv = mockKV();
    const legacy = actionEvent(
      "legacy",
      "act_old",
      "2026-08-01T00:00:00.000Z",
      "created",
    );
    const staleDuplicate = actionEvent(
      "duplicate",
      "act_duplicate",
      "2026-08-01T00:00:00.000Z",
    );
    const replacement = {
      ...staleDuplicate,
      timestamp: "2026-09-01T00:00:00.000Z",
      actor: "partitioned",
    };
    await kv.set(KV.actionEvents, legacy.id, legacy);
    await kv.set(KV.actionEvents, staleDuplicate.id, staleDuplicate);
    await writeActionEvent(kv, replacement);

    const values = await listActionEvents(kv);
    expect(values).toHaveLength(2);
    expect(values).toContainEqual(legacy);
    expect(values.find((event) => event.id === "duplicate")?.actor).toBe(
      "partitioned",
    );
  });

  it("returns exact storage scopes for replace-import deletion", async () => {
    const kv = mockKV();
    const legacy = actionEvent(
      "legacy",
      "act_old",
      "2026-08-01T00:00:00.000Z",
      "created",
    );
    const current = actionEvent(
      "current",
      "act_new",
      "2026-09-04T00:00:00.000Z",
      "created",
    );
    await kv.set(KV.actionEvents, legacy.id, legacy);
    await writeActionEvent(kv, current);

    const entries = await listActionEventLedgerEntries(kv);
    expect(entries).toContainEqual({ scope: KV.actionEvents, value: legacy });
    expect(entries).toContainEqual({
      scope: actionEventPartitionScope(current.timestamp, current.actionId),
      value: current,
    });
  });

  it("reads both layouts even for actions born in partitions", async () => {
    const kv = mockKV();
    const actionId = "act_new";
    await writeActionEvent(
      kv,
      actionEvent("created", actionId, "2026-09-04T00:00:00.000Z", "created"),
    );
    await writeActionEvent(
      kv,
      actionEvent("updated", actionId, "2026-10-04T00:00:00.000Z"),
    );
    const listedScopes: string[] = [];
    const originalList = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      listedScopes.push(scope);
      return originalList<T>(scope);
    };

    const events = await listActionEventsForAction(kv, actionId);

    expect(events.map((event) => event.id)).toEqual(["created", "updated"]);
    expect(listedScopes).toContain(KV.actionEvents);
  });

  it("falls back to legacy history for actions that predate partitions", async () => {
    const kv = mockKV();
    const actionId = "act_old";
    const legacy = actionEvent(
      "created",
      actionId,
      "2026-08-04T00:00:00.000Z",
      "created",
    );
    const current = actionEvent(
      "updated",
      actionId,
      "2026-09-04T00:00:00.000Z",
    );
    await kv.set(KV.actionEvents, legacy.id, legacy);
    await writeActionEvent(kv, current);

    expect(await listActionEventsForAction(kv, actionId)).toEqual([
      legacy,
      current,
    ]);
    expect(
      await getActionEvent(kv, current.id, {
        timestamp: current.timestamp,
        actionId,
      }),
    ).toEqual(current);
  });

  it("uses the locator to detect an event ID under altered partition fields", async () => {
    const kv = mockKV();
    const original = actionEvent(
      "same_id",
      "act_original",
      "2026-09-04T00:00:00.000Z",
      "created",
    );
    await writeActionEvent(kv, original);

    expect(
      await getActionEvent(kv, original.id, {
        timestamp: "2027-01-01T00:00:00.000Z",
        actionId: "act_changed",
      }),
    ).toEqual(original);
    expect(
      await kv.get(actionEventLocationScope(original.id), original.id),
    ).toMatchObject({
      schemaVersion: 1,
      eventId: original.id,
      actionId: original.actionId,
      scope: actionEventPartitionScope(original.timestamp, original.actionId),
    });
  });

  it("falls back to legacy writes for adapters without list-groups support", async () => {
    const kv = mockKV();
    const legacyAdapter = {
      get: kv.get,
      set: kv.set,
      delete: kv.delete,
      list: kv.list,
    };
    const auditEntry = audit("audit", "2026-09-04T00:00:00.000Z");
    const event = actionEvent(
      "event",
      "act_legacy_adapter",
      "2026-09-04T00:00:00.000Z",
      "created",
    );

    await writeAuditEntry(legacyAdapter, auditEntry);
    await writeActionEvent(legacyAdapter, event);

    expect(await kv.list(KV.audit)).toEqual([auditEntry]);
    expect(await kv.list(KV.actionEvents)).toEqual([event]);
  });
});
