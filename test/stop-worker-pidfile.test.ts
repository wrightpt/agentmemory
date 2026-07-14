import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #640 + #474: stop must also kill the worker process, not just the
// iii engine. We expose the worker pidfile from src/index.ts and read it
// from src/cli.ts. Static check that both files agree on the path
// (~/.agentmemory/worker.pid), acquire it before SDK registration, and
// ensure that stop reads it.
describe("stop reaps the worker process (#640, #474)", () => {
  it("src/index.ts acquires worker.pid before registering with iii", () => {
    const source = readFileSync("src/index.ts", "utf-8");
    expect(source).toMatch(/workerPidfilePath\(\)/);
    expect(source).toMatch(/"worker\.pid"/);
    expect(source).toMatch(/acquireWorkerPidfileLease\(\)/);
    expect(source).toMatch(/clearWorkerPidfile\(\)/);
    expect(source).toMatch(
      /async function main\(\) \{\s+acquireWorkerPidfileLease\(\);[\s\S]+registerWorker\(/,
    );
  });

  it("src/cli.ts reads worker.pid in runStop and signals it on stop", () => {
    const source = readFileSync("src/cli.ts", "utf-8");
    expect(source).toMatch(/workerPidfilePath\(\)/);
    expect(source).toMatch(/"worker\.pid"/);
    expect(source).toMatch(/readWorkerPidfile\(\)/);
    expect(source).toMatch(/clearWorkerPidfile\(\)/);
    // Verify stop wiring: workerCandidates set is built from the pidfile
    // and signaled alongside the engine pids.
    expect(source).toMatch(/workerCandidates/);
    expect(source).toMatch(/Stopping agentmemory worker/);
  });

  it("both files agree on the pidfile path: ~/.agentmemory/worker.pid", () => {
    const indexSrc = readFileSync("src/index.ts", "utf-8");
    const cliSrc = readFileSync("src/cli.ts", "utf-8");
    expect(indexSrc).toMatch(/\.agentmemory["'].*worker\.pid|"worker\.pid"/);
    expect(cliSrc).toMatch(/\.agentmemory["'].*worker\.pid|"worker\.pid"/);
  });

  it("default CLI startup exits before importing a duplicate worker", () => {
    const source = readFileSync("src/cli.ts", "utf-8");
    expect(source).toMatch(/if \(await isAgentmemoryReady\(\)\)/);
    expect(source).toMatch(/Refusing to register a duplicate worker/);
  });
});
