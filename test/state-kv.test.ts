import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerActionsFunction } from "../src/functions/actions.js";
import { StateKV } from "../src/state/kv.js";
import type { Action } from "../src/types.js";
import { mockSdk } from "./helpers/mocks.js";

interface RawTriggerInput {
  function_id: string;
  payload: { scope: string; key?: string; value?: unknown };
}

/**
 * Engine-faithful KV backing: the real iii-engine resolves `state::get`
 * with `undefined` (not `null`) when a key or scope is missing. The
 * in-memory test mock historically coerced to `null`, which hid the
 * production regression where `mem::action-create` compared
 * `expectedBefore === null` against `current === undefined` and threw
 * `action_revision_conflict` for every create.
 */
function engineLikeTrigger() {
  const store = new Map<string, Map<string, unknown>>();
  return async ({ function_id, payload }: RawTriggerInput) => {
    if (function_id === "state::get") {
      return store.get(payload.scope)?.get(payload.key as string);
    }
    if (function_id === "state::set") {
      if (!store.has(payload.scope)) store.set(payload.scope, new Map());
      store.get(payload.scope)!.set(payload.key as string, payload.value);
      return payload.value;
    }
    if (function_id === "state::delete") {
      store.get(payload.scope)?.delete(payload.key as string);
      return undefined;
    }
    if (function_id === "state::list") {
      const entries = store.get(payload.scope);
      return entries ? Array.from(entries.values()) : [];
    }
    throw new Error(`No function: ${function_id}`);
  };
}

describe("StateKV engine boundary", () => {
  it("coerces an undefined engine result to null for missing keys", async () => {
    const kv = new StateKV({ trigger: engineLikeTrigger() } as never);
    await expect(kv.get("mem:actions", "act_missing")).resolves.toBeNull();
    await expect(kv.get("mem:no-such-scope", "x")).resolves.toBeNull();
  });

  it("returns the stored value for existing keys", async () => {
    const kv = new StateKV({ trigger: engineLikeTrigger() } as never);
    await kv.set("mem:actions", "act_present", { id: "act_present" });
    await expect(kv.get("mem:actions", "act_present")).resolves.toEqual({
      id: "act_present",
    });
  });

  it("creates an action when the engine reports missing keys as undefined", async () => {
    const sdk = mockSdk();
    const kv = new StateKV({ trigger: engineLikeTrigger() } as never);
    registerActionsFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::action-create", {
      title: "Regression: create must tolerate undefined state::get",
      actor: "kimi",
    })) as { success: boolean; error?: string; action?: Action };

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.action?.title).toBe(
      "Regression: create must tolerate undefined state::get",
    );
    expect(await kv.get("mem:action-state", "current")).toMatchObject({
      revision: 1,
    });
  });
});
