import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { submitObservation } from "../src/hooks/_observe.js";

const OBSERVATION_HOOKS = [
  "notification",
  "post-tool-failure",
  "post-tool-use",
  "prompt-submit",
  "subagent-start",
  "subagent-stop",
  "task-completed",
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hook observation transport", () => {
  it("waits until the acknowledgement body is consumed", async () => {
    let releaseBody!: () => void;
    const bodyConsumed = new Promise<void>((resolveBody) => {
      releaseBody = resolveBody;
    });
    const arrayBuffer = vi.fn(async () => {
      await bodyConsumed;
      return new ArrayBuffer(0);
    });
    const fetchMock = vi.fn(async () => ({ arrayBuffer }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    let settled = false;
    const pending = submitObservation({ sessionId: "session-1" }).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledOnce());

    expect(settled).toBe(false);
    releaseBody();
    await pending;
    expect(settled).toBe(true);
  });

  it("uses the configured endpoint and bearer secret", async () => {
    vi.stubEnv("AGENTMEMORY_URL", "http://127.0.0.1:3999");
    vi.stubEnv("AGENTMEMORY_SECRET", "test-secret");
    const fetchMock = vi.fn(async () =>
      ({ arrayBuffer: vi.fn(async () => new ArrayBuffer(0)) }) as unknown as Response
    );
    vi.stubGlobal("fetch", fetchMock);

    await submitObservation({ sessionId: "session-2" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3999/agentmemory/observe/async",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret",
        },
      }),
    );
  });

  it("keeps transport failures silent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));

    await expect(
      submitObservation({ sessionId: "session-3" }),
    ).resolves.toBeUndefined();
  });

  it.each(OBSERVATION_HOOKS)("%s awaits the shared acknowledgement helper", (name) => {
    const source = readFileSync(
      resolve(__dirname, "..", "src", "hooks", `${name}.ts`),
      "utf8",
    );

    expect(source).toContain("await submitObservation(");
    expect(source).not.toContain("setTimeout(() => process.exit(0), 500)");
    expect(source).not.toContain("fetch(`${REST_URL}/agentmemory/observe/async`");
  });
});
