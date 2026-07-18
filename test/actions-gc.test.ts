import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerActionsFunction } from "../src/functions/actions.js";
import type { Action, ActionEdge, ActionEvent, AuditEntry } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const DAY_MS = 86_400_000;

function terminalAction(id: string, ageDays: number, lifecycle: Action["lifecycle"]): Action {
  return {
    id,
    title: id,
    status: lifecycle === "done" ? "done" : lifecycle === "cancelled" ? "cancelled" : lifecycle === "active" ? "active" : "pending",
    lifecycle,
    priority: 5,
    schemaVersion: 2,
    createdAt: new Date(Date.now() - (ageDays + 1) * DAY_MS).toISOString(),
    updatedAt: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
  } as Action;
}

describe("mem::action-gc", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerActionsFunction(sdk as never, kv as never);
    await kv.set("mem:actions", "old-done", terminalAction("old-done", 40, "done"));
    await kv.set("mem:actions", "old-cancelled", terminalAction("old-cancelled", 40, "cancelled"));
    await kv.set("mem:actions", "recent-done", terminalAction("recent-done", 1, "done"));
    await kv.set("mem:actions", "old-pending", terminalAction("old-pending", 40, "pending"));
    await kv.set("mem:actions", "old-active", terminalAction("old-active", 40, "active"));
    await kv.set("mem:actions", "old-done-linked", terminalAction("old-done-linked", 40, "done"));
    const edge: ActionEdge = {
      id: "ae_1",
      type: "requires",
      sourceActionId: "old-pending",
      targetActionId: "old-done-linked",
      createdAt: new Date().toISOString(),
    };
    await kv.set("mem:action-edges", edge.id, edge);
  });

  it("defaults to dryRun and only reports candidates", async () => {
    const result = (await sdk.trigger("mem::action-gc", {})) as {
      success: boolean;
      dryRun: boolean;
      candidates: string[];
      deleted: string[];
    };

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.candidates.sort()).toEqual(["old-cancelled", "old-done"]);
    expect(result.deleted).toEqual([]);
    expect(await kv.list("mem:actions")).toHaveLength(6);
    expect(await kv.list("mem:action-events")).toHaveLength(0);
    expect(await kv.list("mem:audit")).toHaveLength(0);
  });

  it("deletes only old terminal, edge-free actions and audits one batched row", async () => {
    const result = (await sdk.trigger("mem::action-gc", {
      dryRun: false,
      actor: "test-gc",
    })) as { success: boolean; deleted: string[] };

    expect(result.success).toBe(true);
    expect(result.deleted.sort()).toEqual(["old-cancelled", "old-done"]);
    expect(await kv.get("mem:actions", "old-done")).toBeNull();
    expect(await kv.get("mem:actions", "old-cancelled")).toBeNull();
    for (const kept of ["recent-done", "old-pending", "old-active", "old-done-linked"]) {
      expect(await kv.get("mem:actions", kept)).not.toBeNull();
    }

    const events = await kv.list<ActionEvent>("mem:action-events");
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.type === "deleted")).toBe(true);
    expect(events.every((event) => event.actor === "test-gc")).toBe(true);

    const audit = await kv.list<AuditEntry>("mem:audit");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation: "action_delete",
      functionId: "mem::action-gc",
    });
    expect(audit[0].targetIds.sort()).toEqual(["old-cancelled", "old-done"]);
  });

  it("honors maxAgeDays and limit", async () => {
    const none = (await sdk.trigger("mem::action-gc", {
      maxAgeDays: 60,
    })) as { candidates: string[] };
    expect(none.candidates).toEqual([]);

    const one = (await sdk.trigger("mem::action-gc", {
      dryRun: false,
      limit: 1,
    })) as { deleted: string[] };
    expect(one.deleted).toHaveLength(1);
  });

  it.each([
    [{ maxAgeDays: -1 }, "maxAgeDays must be a non-negative number"],
    [{ dryRun: "yes" }, "dryRun must be a boolean"],
    [{ limit: 0 }, "limit must be an integer between 1 and 5000"],
  ])("rejects invalid input %o", async (input, error) => {
    const result = (await sdk.trigger("mem::action-gc", input)) as {
      success: boolean;
      error: string;
    };
    expect(result).toEqual({ success: false, error });
  });
});
