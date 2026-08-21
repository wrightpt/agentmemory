#!/usr/bin/env node

import { InMemoryKV } from "./in-memory-kv.js";
import { createStdioTransport } from "./transport.js";
import {
  getAllTools,
  getVisibleTools,
  LLM_BACKED_TOOLS,
} from "./tools-registry.js";
import {
  getAgentId,
  getStandalonePersistPath,
  isAgentScopeIsolated,
} from "../config.js";
import { VERSION } from "../version.js";
import { generateId } from "../state/schema.js";
import { selectSessionPage } from "../functions/session-list.js";
import type { Memory, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { memoryToObservation } from "../state/memory-utils.js";
import {
  applyRetrievalPolicy,
  type RetrievalPolicyContext,
} from "../state/retrieval-policy.js";
import {
  captureRetrievalAttribution,
  compactRetrievalProvenance,
  resolveRetrievalProvenance,
} from "../state/provenance.js";
import { normalizeRepositoryIdentity } from "../functions/project-relationships.js";
import {
  resolveHandle,
  invalidateHandle,
  isForceProxyEnabled,
  type Handle,
  type ProxyHandle,
} from "./rest-proxy.js";

const IMPLEMENTED_TOOLS = new Set([
  "memory_save",
  "memory_recall",
  "memory_smart_search",
  "memory_sessions",
  "memory_export",
  "memory_audit",
  "memory_governance_delete",
]);

const SERVER_INFO = {
  name: "agentmemory",
  version: VERSION,
  protocolVersion: "2024-11-05",
};

const kv = new InMemoryKV(getStandalonePersistPath());
let modeAnnounced = false;

function visibleToolNames(): Set<string> {
  const mode = (process.env["AGENTMEMORY_TOOLS"] || "all").trim();
  if (!["all", "core", "workstation", "workstation-llm"].includes(mode)) {
    const requested = new Set(
      mode.split(",").map((name) => name.trim()).filter(Boolean),
    );
    const disabled = new Set(
      (process.env["AGENTMEMORY_DISABLED_TOOLS"] || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
    const noLlm = process.env["AGENTMEMORY_DISABLE_LLM_TOOLS"] === "true";
    return new Set(
      getAllTools()
        .filter(
          (tool) =>
            requested.has(tool.name) &&
            !disabled.has(tool.name) &&
            !(noLlm && LLM_BACKED_TOOLS.has(tool.name)),
        )
        .map((tool) => tool.name),
    );
  }
  return new Set(getVisibleTools().map((tool) => tool.name));
}

function assertToolVisible(toolName: string): void {
  if (!visibleToolNames().has(toolName)) {
    throw new Error(
      `Tool ${toolName} is not permitted by this AgentMemory client's tool allowlist`,
    );
  }
}

function displayAgentmemoryUrl(): string {
  // Match the literal-placeholder guard in rest-proxy.ts so log lines
  // don't show `${AGENTMEMORY_URL}` when an MCP host passed the
  // placeholder through unexpanded.
  const raw = process.env["AGENTMEMORY_URL"];
  if (!raw || (raw.startsWith("${") && raw.endsWith("}"))) {
    return "http://localhost:3111";
  }
  return raw;
}

function announceMode(handle: Handle): void {
  if (modeAnnounced) return;
  modeAnnounced = true;
  if (handle.mode === "proxy") {
    process.stderr.write(
      `[@agentmemory/mcp] proxying to agentmemory server at ${handle.baseUrl}\n`,
    );
  } else {
    const fullToolCount = getAllTools().length;
    process.stderr.write(
      `[@agentmemory/mcp] no server reachable at ${displayAgentmemoryUrl()}; running reduced LOCAL FALLBACK with ${IMPLEMENTED_TOOLS.size} of ${fullToolCount} tools. Start 'npx @agentmemory/agentmemory' (and point AGENTMEMORY_URL at it) to unlock all ${fullToolCount} tools.\n`,
    );
  }
}

function normalizeList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
function parseLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
  if (typeof raw !== "number" && typeof raw !== "string") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function textResponse(payload: unknown, pretty = false): {
  content: Array<{ type: string; text: string }>;
} {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, pretty ? 2 : 0) },
    ],
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function localAgentFilter(v: Validated): string | undefined {
  const explicitAgentId = nonEmptyString(v.agentId);
  const wildcardAgent = explicitAgentId === "*";
  // isAgentScopeIsolated() intentionally returns false when AGENT_ID is
  // absent. Check the raw mode too so reduced fallback does not turn an
  // incomplete isolated configuration into an unscoped read.
  const isolated =
    process.env["AGENTMEMORY_AGENT_SCOPE"]?.trim().toLowerCase() ===
      "isolated" || isAgentScopeIsolated();
  const envAgentId = getAgentId();
  if (isolated && !wildcardAgent && !explicitAgentId && !envAgentId) {
    throw new Error(
      "memory_smart_search local fallback: " +
        "AGENTMEMORY_AGENT_SCOPE=isolated is set but no agent id is " +
        "available (env AGENT_ID unset and no explicit agentId in the " +
        "call). Refusing to read cross-agent rows. Pass agentId: \"*\" " +
        "to opt in to a wildcard read.",
    );
  }
  return wildcardAgent
    ? undefined
    : explicitAgentId ?? (isolated ? envAgentId : undefined);
}

function normalizeLocalMemory(row: Record<string, unknown>): Memory | null {
  const id = nonEmptyString(row["id"]);
  if (!id) return null;
  const createdAt =
    nonEmptyString(row["createdAt"]) ??
    nonEmptyString(row["updatedAt"]) ??
    "1970-01-01T00:00:00.000Z";
  const rawType = nonEmptyString(row["type"]);
  const validTypes = new Set<Memory["type"]>([
    "pattern",
    "preference",
    "architecture",
    "bug",
    "workflow",
    "fact",
  ]);
  const type = validTypes.has(rawType as Memory["type"])
    ? (rawType as Memory["type"])
    : "fact";
  const stringList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

  return {
    id,
    createdAt,
    updatedAt: nonEmptyString(row["updatedAt"]) ?? createdAt,
    type,
    title: nonEmptyString(row["title"]) ?? "",
    content: typeof row["content"] === "string" ? row["content"] : "",
    concepts: stringList(row["concepts"]),
    files: stringList(row["files"]),
    sessionIds: stringList(row["sessionIds"]),
    strength:
      typeof row["strength"] === "number" && Number.isFinite(row["strength"])
        ? row["strength"]
        : 0,
    version:
      typeof row["version"] === "number" && Number.isFinite(row["version"])
        ? row["version"]
        : 1,
    isLatest: row["isLatest"] !== false,
    ...(nonEmptyString(row["agentId"])
      ? { agentId: nonEmptyString(row["agentId"]) }
      : {}),
    ...(nonEmptyString(row["project"])
      ? { project: nonEmptyString(row["project"]) }
      : {}),
    ...(row["attribution"] && typeof row["attribution"] === "object"
      ? { attribution: row["attribution"] as Memory["attribution"] }
      : {}),
    ...(nonEmptyString(row["forgetAfter"])
      ? { forgetAfter: nonEmptyString(row["forgetAfter"]) }
      : {}),
    ...(stringList(row["supersedes"]).length
      ? { supersedes: stringList(row["supersedes"]) }
      : {}),
  };
}

function isLocallySearchable(
  row: Record<string, unknown>,
  memory: Memory,
): boolean {
  if (memory.isLatest === false || row["stale"] === true) return false;
  const forgetAfter = memory.forgetAfter
    ? Date.parse(memory.forgetAfter)
    : Number.NaN;
  return !Number.isFinite(forgetAfter) || forgetAfter > Date.now();
}

async function localRetrievalContext(
  v: Validated,
  kvInstance: InMemoryKV,
  filterAgentId: string | undefined,
): Promise<RetrievalPolicyContext> {
  const session = v.sessionId
    ? await kvInstance.get<Session>("mem:sessions", v.sessionId)
    : null;
  const currentProject =
    nonEmptyString(v.currentProject) ??
    nonEmptyString(v.project) ??
    nonEmptyString(session?.project);
  const currentProjectAliases = new Set(session?.projectAliases ?? []);
  if (session?.project && session.project !== currentProject) {
    currentProjectAliases.add(session.project);
  }
  currentProjectAliases.delete(currentProject ?? "");
  const rawCurrentRepo =
    nonEmptyString(v.currentRepo) ?? nonEmptyString(session?.canonicalRepoId);
  const currentRepoId = rawCurrentRepo
    ? normalizeRepositoryIdentity(rawCurrentRepo)
    : undefined;
  const relatedRepoIds = (v.relatedProjects ?? [])
    .map((repoId) => normalizeRepositoryIdentity(repoId))
    .filter(Boolean);

  if (v.includeRelatedProjects === true && relatedRepoIds.length === 0) {
    throw new Error(
      "memory_smart_search local fallback cannot resolve stored project " +
        "relationships. Pass explicit relatedProjects or start the full " +
        "AgentMemory server.",
    );
  }

  const currentMissionId =
    nonEmptyString(v.missionId) ?? nonEmptyString(session?.missionId);
  return {
    ...(currentProject ? { currentProject } : {}),
    ...(currentProjectAliases.size
      ? { currentProjectAliases: [...currentProjectAliases].sort() }
      : {}),
    ...(currentRepoId ? { currentRepoId } : {}),
    ...(currentMissionId ? { currentMissionId } : {}),
    ...(relatedRepoIds.length
      ? { relatedRepoIds: [...new Set(relatedRepoIds)].sort() }
      : {}),
    ...(v.currentFiles?.length ? { currentFiles: v.currentFiles } : {}),
    includeRelatedProjects: v.includeRelatedProjects === true,
    includeGlobal: v.includeGlobal !== false,
    includeCrossRepo: v.includeCrossRepo === true,
    ...(filterAgentId !== undefined ? { filterAgentId } : {}),
  };
}

async function localScopedMemories(
  v: Validated,
  kvInstance: InMemoryKV,
  rows: Record<string, unknown>[],
  baseScore: (row: Record<string, unknown>, index: number) => number,
) {
  const filterAgentId = localAgentFilter(v);
  const context = await localRetrievalContext(v, kvInstance, filterAgentId);
  const candidates = await Promise.all(
    rows.map(async (row, index) => {
      const memory = normalizeLocalMemory(row);
      if (!memory || !isLocallySearchable(row, memory)) return null;
      const provenance = await resolveRetrievalProvenance(
        kvInstance as unknown as StateKV,
        memoryToObservation(memory),
        memory,
      );
      return {
        id: memory.id,
        baseScore: baseScore(row, index),
        value: { row, memory },
        provenance,
      };
    }),
  );
  return applyRetrievalPolicy(
    candidates.filter(
      (candidate): candidate is NonNullable<typeof candidate> =>
        candidate !== null,
    ),
    context,
  );
}

interface Validated {
  tool: string;
  content?: string;
  type?: string;
  concepts?: string[];
  files?: string[];
  query?: string;
  limit?: number;
  format?: string;
  tokenBudget?: number;
  memoryIds?: string[];
  reason?: string;
  cursor?: string;
  project?: string;
  sessionId?: string;
  expandIds?: string[];
  currentProject?: string;
  currentRepo?: string;
  missionId?: string;
  includeRelatedProjects?: boolean;
  relatedProjects?: string[];
  includeGlobal?: boolean;
  includeCrossRepo?: boolean;
  currentFiles?: string[];
  agentId?: string;
  status?: string;
  since?: string;
  includePrompt?: boolean;
  includeMalformed?: boolean;
}

function validate(toolName: string, args: Record<string, unknown>): Validated {
  if (!IMPLEMENTED_TOOLS.has(toolName)) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const v: Validated = { tool: toolName };
  switch (toolName) {
    case "memory_save": {
      const content = args["content"];
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("content is required");
      }
      v.content = content;
      v.type = (args["type"] as string) || "fact";
      v.concepts = normalizeList(args["concepts"]);
      v.files = normalizeList(args["files"]);
      const project = args["project"];
      if (project !== undefined) {
        if (typeof project !== "string" || !project.trim()) {
          throw new Error("project must be a non-empty string");
        }
        v.project = project.trim();
      }
      if (typeof args["sessionId"] === "string" && args["sessionId"].trim()) {
        v.sessionId = args["sessionId"].trim();
      }
      return v;
    }
    case "memory_recall": {
      const query = args["query"];
      if (typeof query !== "string" || !query.trim()) {
        throw new Error("query is required");
      }
      v.query = query.trim();
      v.limit = parseLimit(args["limit"]);
      const fmt = args["format"];
      if (typeof fmt === "string" && fmt.trim()) {
        v.format = fmt.trim().toLowerCase();
      }
      const budget = args["token_budget"];
      if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
        v.tokenBudget = Math.floor(budget);
      } else if (typeof budget === "string" && budget.trim()) {
        const n = Number(budget);
        if (Number.isFinite(n) && n > 0) v.tokenBudget = Math.floor(n);
      }
      return v;
    }
    case "memory_smart_search": {
      const query = args["query"];
      const expandIds = normalizeList(args["expandIds"]).slice(0, 20);
      if ((typeof query !== "string" || !query.trim()) && expandIds.length === 0) {
        throw new Error("query or expandIds is required");
      }
      if (typeof query === "string" && query.trim()) v.query = query.trim();
      v.expandIds = expandIds;
      v.limit = parseLimit(args["limit"]);
      for (const field of [
        "project",
        "currentProject",
        "currentRepo",
        "missionId",
        "sessionId",
        "agentId",
      ] as const) {
        const value = args[field];
        if (typeof value === "string" && value.trim()) v[field] = value.trim();
      }
      v.includeRelatedProjects = args["includeRelatedProjects"] === true;
      v.relatedProjects = normalizeList(args["relatedProjects"]);
      v.includeGlobal = args["includeGlobal"] !== false;
      v.includeCrossRepo = args["includeCrossRepo"] === true;
      v.currentFiles = normalizeList(args["currentFiles"]);
      return v;
    }
    case "memory_sessions": {
      v.limit = parseLimit(args["limit"], 20);
      if (typeof args["cursor"] === "string") v.cursor = args["cursor"].trim();
      if (typeof args["project"] === "string") v.project = args["project"].trim();
      if (typeof args["status"] === "string") v.status = args["status"].trim();
      if (typeof args["since"] === "string") v.since = args["since"].trim();
      if (typeof args["format"] === "string") v.format = args["format"].trim().toLowerCase();
      v.includePrompt = args["includePrompt"] === true;
      v.includeMalformed = args["includeMalformed"] === true;
      return v;
    }
    case "memory_governance_delete": {
      const ids = normalizeList(args["memoryIds"]);
      if (ids.length === 0) throw new Error("memoryIds is required");
      v.memoryIds = ids;
      v.reason = (args["reason"] as string) || "plugin skill request";
      return v;
    }
    case "memory_export":
      return v;
    case "memory_audit": {
      v.limit = parseLimit(args["limit"], 50);
      return v;
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function handleProxy(
  v: Validated,
  handle: ProxyHandle,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (v.tool) {
    case "memory_save": {
      const result = await handle.call("/agentmemory/remember", {
        method: "POST",
        body: JSON.stringify({
          content: v.content,
          type: v.type,
          concepts: v.concepts,
          files: v.files,
          ...(v.project ? { project: v.project } : {}),
          ...(v.sessionId ? { sessionId: v.sessionId } : {}),
        }),
      });
      return textResponse(result);
    }
    case "memory_recall": {
      const body: Record<string, unknown> = {
        query: v.query,
        limit: v.limit,
        format: v.format ?? "full",
      };
      if (v.tokenBudget != null) body["token_budget"] = v.tokenBudget;
      const result = await handle.call("/agentmemory/search", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return textResponse(result, true);
    }
    case "memory_smart_search": {
      const body: Record<string, unknown> = {
        ...(v.query ? { query: v.query } : {}),
        ...(v.expandIds?.length ? { expandIds: v.expandIds } : {}),
        limit: v.limit,
        ...(v.project ? { project: v.project } : {}),
        ...(v.currentProject ? { currentProject: v.currentProject } : {}),
        ...(v.currentRepo ? { currentRepo: v.currentRepo } : {}),
        ...(v.missionId ? { missionId: v.missionId } : {}),
        ...(v.sessionId ? { sessionId: v.sessionId } : {}),
        includeRelatedProjects: v.includeRelatedProjects === true,
        relatedProjects: v.relatedProjects ?? [],
        includeGlobal: v.includeGlobal !== false,
        includeCrossRepo: v.includeCrossRepo === true,
        currentFiles: v.currentFiles ?? [],
        ...(v.agentId ? { agentId: v.agentId } : {}),
      };
      if (v.format != null) body["format"] = v.format;
      if (v.tokenBudget != null) body["token_budget"] = v.tokenBudget;
      const result = await handle.call("/agentmemory/smart-search", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return textResponse(result, true);
    }
    case "memory_sessions": {
      const params = new URLSearchParams({
        limit: String(v.limit),
        format: v.format ?? "compact",
      });
      if (v.cursor) params.set("cursor", v.cursor);
      if (v.project) params.set("project", v.project);
      if (v.status) params.set("status", v.status);
      if (v.since) params.set("since", v.since);
      if (v.includePrompt) params.set("includePrompt", "true");
      if (v.includeMalformed) params.set("includeMalformed", "true");
      const result = await handle.call(
        `/agentmemory/sessions?${params.toString()}`,
        { method: "GET" },
      );
      return textResponse(result, true);
    }
    case "memory_governance_delete": {
      const result = await handle.call("/agentmemory/governance/memories", {
        method: "DELETE",
        body: JSON.stringify({ memoryIds: v.memoryIds, reason: v.reason }),
      });
      return textResponse(result);
    }
    case "memory_export": {
      const result = await handle.call("/agentmemory/export", { method: "GET" });
      return textResponse(result, true);
    }
    case "memory_audit": {
      const result = await handle.call(
        `/agentmemory/audit?limit=${v.limit}`,
        { method: "GET" },
      );
      return textResponse(result, true);
    }
    default:
      throw new Error(`Unknown tool: ${v.tool}`);
  }
}

async function handleLocal(
  v: Validated,
  kvInstance: InMemoryKV,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (v.tool) {
    case "memory_save": {
      const id = generateId("mem");
      const isoNow = new Date().toISOString();
      const sourceSession = v.sessionId
        ? await kvInstance.get<Session>("mem:sessions", v.sessionId)
        : null;
      const project = v.project ?? sourceSession?.project;
      const agentId = sourceSession?.agentId ?? getAgentId();
      const attribution = captureRetrievalAttribution({
        ...(sourceSession ?? {}),
        ...(project ? { project } : {}),
      });
      await kvInstance.set("mem:memories", id, {
        id,
        type: v.type,
        title: (v.content || "").slice(0, 80),
        content: v.content,
        concepts: v.concepts,
        files: v.files,
        createdAt: isoNow,
        updatedAt: isoNow,
        strength: 7,
        version: 1,
        isLatest: true,
        sessionIds: [],
        ...(v.sessionId ? { sessionIds: [v.sessionId] } : {}),
        ...(agentId ? { agentId } : {}),
        ...(project ? { project } : {}),
        ...(attribution ? { attribution } : {}),
      });
      kvInstance.persist();
      return textResponse({ saved: id });
    }

    case "memory_recall":
    case "memory_smart_search": {
      if (v.tool === "memory_smart_search" && v.expandIds?.length) {
        const wanted = new Set(v.expandIds);
        const all =
          await kvInstance.list<Record<string, unknown>>("mem:memories");
        const scoped = await localScopedMemories(
          v,
          kvInstance,
          all.filter((memory) => wanted.has(String(memory["id"]))),
          (_row, index) => 1 - index * 0.000001,
        );
        return textResponse(
          {
            mode: "expanded",
            results: scoped.map((candidate) => ({
              ...candidate.value.row,
              provenance: candidate.provenance,
              scope: candidate.scope,
              scopeReason: candidate.scopeReason,
            })),
            truncated: false,
          },
          true,
        );
      }
      const query = (v.query || "").toLowerCase();
      const limit = v.limit ?? DEFAULT_LIMIT;
      const all =
        await kvInstance.list<Record<string, unknown>>("mem:memories");
      const lexicalMatches = all.filter((m) => {
          const text = [
            typeof m["title"] === "string" ? m["title"] : "",
            typeof m["content"] === "string" ? m["content"] : "",
            Array.isArray(m["files"]) ? m["files"].join(" ") : "",
            Array.isArray(m["concepts"]) ? m["concepts"].join(" ") : "",
            Array.isArray(m["sessionIds"]) ? m["sessionIds"].join(" ") : "",
            typeof m["id"] === "string" ? m["id"] : "",
          ]
            .join(" ")
            .toLowerCase();
          return query.split(/\s+/).every((word) => text.includes(word));
        });
      const scoped = await localScopedMemories(
        v,
        kvInstance,
        lexicalMatches,
        (_row, index) => 1 - index * 0.000001,
      );
      const results = scoped.slice(0, limit).map((candidate) => ({
        ...candidate.value.row,
        provenance: compactRetrievalProvenance(candidate.provenance),
        scope: candidate.scope,
        scopeReason: candidate.scopeReason,
      }));
      return textResponse({ mode: "compact", results }, true);
    }

    case "memory_sessions": {
      const sessions =
        await kvInstance.list<Session>("mem:sessions");
      const page = selectSessionPage(sessions, {
        limit: v.limit,
        cursor: v.cursor,
        project: v.project,
        status: v.status as Session["status"] | undefined,
        since: v.since,
        format: (v.format ?? "compact") as "compact" | "full",
        includePrompt: v.includePrompt,
        includeMalformed: v.includeMalformed,
      });
      return textResponse(page, true);
    }

    case "memory_governance_delete": {
      let deleted = 0;
      for (const id of v.memoryIds || []) {
        const existing = await kvInstance.get("mem:memories", id);
        if (existing) {
          await kvInstance.delete("mem:memories", id);
          deleted++;
        }
      }
      kvInstance.persist();
      return textResponse({
        deleted,
        requested: (v.memoryIds || []).length,
        reason: v.reason,
      });
    }

    case "memory_export": {
      const memories = await kvInstance.list("mem:memories");
      const sessions = await kvInstance.list("mem:sessions");
      return textResponse({ version: VERSION, memories, sessions }, true);
    }

    case "memory_audit": {
      const entries = await kvInstance.list("mem:audit");
      const limit = v.limit ?? 50;
      return textResponse(
        {
          entries: (entries as Array<Record<string, unknown>>).slice(0, limit),
        },
        true,
      );
    }

    default:
      throw new Error(`Unknown tool: ${v.tool}`);
  }
}

async function handleProxyGeneric(
  toolName: string,
  args: Record<string, unknown>,
  handle: ProxyHandle,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  // Forward to the server's full MCP surface so non-Claude clients can
  // reach all 61 tools (lessons, sentinels, slots, signals, graph, …)
  // instead of being capped at the 7 IMPLEMENTED_TOOLS set baked into
  // this shim. The server validates arguments per tool.
  const result = (await handle.call("/agentmemory/mcp/call", {
    method: "POST",
    body: JSON.stringify({ name: toolName, arguments: args }),
  })) as { content?: Array<{ type: string; text: string }> } | null;
  if (result && Array.isArray(result.content)) {
    return { content: result.content };
  }
  return textResponse(result, true);
}

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  kvInstance: InMemoryKV = kv,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const handle = await resolveHandle();
  announceMode(handle);
  assertToolVisible(toolName);

  // Tools the local InMemoryKV fallback doesn't implement: forward straight
  // to the server. Local validation would otherwise raise "Unknown tool"
  // (issue #234).
  if (!IMPLEMENTED_TOOLS.has(toolName)) {
    if (handle.mode === "proxy") {
      try {
        return await handleProxyGeneric(toolName, args, handle);
      } catch (err) {
        process.stderr.write(
          `[@agentmemory/mcp] proxy call failed for ${toolName}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        invalidateHandle();
        throw err;
      }
    }
    throw new Error(
      `Unknown tool: ${toolName} (local fallback supports only ${[...IMPLEMENTED_TOOLS].join(", ")}; start an agentmemory server and set AGENTMEMORY_URL to use the full tool set)`,
    );
  }

  const validated = validate(toolName, args);
  if (handle.mode === "proxy") {
    try {
      return await handleProxy(validated, handle);
    } catch (err) {
      const failClosed = isForceProxyEnabled();
      process.stderr.write(
        `[@agentmemory/mcp] proxy call failed for ${toolName}: ${err instanceof Error ? err.message : String(err)}; invalidating handle and ${failClosed ? "failing closed because AGENTMEMORY_FORCE_PROXY is set" : "falling back to local KV"}\n`,
      );
      invalidateHandle();
      if (failClosed) throw err;
    }
  }
  return handleLocal(validated, kvInstance);
}

export async function handleToolsList(): Promise<{ tools: unknown[] }> {
  const debug = process.env["AGENTMEMORY_DEBUG"] === "1" || process.env["AGENTMEMORY_DEBUG"] === "true";
  const handle = await resolveHandle();
  announceMode(handle);
  if (debug) {
    process.stderr.write(
      `[@agentmemory/mcp] tools/list: handle.mode=${handle.mode}${handle.mode === "proxy" ? ` baseUrl=${handle.baseUrl}` : ""}\n`,
    );
  }
  if (handle.mode === "proxy") {
    try {
      const remote = (await handle.call("/agentmemory/mcp/tools", {
        method: "GET",
      })) as { tools?: unknown } | null;
      if (debug) {
        const shape = remote === null
          ? "null"
          : typeof remote !== "object"
            ? typeof remote
            : `keys=${Object.keys(remote as object).join(",")} toolsType=${Array.isArray((remote as { tools?: unknown }).tools) ? `array(len=${((remote as { tools: unknown[] }).tools).length})` : typeof (remote as { tools?: unknown }).tools}`;
        process.stderr.write(
          `[@agentmemory/mcp] tools/list: remote response shape: ${shape}\n`,
        );
      }
      if (remote && Array.isArray(remote.tools)) {
        const visible = visibleToolNames();
        const filtered = remote.tools.filter((tool) => {
          if (!tool || typeof tool !== "object") return false;
          const name = (tool as { name?: unknown }).name;
          return typeof name === "string" && visible.has(name);
        });
        if (debug) {
          process.stderr.write(
            `[@agentmemory/mcp] tools/list: returning ${filtered.length} of ${remote.tools.length} server tools after client allowlist\n`,
          );
        }
        return { tools: filtered };
      }
      if (isForceProxyEnabled()) {
        throw new Error("AgentMemory proxy tools/list returned no tools array");
      }
      process.stderr.write(
        `[@agentmemory/mcp] tools/list: server returned unexpected shape (no .tools array); falling back to local IMPLEMENTED_TOOLS list. Set AGENTMEMORY_DEBUG=1 to inspect response.\n`,
      );
    } catch (err) {
      const failClosed = isForceProxyEnabled();
      process.stderr.write(
        `[@agentmemory/mcp] tools/list proxy failed: ${err instanceof Error ? err.message : String(err)}; ${failClosed ? "failing closed because AGENTMEMORY_FORCE_PROXY is set" : "falling back to local list"}\n`,
      );
      invalidateHandle();
      if (failClosed) throw err;
    }
  }
  const visible = visibleToolNames();
  const fallback = getAllTools().filter(
    (tool) => IMPLEMENTED_TOOLS.has(tool.name) && visible.has(tool.name),
  );
  if (debug) {
    process.stderr.write(
      `[@agentmemory/mcp] tools/list: returning ${fallback.length} local fallback tools (${fallback.map((t) => t.name).join(",")})\n`,
    );
  }
  return { tools: fallback };
}

const transport = createStdioTransport(async (method, params) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: SERVER_INFO.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
        },
      };

    case "notifications/initialized":
      return {};

    case "tools/list":
      return handleToolsList();

    case "tools/call": {
      const toolName = params.name as string;
      const toolArgs = (params.arguments as Record<string, unknown>) || {};
      try {
        return await handleToolCall(toolName, toolArgs);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
});

process.stderr.write(
  `[@agentmemory/mcp] Standalone MCP server v${SERVER_INFO.version} starting...\n`,
);
transport.start();

process.on("SIGINT", () => {
  kv.persist();
  process.exit(0);
});
process.on("SIGTERM", () => {
  kv.persist();
  process.exit(0);
});
