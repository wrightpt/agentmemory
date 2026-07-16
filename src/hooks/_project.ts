import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";

export interface ProjectContext {
  project: string;
  cwd: string;
  repoRoot: string;
  scopeType: string;
  worktree?: string;
  branch?: string;
  taskSlug?: string;
}

interface ProjectFile {
  project_id?: unknown;
  projectId?: unknown;
  repo_root?: unknown;
  repoRoot?: unknown;
  scope_type?: unknown;
  scopeType?: unknown;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function nearestProjectFile(cwd: string, boundary?: string): string | undefined {
  let current = canonicalExistingPath(cwd);
  const filesystemRoot = parse(current).root;
  const root = boundary ? canonicalExistingPath(boundary) : filesystemRoot;
  while (true) {
    const candidate = resolve(current, ".agentmemory", "project.json");
    if (existsSync(candidate)) return candidate;
    if (current === root || current === filesystemRoot) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readProjectFile(cwd: string, boundary?: string): { file: string; data: ProjectFile } | undefined {
  const file = nearestProjectFile(cwd, boundary);
  if (!file) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as ProjectFile;
    return { file, data };
  } catch {
    return undefined;
  }
}

function remoteProjectName(remote: string): string {
  const normalized = remote.trim().replace(/\/$/, "").replace(/\.git$/, "");
  if (!normalized) return "";
  const tail = normalized.split(/[/:]/).filter(Boolean).at(-1);
  return tail || "";
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveProjectContext(cwd?: string): ProjectContext {
  const rawDir = cwd && cwd.trim() ? cwd.trim() : process.cwd();
  // Copilot can forward a Windows cwd to a hook running under WSL or a
  // POSIX test harness. node:path would otherwise turn `C:\\repo` into a
  // child of the current POSIX directory and inherit an unrelated manifest.
  if (process.platform !== "win32" && (/^[A-Za-z]:[\\/]/.test(rawDir) || rawDir.startsWith("\\\\"))) {
    const explicitProject = nonEmpty(process.env["AGENTMEMORY_PROJECT_NAME"]);
    const taskSlug = nonEmpty(process.env["AGENTMEMORY_TASK_SLUG"]);
    return {
      project: explicitProject || basename(rawDir),
      cwd: rawDir,
      repoRoot: nonEmpty(process.env["AGENTMEMORY_REPO_ROOT"]) || rawDir,
      scopeType: nonEmpty(process.env["AGENTMEMORY_SCOPE_TYPE"]) || "directory",
      ...(taskSlug ? { taskSlug } : {}),
    };
  }
  const dir = resolve(rawDir);
  const gitTop = git(dir, ["rev-parse", "--show-toplevel"]);
  const projectFile = readProjectFile(dir, gitTop || undefined);
  const remoteName = remoteProjectName(git(dir, ["config", "--get", "remote.origin.url"]));
  const fileProject = projectFile
    ? nonEmpty(projectFile.data.project_id) ?? nonEmpty(projectFile.data.projectId)
    : undefined;
  const explicitProject = nonEmpty(process.env["AGENTMEMORY_PROJECT_NAME"]);
  const rawRepoRoot = projectFile
    ? nonEmpty(projectFile.data.repo_root) ?? nonEmpty(projectFile.data.repoRoot)
    : undefined;
  const configuredRepoRoot = nonEmpty(process.env["AGENTMEMORY_REPO_ROOT"]);
  const projectFileRoot = projectFile ? dirname(dirname(projectFile.file)) : undefined;
  const repoRoot = configuredRepoRoot
    ? resolve(configuredRepoRoot)
    : rawRepoRoot
      ? resolve(projectFileRoot || dir, rawRepoRoot)
      : gitTop || dir;
  const scopeType =
    nonEmpty(process.env["AGENTMEMORY_SCOPE_TYPE"]) ??
    (projectFile
      ? nonEmpty(projectFile.data.scope_type) ?? nonEmpty(projectFile.data.scopeType)
      : undefined) ??
    (gitTop ? "repo" : "directory");
  const taskSlug = nonEmpty(process.env["AGENTMEMORY_TASK_SLUG"]);
  const branch = gitTop ? git(dir, ["branch", "--show-current"]) : "";

  return {
    project: (explicitProject ?? fileProject ?? remoteName) || basename(gitTop || dir),
    cwd: dir,
    repoRoot,
    scopeType,
    ...(gitTop ? { worktree: gitTop } : {}),
    ...(branch ? { branch } : {}),
    ...(taskSlug ? { taskSlug } : {}),
  };
}

export function resolveProject(cwd?: string): string {
  return resolveProjectContext(cwd).project;
}
