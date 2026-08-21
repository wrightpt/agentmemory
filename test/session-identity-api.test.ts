import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV } from "./helpers/mocks.js";

function captureSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOptions: string | { id: string }, handler: Function) => {
      const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
      functions.set(id, handler);
    },
    registerTrigger: vi.fn(),
    trigger: vi.fn(async (input: { function_id: string }) =>
      input.function_id === "mem::context" ? { context: "" } : { success: true },
    ),
    getFunction: (id: string) => functions.get(id),
  };
}

describe("session identity REST capture", () => {
  it("stores sanitized canonical and workstation provenance fields", async () => {
    const sdk = captureSdk();
    registerApiTriggers(sdk as never, mockKV() as never);

    const response = (await sdk.getFunction("api::session::start")!({
      headers: {},
      body: {
        sessionId: "ses_identity",
        project: "agentmemory",
        cwd: "/repo/worktree",
        repoRoot: "/repo/main",
        worktree: "/repo/worktree",
        branch: "feature/identity",
        projectAliases: ["agent-memory"],
        canonicalRepoId: "forged/repository",
        repoRemote: "https://user:secret@github.com/WrightPT/AgentMemory.git",
        terminalSession: "shared-agentmemory-codex",
        missionId: "mission-memory",
        missionTitle: "Institutional memory",
        missionRole: "worker",
        parentSession: "shared-agentmemory-lead",
        commitSha: "E".repeat(40),
        agentId: "codex",
      },
    })) as { status_code: number; body: { session: Record<string, unknown> } };

    expect(response.status_code).toBe(200);
    expect(response.body.session).toMatchObject({
      project: "agentmemory",
      projectAliases: ["agent-memory"],
      canonicalRepoId: "wrightpt/agentmemory",
      repoRemote: "https://github.com/wrightpt/agentmemory",
      terminalSession: "shared-agentmemory-codex",
      missionId: "mission-memory",
      missionTitle: "Institutional memory",
      missionRole: "worker",
      parentSession: "shared-agentmemory-lead",
      commitSha: "e".repeat(40),
      agentId: "codex",
    });
  });
});
