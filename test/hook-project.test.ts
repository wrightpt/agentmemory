import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      expect(resolveProjectContext(dir).worktree).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
