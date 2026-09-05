import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerActionsFunction } from "../src/functions/actions.js";
import {
  classifyAction,
  normalizeActionV2,
} from "../src/functions/action-model.js";
import { selectActionPage } from "../src/functions/action-query.js";
import { KV } from "../src/state/schema.js";
import type { ActionViewContext } from "../src/functions/action-model.js";
import type { Action } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function action(id: string): Action {
  return {
    id,
    title: `Synthetic ${id}`,
    description: "Synthetic action description. ".repeat(100),
    project: "agentmemory",
    priority: 5,
    status: "pending",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    tags: ["agent:worker-a"],
  };
}

const now = Date.parse("2026-09-05T00:00:00.000Z");

function viewContext(actions: Action[]): ActionViewContext {
  return { actions, edges: [], checkpoints: [], sentinels: [], leases: [], now };
}

afterEach(() => vi.restoreAllMocks());

describe("action read resource pressure", () => {
  it("does not serialize full action bodies to compute discarded change flags for a small page", () => {
    const actions = Array.from({ length: 200 }, (_, i) => action(`act_${i}`));
    const snapshot = {
      state: {
        schemaVersion: 2 as const,
        revision: 1,
        updatedAt: new Date(now).toISOString(),
      },
      actions,
      edges: [],
      events: [],
    };
    const stringify = vi.spyOn(JSON, "stringify");
    const page = selectActionPage(snapshot, [], [], [], { limit: 5 });
    const fullActionSerializations = stringify.mock.calls.filter(
      ([value]) => value && typeof value === "object" && "description" in value,
    );
    stringify.mockRestore();

    expect(page.total).toBe(200);
    expect(page.actions).toHaveLength(5);
    expect(page.actions[0]).toEqual(normalizeActionV2(actions[0]).action);
    expect(fullActionSerializations).toHaveLength(0);
  });

  it("normalizes legacy dependencies and conflicts without serializing their full bodies", () => {
    const target = action("act_target");
    const dependency = { ...action("act_dependency"), status: "done" as const };
    const other = { ...action("act_other"), status: "active" as const };
    const context = viewContext([target, dependency, other]);
    context.edges = [
      {
        id: "edge_requires",
        sourceActionId: target.id,
        targetActionId: dependency.id,
        type: "requires",
        createdAt: target.createdAt,
      },
      {
        id: "edge_conflict",
        sourceActionId: target.id,
        targetActionId: other.id,
        type: "conflicts_with",
        createdAt: target.createdAt,
      },
    ];
    const before = structuredClone(context);
    const stringify = vi.spyOn(JSON, "stringify");
    const classified = classifyAction(target, context);
    const serializations = stringify.mock.calls.length;
    stringify.mockRestore();

    expect(classified.view).toBe("blocked");
    expect(classified.blockers).toEqual([
      {
        type: "conflict",
        id: other.id,
        message: `Conflicts with active action ${other.title}`,
      },
    ]);
    expect(classified.action).toEqual(normalizeActionV2(target).action);
    expect(context).toEqual(before);
    expect(serializations).toBe(0);
  });

  it("preserves mutation normalization's change detection", () => {
    const input = action("act_legacy");
    const result = normalizeActionV2(input);
    expect(result.changed).toBe(true);
    expect(normalizeActionV2(result.action).changed).toBe(false);
    expect(classifyAction(input, viewContext([input])).action).toEqual(
      result.action,
    );
  });
});

describe("action lists during iii state read failures", () => {
  it.each([KV.actions, KV.actionEdges, KV.checkpoints, KV.sentinels, KV.leases])(
    "fails closed on %s errors and retries without requiring a new revision",
    async (failedScope) => {
      const sdk = mockSdk();
      const kv = mockKV();
      const target = action("act_waiting");
      await kv.set(KV.actions, target.id, target);
      await kv.set(KV.actionState, "current", { schemaVersion: 2, revision: 1 });
      await kv.set(KV.actionEdges, "edge_requires", {
        id: "edge_requires",
        sourceActionId: target.id,
        targetActionId: "act_missing_dependency",
        type: "requires",
        createdAt: target.createdAt,
      });
      registerActionsFunction(sdk as never, kv as never);
      const list = kv.list;
      let fail = true;
      let failedScopeReads = 0;
      kv.list = async <T>(scope: string): Promise<T[]> => {
        if (scope === failedScope) {
          failedScopeReads++;
          if (fail) {
            throw new Error("Invocation timeout after 5000ms: state::list");
          }
        }
        return list<T>(scope);
      };

      const failed = await sdk.trigger("mem::action-list", { view: "actionable" });
      fail = false;
      const recovered = await sdk.trigger("mem::action-list", { view: "blocked" });
      expect(failed).toEqual({
        success: false,
        error: "Invocation timeout after 5000ms: state::list",
      });
      expect(recovered).toMatchObject({ success: true, total: 1, revision: 1 });
      expect(failedScopeReads).toBe(2);
    },
  );

  it.each([KV.actions, KV.actionEdges])(
    "does not replace a good snapshot with a partial one when %s fails during refresh",
    async (failedScope) => {
      const sdk = mockSdk();
      const kv = mockKV();
      registerActionsFunction(sdk as never, kv as never);
      await kv.set(KV.actions, "act_old", action("act_old"));
      await kv.set(KV.actionState, "current", { schemaVersion: 2, revision: 1 });
      expect(await sdk.trigger("mem::action-list", {})).toMatchObject({ total: 1 });
      await kv.set(KV.actions, "act_new", action("act_new"));
      await kv.set(KV.actionState, "current", { schemaVersion: 2, revision: 2 });
      const list = kv.list;
      let fail = true;
      kv.list = async <T>(scope: string): Promise<T[]> => {
        if (fail && scope === failedScope) {
          throw new Error("state read unavailable");
        }
        return list<T>(scope);
      };
      const failed = await sdk.trigger("mem::action-list", {});
      fail = false;
      const recovered = await sdk.trigger("mem::action-list", {});
      expect(failed).toEqual({
        success: false,
        error: "state read unavailable",
      });
      expect(recovered).toMatchObject({ success: true, total: 2, revision: 2 });
    },
  );

  it("still treats genuinely missing scopes as empty", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerActionsFunction(sdk as never, kv as never);
    expect(await sdk.trigger("mem::action-list", {})).toMatchObject({
      success: true,
      total: 0,
      actions: [],
      views: [],
    });
  });
});
