import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireWorkerPidfile,
  releaseWorkerPidfile,
} from "../src/worker-pidfile.js";

function fixturePath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentmemory-worker-pid-")), "worker.pid");
}

describe("worker pidfile singleton lease", () => {
  it("acquires and releases an exclusive pidfile", () => {
    const path = fixturePath();
    const lease = acquireWorkerPidfile(path, 101, () => false);

    expect(readFileSync(path, "utf-8")).toBe("101\n");
    releaseWorkerPidfile(lease);
    expect(() => readFileSync(path, "utf-8")).toThrow();
  });

  it("rejects a second live worker without overwriting its pid", () => {
    const path = fixturePath();
    writeFileSync(path, "202\n");

    expect(() => acquireWorkerPidfile(path, 303, (pid) => pid === 202)).toThrow(
      "agentmemory worker already running (pid 202)",
    );
    expect(readFileSync(path, "utf-8")).toBe("202\n");
  });

  it("reclaims a stale pidfile", () => {
    const path = fixturePath();
    writeFileSync(path, "404\n");

    const lease = acquireWorkerPidfile(path, 505, () => false);

    expect(readFileSync(path, "utf-8")).toBe("505\n");
    releaseWorkerPidfile(lease);
  });

  it("does not release a pidfile that changed ownership", () => {
    const path = fixturePath();
    const lease = acquireWorkerPidfile(path, 606, () => false);
    writeFileSync(path, "707\n");

    releaseWorkerPidfile(lease);

    expect(readFileSync(path, "utf-8")).toBe("707\n");
  });
});
