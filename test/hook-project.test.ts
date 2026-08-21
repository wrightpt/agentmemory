import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveProject, resolveProjectContext } from "../src/hooks/_project.js";

describe("resolveProject — hook project basename resolver", () => {
  const originalEnv = process.env.AGENTMEMORY_PROJECT_NAME;

  beforeEach(() => {
    delete process.env.AGENTMEMORY_PROJECT_NAME;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTMEMORY_PROJECT_NAME;
    } else {
      process.env.AGENTMEMORY_PROJECT_NAME = originalEnv;
    }
  });

  it("AGENTMEMORY_PROJECT_NAME env wins over everything", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "my-override";
    expect(resolveProject("/var/log")).toBe("my-override");
    expect(resolveProject(process.cwd())).toBe("my-override");
  });

  it("trims whitespace on env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "  spaced  ";
    expect(resolveProject("/var/log")).toBe("spaced");
  });

  it("ignores empty env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "   ";
    const repoBasename = "agentmemory";
    expect(resolveProject(process.cwd())).toBe(repoBasename);
  });

  it("returns git toplevel basename when cwd is inside a repo", () => {
    const top = resolveProject(process.cwd());
    expect(top).toBe("agentmemory");
  });

  it("returns git toplevel basename from a nested subdir", () => {
    const nested = join(process.cwd(), "src", "hooks");
    expect(resolveProject(nested)).toBe("agentmemory");
  });

  it("falls back to basename(cwd) when not in a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-noproj-"));
    try {
      expect(resolveProject(dir)).toBe(dir.split("/").pop());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to process.cwd() when no cwd argument given", () => {
    expect(resolveProject()).toBe("agentmemory");
  });

  it("defaults to process.cwd() when cwd argument is empty", () => {
    expect(resolveProject("")).toBe("agentmemory");
    expect(resolveProject("   ")).toBe("agentmemory");
  });

  it("prefers canonical snake_case project scope over worktree and remote names", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-scope-"));
    try {
      mkdirSync(join(dir, ".agentmemory"));
      writeFileSync(
        join(dir, ".agentmemory", "project.json"),
        JSON.stringify({
          project_id: "canonical-project",
          repo_root: "/canonical/root",
          scope_type: "repo",
        }),
      );
      const nested = join(dir, "nested");
      mkdirSync(nested);
      expect(resolveProjectContext(nested)).toMatchObject({
        project: "canonical-project",
        repoRoot: "/canonical/root",
        scopeType: "repo",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the remote repository name instead of a worktree directory name", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-worktree-name-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:owner/stable-project.git"]);
      expect(resolveProject(dir)).toBe("stable-project");
      expect(resolveProjectContext(dir)).toMatchObject({
        worktree: realpathSync.native(dir),
        canonicalRepoId: "owner/stable-project",
        repoRemote: "ssh://github.com/owner/stable-project",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      remote: "git@github.com:WrightPT/AgentMemory.git",
      canonicalRepoId: "wrightpt/agentmemory",
      repoRemote: "ssh://github.com/wrightpt/agentmemory",
    },
    {
      remote: "https://user:secret@github.com/WrightPT/AgentMemory.git?token=hidden#fragment",
      canonicalRepoId: "wrightpt/agentmemory",
      repoRemote: "https://github.com/wrightpt/agentmemory",
    },
    {
      remote: "ssh://git@git.example.com/Platform/AgentMemory.git",
      canonicalRepoId: "git.example.com/Platform/AgentMemory",
      repoRemote: "ssh://git.example.com/Platform/AgentMemory",
    },
  ])("derives a stable canonical identity and sanitized remote from $remote", ({
    remote,
    canonicalRepoId,
    repoRemote,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "amem-remote-identity-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
      expect(resolveProjectContext(dir)).toMatchObject({ canonicalRepoId, repoRemote });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps unrelated same-basename remotes separate", () => {
    const root = mkdtempSync(join(tmpdir(), "amem-same-name-"));
    const first = join(root, "first", "service");
    const second = join(root, "second", "service");
    try {
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      execFileSync("git", ["init", "-q", first]);
      execFileSync("git", ["init", "-q", second]);
      execFileSync("git", ["-C", first, "remote", "add", "origin", "git@github.com:org-a/service.git"]);
      execFileSync("git", ["-C", second, "remote", "add", "origin", "git@github.com:org-b/service.git"]);

      expect(resolveProject(first)).toBe("service");
      expect(resolveProject(second)).toBe("service");
      expect(resolveProjectContext(first).canonicalRepoId).toBe("org-a/service");
      expect(resolveProjectContext(second).canonicalRepoId).toBe("org-b/service");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("converges remote-less linked worktrees on an opaque git-common-dir identity", () => {
    const root = mkdtempSync(join(tmpdir(), "amem-local-worktrees-"));
    const main = join(root, "main");
    const linked = join(root, "linked");
    try {
      execFileSync("git", ["init", "-q", main]);
      writeFileSync(join(main, "tracked.txt"), "identity\n");
      execFileSync("git", ["-C", main, "add", "tracked.txt"]);
      execFileSync("git", [
        "-C",
        main,
        "-c",
        "user.name=AgentMemory Test",
        "-c",
        "user.email=agentmemory@example.invalid",
        "commit",
        "-qm",
        "identity fixture",
      ]);
      execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "identity-linked", linked]);

      const mainContext = resolveProjectContext(main);
      const linkedContext = resolveProjectContext(linked);
      expect(mainContext.canonicalRepoId).toMatch(/^local-git:[a-f0-9]{64}$/);
      expect(linkedContext.canonicalRepoId).toBe(mainContext.canonicalRepoId);
      expect(linkedContext.worktree).not.toBe(mainContext.worktree);
      expect(linkedContext.commitSha).toBe(mainContext.commitSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains explicit manifest aliases without replacing the project ID", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-aliases-"));
    try {
      mkdirSync(join(dir, ".agentmemory"));
      writeFileSync(
        join(dir, ".agentmemory", "project.json"),
        JSON.stringify({
          project_id: "agentmemory",
          aliases: ["memory-engine", " agent-memory ", "agentmemory"],
          project_aliases: ["legacy-agentmemory"],
        }),
      );
      expect(resolveProjectContext(dir)).toMatchObject({
        project: "agentmemory",
        projectAliases: ["agent-memory", "legacy-agentmemory", "memory-engine"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles a symlinked cwd whose git root has a canonical path", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-symlink-root-"));
    const repo = join(dir, "repo");
    const alias = join(dir, "repo-alias");
    try {
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:owner/stable-project.git"]);
      symlinkSync(repo, alias, "dir");

      expect(resolveProjectContext(alias)).toMatchObject({
        project: "stable-project",
        repoRoot: realpathSync.native(repo),
        worktree: realpathSync.native(repo),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
