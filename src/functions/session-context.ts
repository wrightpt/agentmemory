import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAudit } from "./audit.js";

export interface SessionContextInput {
  sessionId: string;
  project?: string;
  cwd?: string;
  repoRoot?: string;
  scopeType?: string;
  worktree?: string;
  branch?: string;
  taskSlug?: string;
}

const CONTEXT_FIELDS = [
  "project",
  "cwd",
  "repoRoot",
  "scopeType",
  "worktree",
  "branch",
  "taskSlug",
] as const;

function contextView(session: Session) {
  return {
    id: session.id,
    project: session.project,
    cwd: session.cwd,
    repoRoot: session.repoRoot,
    scopeType: session.scopeType,
    worktree: session.worktree,
    branch: session.branch,
    taskSlug: session.taskSlug,
    projectAliases: session.projectAliases,
    updatedAt: session.updatedAt,
    contextUpdatedAt: session.contextUpdatedAt,
  };
}

export function registerSessionContextFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::session-context-update", async (data: SessionContextInput) => {
    if (!data?.sessionId || typeof data.sessionId !== "string") {
      return { success: false, error: "sessionId is required" };
    }
    return withKeyedLock(`session-context:${data.sessionId}`, async () => {
      const session = await kv.get<Session>(KV.sessions, data.sessionId);
      if (!session) {
        return { success: false, error: "session not found", sessionId: data.sessionId };
      }

      const updates: Array<{ type: "set"; path: string; value: unknown }> = [];
      const changed: string[] = [];
      for (const field of CONTEXT_FIELDS) {
        const value = data[field];
        if (typeof value !== "string" || !value.trim()) continue;
        const normalized = value.trim();
        if (session[field] === normalized) continue;
        updates.push({ type: "set", path: field, value: normalized });
        changed.push(field);
      }

      if (changed.includes("project") && session.project) {
        const aliases = new Set(session.projectAliases ?? []);
        aliases.add(session.project);
        aliases.delete(data.project?.trim() ?? "");
        updates.push({ type: "set", path: "projectAliases", value: [...aliases].sort() });
      }
      if (updates.length === 0) {
        return { success: true, changed: [], context: contextView(session) };
      }

      updates.push({
        type: "set",
        path: "contextUpdatedAt",
        value: new Date().toISOString(),
      });
      await kv.update(KV.sessions, data.sessionId, updates);
      await recordAudit(
        kv,
        "session_context_update",
        "mem::session-context-update",
        [data.sessionId],
        { changed },
      );
      const updated = await kv.get<Session>(KV.sessions, data.sessionId);
      return {
        success: true,
        changed,
        context: updated ? contextView(updated) : null,
      };
    });
  });
}
