import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe.each([
  ["iii-config.yaml", "./data/queue_store"],
  ["iii-config.docker.yaml", "/data/queue_store"],
])("%s observation queue", (configPath, queueStorePath) => {
  it("uses a file-backed concurrent queue with retries and a DLQ", () => {
    const config = readFileSync(configPath, "utf8");

    expect(config).toContain("agentmemory-observations:");
    expect(config).toContain("max_retries: 5");
    expect(config).toContain("concurrency: 4");
    expect(config).toContain("type: standard");
    expect(config).toContain("store_method: file_based");
    expect(config).toContain(`file_path: ${queueStorePath}`);
  });
});
