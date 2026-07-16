import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ISdk } from "iii-sdk";

import { triggerDetached } from "../src/utils/trigger-detached.js";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });
}

describe("tracked detached triggers", () => {
  it("starts a normal invocation without waiting for its result", () => {
    const trigger = vi.fn(async () => ({ success: true }));

    triggerDetached(
      { trigger } as unknown as Pick<ISdk, "trigger">,
      { function_id: "mem::example", payload: { id: "one" } },
    );

    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::example",
      payload: { id: "one" },
    });
  });

  it("does not allow the iii 0.11.2 void-action leak back into source", () => {
    const offenders = sourceFiles(resolve(__dirname, "..", "src")).filter(
      (path) => readFileSync(path, "utf8").includes("TriggerAction.Void()"),
    );

    expect(offenders).toEqual([]);
  });
});
