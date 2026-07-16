#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
//#region src/hooks/post-tool-use.ts
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
	const toolName = data.tool_name ?? data.toolName;
	const toolInput = data.tool_input ?? data.toolArgs;
	if (shouldSkipTool(toolName)) return;
	const context = resolveProjectContext(data.cwd);
	const maxChars = maxCaptureChars();
	const { imageData, cleanOutput } = extractImageData(toolOutput(data));
	await submitObservation({
		hookType: "post_tool_use",
		sessionId,
		...context,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		data: {
			tool_name: toolName,
			tool_input: truncate(toolInput, maxChars),
			tool_output: truncate(cleanOutput, maxChars),
			...imageData ? { image_data: imageData } : {}
		}
	});
}
function shouldSkipTool(value) {
	const name = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (!name) return false;
	if (name.startsWith("mcp__agentmemory__") || name.startsWith("memory_")) return true;
	return (process.env["AGENTMEMORY_SKIP_TOOLS"] || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean).some((pattern) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}
function maxCaptureChars() {
	const value = Number(process.env["AGENTMEMORY_MAX_TOOL_CAPTURE_CHARS"] || "8000");
	if (!Number.isFinite(value) || value < 0) return 8e3;
	return Math.min(Math.floor(value), 32e3);
}
function toolOutput(data) {
	if (data.tool_response !== void 0) return data.tool_response;
	if (data.tool_output !== void 0) return data.tool_output;
	const result = data.tool_result ?? data.toolResult;
	if (typeof result === "object" && result !== null) {
		const obj = result;
		return obj.text_result_for_llm ?? obj.textResultForLlm ?? result;
	}
	return result;
}
function isBase64Image(val) {
	return typeof val === "string" && (val.startsWith("data:image/") || val.startsWith("iVBORw0KGgo") || val.startsWith("/9j/"));
}
function extractImageData(output) {
	if (isBase64Image(output)) return {
		imageData: output,
		cleanOutput: "[image data extracted]"
	};
	if (typeof output === "object" && output !== null && !Array.isArray(output)) {
		const obj = output;
		let imageData;
		const clean = {};
		for (const [key, val] of Object.entries(obj)) if (!imageData && isBase64Image(val)) {
			imageData = val;
			clean[key] = "[image data extracted]";
		} else clean[key] = val;
		return {
			imageData,
			cleanOutput: clean
		};
	}
	return {
		imageData: void 0,
		cleanOutput: output
	};
}
function truncate(value, max) {
	if (typeof value === "string" && value.length > max) return value.slice(0, max) + "\n[...truncated]";
	if (typeof value === "object" && value !== null) {
		const str = JSON.stringify(value);
		if (str.length > max) return str.slice(0, max) + "...[truncated]";
		return value;
	}
	return value;
}
main();
//#endregion
export {};

//# sourceMappingURL=post-tool-use.mjs.map