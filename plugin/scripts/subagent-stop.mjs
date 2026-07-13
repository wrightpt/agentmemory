#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";
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
function nearestProjectFile(cwd, boundary) {
	let current = resolve(cwd);
	const root = boundary ? resolve(boundary) : parse(current).root;
	while (true) {
		const candidate = resolve(current, ".agentmemory", "project.json");
		if (existsSync(candidate)) return candidate;
		if (current === root) return void 0;
		current = dirname(current);
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
function remoteProjectName(remote) {
	const normalized = remote.trim().replace(/\/$/, "").replace(/\.git$/, "");
	if (!normalized) return "";
	return normalized.split(/[/:]/).filter(Boolean).at(-1) || "";
}
function nonEmpty(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
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
			...taskSlug ? { taskSlug } : {}
		};
	}
	const dir = resolve(rawDir);
	const gitTop = git(dir, ["rev-parse", "--show-toplevel"]);
	const projectFile = readProjectFile(dir, gitTop || void 0);
	const remoteName = remoteProjectName(git(dir, [
		"config",
		"--get",
		"remote.origin.url"
	]));
	const fileProject = projectFile ? nonEmpty(projectFile.data.project_id) ?? nonEmpty(projectFile.data.projectId) : void 0;
	const explicitProject = nonEmpty(process.env["AGENTMEMORY_PROJECT_NAME"]);
	const rawRepoRoot = projectFile ? nonEmpty(projectFile.data.repo_root) ?? nonEmpty(projectFile.data.repoRoot) : void 0;
	const configuredRepoRoot = nonEmpty(process.env["AGENTMEMORY_REPO_ROOT"]);
	const projectFileRoot = projectFile ? dirname(dirname(projectFile.file)) : void 0;
	const repoRoot = configuredRepoRoot ? resolve(configuredRepoRoot) : rawRepoRoot ? resolve(projectFileRoot || dir, rawRepoRoot) : gitTop || dir;
	const scopeType = nonEmpty(process.env["AGENTMEMORY_SCOPE_TYPE"]) ?? (projectFile ? nonEmpty(projectFile.data.scope_type) ?? nonEmpty(projectFile.data.scopeType) : void 0) ?? (gitTop ? "repo" : "directory");
	const taskSlug = nonEmpty(process.env["AGENTMEMORY_TASK_SLUG"]);
	const branch = gitTop ? git(dir, ["branch", "--show-current"]) : "";
	return {
		project: (explicitProject ?? fileProject ?? remoteName) || basename(gitTop || dir),
		cwd: dir,
		repoRoot,
		scopeType,
		...gitTop ? { worktree: gitTop } : {},
		...branch ? { branch } : {},
		...taskSlug ? { taskSlug } : {}
	};
}
//#endregion
//#region src/hooks/subagent-stop.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
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
	const context = resolveProjectContext(data.cwd);
	fetch(`${REST_URL}/agentmemory/observe/async`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "subagent_stop",
			sessionId,
			...context,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				agent_id: agentId,
				agent_type: agentType,
				last_message: lastMsg
			}
		}),
		signal: AbortSignal.timeout(2e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
main();
//#endregion
export {};

//# sourceMappingURL=subagent-stop.mjs.map