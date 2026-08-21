#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import { createHash } from "node:crypto";
//#region src/utils/repository-identity.ts
const NETWORK_PROTOCOLS = new Set([
	"http:",
	"https:",
	"ssh:",
	"git:"
]);
function normalizedRepositoryPath(value) {
	const path = value.trim().replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
	if (!path || /[\\\s?#]/.test(path)) return void 0;
	if (path.split("/").some((segment) => !segment || segment === "." || segment === "..")) return;
	return path;
}
/**
* Convert a network Git origin into a credential-free locator and stable ID.
* Local paths and file:// remotes deliberately return undefined.
*/
function normalizeRepositoryRemote(remote) {
	const raw = remote.trim();
	if (!raw || /[\r\n\0]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return;
	let protocol;
	let authority;
	let repositoryPath;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		let parsed;
		try {
			parsed = new URL(raw);
		} catch {
			return;
		}
		if (!NETWORK_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return void 0;
		protocol = parsed.protocol.toLowerCase();
		authority = parsed.host.toLowerCase();
		repositoryPath = normalizedRepositoryPath(parsed.pathname);
	} else {
		const scp = raw.match(/^[^@\s]+@([^:\s]+):(.+)$/);
		if (!scp) return void 0;
		protocol = "ssh:";
		authority = scp[1].toLowerCase();
		repositoryPath = normalizedRepositoryPath(scp[2]);
	}
	if (!repositoryPath) return void 0;
	const github = authority === "github.com";
	const canonicalPath = github ? repositoryPath.toLowerCase() : repositoryPath;
	if (github && canonicalPath.split("/").length !== 2) return void 0;
	return {
		canonicalRepoId: github ? canonicalPath : `${authority}/${canonicalPath}`,
		repoRemote: `${protocol}//${authority}/${canonicalPath}`
	};
}
/** Workstation-local identity for remote-less Git repositories and all linked worktrees. */
function localGitRepositoryId(gitCommonDir) {
	return `local-git:${createHash("sha256").update(gitCommonDir).digest("hex")}`;
}
//#endregion
//#region src/hooks/_project.ts
function git(cwd, args) {
	try {
		return execFileSync("git", args, {
			cwd,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim();
	} catch {
		return "";
	}
}
function canonicalExistingPath(path) {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}
function nearestProjectFile(cwd, boundary) {
	let current = canonicalExistingPath(cwd);
	const filesystemRoot = parse(current).root;
	const root = boundary ? canonicalExistingPath(boundary) : filesystemRoot;
	while (true) {
		const candidate = resolve(current, ".agentmemory", "project.json");
		if (existsSync(candidate)) return candidate;
		if (current === root || current === filesystemRoot) return void 0;
		const parent = dirname(current);
		if (parent === current) return void 0;
		current = parent;
	}
}
function readProjectFile(cwd, boundary) {
	const file = nearestProjectFile(cwd, boundary);
	if (!file) return void 0;
	try {
		return {
			file,
			data: JSON.parse(readFileSync(file, "utf8"))
		};
	} catch {
		return;
	}
}
function nonEmpty(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function stringArray(...values) {
	const result = /* @__PURE__ */ new Set();
	for (const value of values) {
		if (!Array.isArray(value)) continue;
		for (const candidate of value) {
			const normalized = nonEmpty(candidate);
			if (normalized) result.add(normalized);
		}
	}
	return [...result].sort();
}
function workstationSessionContext() {
	const terminalSession = nonEmpty(process.env["WSH_SESSION_NAME"]);
	const missionId = nonEmpty(process.env["WSH_MISSION_ID"]);
	const missionTitle = nonEmpty(process.env["WSH_MISSION_TITLE"]);
	const missionRole = nonEmpty(process.env["WSH_MISSION_ROLE"]);
	const parentSession = nonEmpty(process.env["WSH_PARENT_SESSION"]);
	return {
		...terminalSession ? { terminalSession } : {},
		...missionId ? { missionId } : {},
		...missionTitle ? { missionTitle } : {},
		...missionRole ? { missionRole } : {},
		...parentSession ? { parentSession } : {}
	};
}
function resolveProjectContext(cwd) {
	const rawDir = cwd && cwd.trim() ? cwd.trim() : process.cwd();
	if (process.platform !== "win32" && (/^[A-Za-z]:[\\/]/.test(rawDir) || rawDir.startsWith("\\\\"))) {
		const explicitProject = nonEmpty(process.env["AGENTMEMORY_PROJECT_NAME"]);
		const taskSlug = nonEmpty(process.env["AGENTMEMORY_TASK_SLUG"]);
		return {
			project: explicitProject || basename(rawDir),
			cwd: rawDir,
			repoRoot: nonEmpty(process.env["AGENTMEMORY_REPO_ROOT"]) || rawDir,
			scopeType: nonEmpty(process.env["AGENTMEMORY_SCOPE_TYPE"]) || "directory",
			...taskSlug ? { taskSlug } : {},
			...workstationSessionContext()
		};
	}
	const dir = resolve(rawDir);
	const gitTop = git(dir, ["rev-parse", "--show-toplevel"]);
	const projectFile = readProjectFile(dir, gitTop || void 0);
	const remoteIdentity = normalizeRepositoryRemote(git(dir, [
		"config",
		"--get",
		"remote.origin.url"
	]));
	const remoteName = remoteIdentity?.canonicalRepoId.split("/").at(-1);
	const rawGitCommonDir = gitTop ? git(dir, ["rev-parse", "--git-common-dir"]) : "";
	const gitCommonDir = rawGitCommonDir ? canonicalExistingPath(isAbsolute(rawGitCommonDir) ? rawGitCommonDir : resolve(gitTop || dir, rawGitCommonDir)) : void 0;
	const canonicalRepoId = remoteIdentity?.canonicalRepoId ?? (gitCommonDir ? localGitRepositoryId(gitCommonDir) : void 0);
	const fileProject = projectFile ? nonEmpty(projectFile.data.project_id) ?? nonEmpty(projectFile.data.projectId) : void 0;
	const explicitProject = nonEmpty(process.env["AGENTMEMORY_PROJECT_NAME"]);
	const rawRepoRoot = projectFile ? nonEmpty(projectFile.data.repo_root) ?? nonEmpty(projectFile.data.repoRoot) : void 0;
	const configuredRepoRoot = nonEmpty(process.env["AGENTMEMORY_REPO_ROOT"]);
	const projectFileRoot = projectFile ? dirname(dirname(projectFile.file)) : void 0;
	const repoRoot = configuredRepoRoot ? resolve(configuredRepoRoot) : rawRepoRoot ? resolve(projectFileRoot || dir, rawRepoRoot) : gitTop || dir;
	const scopeType = nonEmpty(process.env["AGENTMEMORY_SCOPE_TYPE"]) ?? (projectFile ? nonEmpty(projectFile.data.scope_type) ?? nonEmpty(projectFile.data.scopeType) : void 0) ?? (gitTop ? "repo" : "directory");
	const taskSlug = nonEmpty(process.env["AGENTMEMORY_TASK_SLUG"]);
	const branch = gitTop ? git(dir, ["branch", "--show-current"]) : "";
	const commitSha = gitTop ? git(dir, ["rev-parse", "HEAD"]) : "";
	const project = (explicitProject ?? fileProject ?? remoteName) || basename(gitTop || dir);
	const aliases = projectFile ? stringArray(projectFile.data.aliases, projectFile.data.project_aliases, projectFile.data.projectAliases) : [];
	if (fileProject && fileProject !== project) aliases.push(fileProject);
	const projectAliases = [...new Set(aliases.filter((alias) => alias !== project))].sort();
	return {
		project,
		cwd: dir,
		repoRoot,
		scopeType,
		...gitTop ? { worktree: canonicalExistingPath(gitTop) } : {},
		...branch ? { branch } : {},
		...taskSlug ? { taskSlug } : {},
		...projectAliases.length > 0 ? { projectAliases } : {},
		...canonicalRepoId ? { canonicalRepoId } : {},
		...remoteIdentity ? { repoRemote: remoteIdentity.repoRemote } : {},
		.../^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitSha) ? { commitSha: commitSha.toLowerCase() } : {},
		...workstationSessionContext()
	};
}
//#endregion
//#region src/hooks/_observe.ts
const DEFAULT_ACK_TIMEOUT_MS = 500;
const MAX_ACK_TIMEOUT_MS = 5e3;
function ackTimeoutMs() {
	const configured = Number(process.env["AGENTMEMORY_HOOK_ACK_TIMEOUT_MS"] ?? DEFAULT_ACK_TIMEOUT_MS);
	if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_ACK_TIMEOUT_MS;
	return Math.max(1, Math.min(Math.floor(configured), MAX_ACK_TIMEOUT_MS));
}
function authHeaders() {
	const headers = { "Content-Type": "application/json" };
	const secret = process.env["AGENTMEMORY_SECRET"] || "";
	if (secret) headers["Authorization"] = `Bearer ${secret}`;
	return headers;
}
async function submitObservation(payload) {
	const restUrl = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
	try {
		await (await fetch(`${restUrl}/agentmemory/observe/async`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(ackTimeoutMs())
		})).arrayBuffer();
	} catch {}
}
//#endregion
//#region src/hooks/subagent-stop.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || "unknown";
	const agentId = data.agent_id || data.agentName;
	const agentType = data.agent_type || data.agentDisplayName || data.agentName;
	const lastMsg = typeof data.last_assistant_message === "string" ? data.last_assistant_message.slice(0, 4e3) : "";
	await submitObservation({
		hookType: "subagent_stop",
		sessionId,
		...resolveProjectContext(data.cwd),
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		data: {
			agent_id: agentId,
			agent_type: agentType,
			last_message: lastMsg
		}
	});
}
main();
//#endregion
export {};

//# sourceMappingURL=subagent-stop.mjs.map