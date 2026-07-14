import { afterEach, describe, expect, it } from "vitest";
import {
  getLlmExecutionState,
  isAutoCompressEnabled,
} from "../src/config.js";
import { NoopProvider } from "../src/providers/noop.js";
import { ResilientProvider } from "../src/providers/resilient.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("LLM execution state", () => {
  it("gives the explicit disable flag precedence over a real provider", () => {
    process.env["AGENTMEMORY_DISABLE_LLM_TOOLS"] = "true";

    expect(
      getLlmExecutionState({ name: "anthropic", kind: "llm" }),
    ).toBe("disabled");
  });

  it("recognizes a noop provider through the resilient wrapper", () => {
    delete process.env["AGENTMEMORY_DISABLE_LLM_TOOLS"];

    expect(
      getLlmExecutionState(new ResilientProvider(new NoopProvider())),
    ).toBe("unavailable");
  });

  it("prevents auto-compress from invoking disabled LLM operations", () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    process.env["ANTHROPIC_API_KEY"] = "test-only-key";
    process.env["AGENTMEMORY_DISABLE_LLM_TOOLS"] = "true";

    expect(isAutoCompressEnabled()).toBe(false);
  });
});
