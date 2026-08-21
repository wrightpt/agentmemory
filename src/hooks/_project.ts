import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import {
  localGitRepositoryId,
  normalizeRepositoryRemote,
} from "../utils/repository-identity.js";

export interface ProjectContext {
  project: string;
  cwd: string;
  repoRoot: string;
  scopeType: string;
  worktree?: string;
  branch?: string;
  taskSlug?: string;
  projectAliases?: string[];
  canonicalRepoId?: string;
  repoRemote?: string;
  terminalSession?: string;
  missionId?: string;
  missionTitle?: string;
  missionRole?: string;
  parentSession?: string;
  commitSha?: string;
}

interface ProjectFile {
  project_id?: unknown;
  projectId?: unknown;
  repo_root?: unknown;
  repoRoot?: unknown;
  scope_type?: unknown;
  scopeType?: unknown;
  aliases?: unknown;
  project_aliases?: unknown;
  projectAliases?: unknown;
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

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(...values: unknown[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const candidate of value) {
      const normalized = nonEmpty(candidate);
      if (normalized) result.add(normalized);
    }
  }
  return [...result].sort();
}

function workstationSessionContext(): Pick<
  ProjectContext,
  "terminalSession" | "missionId" | "missionTitle" | "missionRole" | "parentSession"
> {
  const terminalSession = nonEmpty(process.env["WSH_SESSION_NAME"]);
  const missionId = nonEmpty(process.env["WSH_MISSION_ID"]);
  const missionTitle = nonEmpty(process.env["WSH_MISSION_TITLE"]);
  const missionRole = nonEmpty(process.env["WSH_MISSION_ROLE"]);
  const parentSession = nonEmpty(process.env["WSH_PARENT_SESSION"]);
  return {
    ...(terminalSession ? { terminalSession } : {}),
    ...(missionId ? { missionId } : {}),
    ...(missionTitle ? { missionTitle } : {}),
    ...(missionRole ? { missionRole } : {}),
    ...(parentSession ? { parentSession } : {}),
  };
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
      ...workstationSessionContext(),
    };
  }
  const dir = resolve(rawDir);
  const gitTop = git(dir, ["rev-parse", "--show-toplevel"]);
  const projectFile = readProjectFile(dir, gitTop || undefined);
  const remoteIdentity = normalizeRepositoryRemote(
    git(dir, ["config", "--get", "remote.origin.url"]),
  );
  const remoteName = remoteIdentity?.canonicalRepoId.split("/").at(-1);
  const rawGitCommonDir = gitTop ? git(dir, ["rev-parse", "--git-common-dir"]) : "";
  const gitCommonDir = rawGitCommonDir
    ? canonicalExistingPath(
        isAbsolute(rawGitCommonDir)
          ? rawGitCommonDir
          : resolve(gitTop || dir, rawGitCommonDir),
      )
    : undefined;
  const canonicalRepoId =
    remoteIdentity?.canonicalRepoId ??
    (gitCommonDir ? localGitRepositoryId(gitCommonDir) : undefined);
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
  const commitSha = gitTop ? git(dir, ["rev-parse", "HEAD"]) : "";
  const project = (explicitProject ?? fileProject ?? remoteName) || basename(gitTop || dir);
  const aliases = projectFile
    ? stringArray(
        projectFile.data.aliases,
        projectFile.data.project_aliases,
        projectFile.data.projectAliases,
      )
    : [];
  if (fileProject && fileProject !== project) aliases.push(fileProject);
  const projectAliases = [...new Set(aliases.filter((alias) => alias !== project))].sort();

  return {
    project,
    cwd: dir,
    repoRoot,
    scopeType,
    ...(gitTop ? { worktree: canonicalExistingPath(gitTop) } : {}),
    ...(branch ? { branch } : {}),
    ...(taskSlug ? { taskSlug } : {}),
    ...(projectAliases.length > 0 ? { projectAliases } : {}),
    ...(canonicalRepoId ? { canonicalRepoId } : {}),
    ...(remoteIdentity ? { repoRemote: remoteIdentity.repoRemote } : {}),
    ...(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitSha)
      ? { commitSha: commitSha.toLowerCase() }
      : {}),
    ...workstationSessionContext(),
  };
}

export function resolveProject(cwd?: string): string {
  return resolveProjectContext(cwd).project;
}
