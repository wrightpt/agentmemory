import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCompressFunction } from "../src/functions/compress.js";
import type { MemoryProvider, RawObservation } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("mem::compress disabled outcomes", () => {
  it("does not call the provider or increment failure metrics", async () => {
    process.env["AGENTMEMORY_DISABLE_LLM_TOOLS"] = "true";
    const provider: MemoryProvider = {
      name: "test-provider",
      kind: "llm",
      compress: vi.fn(async () => "must not run"),
      summarize: vi.fn(async () => "must not run"),
    };
    const metricsStore = { recordSkipped: vi.fn(async () => undefined) };
    const sdk = mockSdk();
    registerCompressFunction(
      sdk as never,
      mockKV() as never,
      provider,
      metricsStore as never,
    );
    const raw: RawObservation = {
      id: "obs_disabled",
      sessionId: "ses_disabled",
      timestamp: "2026-07-14T00:00:00Z",
      hookType: "post_tool_use",
      raw: {},
    };

    const result = await sdk.trigger("mem::compress", {
      observationId: raw.id,
      sessionId: raw.sessionId,
      raw,
    });

    expect(result).toEqual({
      success: true,
      outcome: "skipped_disabled",
      skipped: "llm_tools_disabled",
    });
    expect(provider.compress).not.toHaveBeenCalled();
    expect(metricsStore.recordSkipped).toHaveBeenCalledWith(
      "mem::compress",
      expect.any(Number),
      "llm_tools_disabled",
    );
  });
});
