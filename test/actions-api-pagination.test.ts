import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerActionsFunction } from "../src/functions/actions.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { Action } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("Actions REST pagination", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerActionsFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never);

    for (let index = 0; index < 75; index += 1) {
      await sdk.trigger("mem::action-create", { title: `Task ${index}` });
    }
  });

  it("forwards limit and offset and returns page metadata", async () => {
    const response = (await sdk.trigger("api::action-list", {
      headers: {},
      query_params: { limit: "50", offset: "50" },
    })) as {
      status_code: number;
      body: {
        actions: Action[];
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
      };
    };

    expect(response.status_code).toBe(200);
    expect(response.body.actions).toHaveLength(25);
    expect(response.body.total).toBe(75);
    expect(response.body.limit).toBe(50);
    expect(response.body.offset).toBe(50);
    expect(response.body.hasMore).toBe(false);
  });

  it.each([
    [{ limit: "0" }, "limit must be a positive integer"],
    [{ limit: "not-a-number" }, "limit must be a positive integer"],
    [{ offset: "-1" }, "offset must be a non-negative integer"],
    [{ offset: "1.5" }, "offset must be a non-negative integer"],
  ])("rejects invalid pagination parameters", async (queryParams, error) => {
    const response = (await sdk.trigger("api::action-list", {
      headers: {},
      query_params: queryParams,
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toBe(error);
  });
});
