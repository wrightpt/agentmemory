import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AgentMemory project manifest", () => {
  it("keeps canonical cross-agent scope stable in every worktree", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../.agentmemory/project.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      project_id: "agentmemory",
      scope_type: "repo",
      repo_root: "/home/cp/repos/agent-infra/agentmemory",
      memory_policy: "default-isolated",
    });
  });
});
