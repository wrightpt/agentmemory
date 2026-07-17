import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Action, ActionEdge, Checkpoint, Sentinel } from "../types.js";
import {
  isCanonicalProjectId,
  normalizeActionV2,
  type NormalizeActionResult,
} from "./action-model.js";
import {
  peekActionCollectionState,
  persistActionUnlocked,
  recoverActionStoreUnlocked,
  withActionStoreLock,
} from "./action-store.js";
import { safeAudit } from "./audit.js";

const DEFAULT_MIGRATION_LIMIT = 100;
const MAX_MIGRATION_LIMIT = 500;

export interface ActionsV2MigrationInput {
  dryRun?: boolean;
  projectAliases?: Record<string, string>;
  defaultProjectId?: string;
  limit?: number;
  cursor?: string;
  actor?: string;
}

interface MigrationCandidate {
  action: Action;
  normalized: NormalizeActionResult;
  hasDerivedBlockers: boolean;
}

export async function migrateActionsV2(
  kv: StateKV,
  input: ActionsV2MigrationInput = {},
) {
  return withActionStoreLock(async () => {
    const configurationErrors = validateMigrationInput(input);
    if (configurationErrors.length > 0) {
      return {
        success: false,
        step: "actions-v2",
        dryRun: input.dryRun !== false,
        error: "invalid_migration_config",
        configurationErrors,
      };
    }
    const dryRun = input.dryRun !== false;
    const initialState = dryRun
      ? await peekActionCollectionState(kv)
      : await recoverActionStoreUnlocked(kv);
    const [actions, edges, checkpoints, sentinels] = await Promise.all([
      kv.list<Action>(KV.actions).catch(() => []),
      kv.list<ActionEdge>(KV.actionEdges).catch(() => []),
      kv.list<Checkpoint>(KV.checkpoints).catch(() => []),
      kv.list<Sentinel>(KV.sentinels).catch(() => []),
    ]);
    const limit = normalizeLimit(input.limit);
    const afterId = decodeMigrationCursor(input.cursor);
    const ordered = [...actions].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const eligible = afterId
      ? ordered.filter((action) => action.id > afterId)
      : ordered;
    const page = eligible.slice(0, limit);
    const candidates: MigrationCandidate[] = page.map((action) => {
      const hasDerivedBlockers = hasUnresolvedDerivedBlockers(
        action.id,
        actions,
        edges,
        checkpoints,
        sentinels,
      );
      return {
        action,
        hasDerivedBlockers,
        normalized: normalizeActionV2(action, {
          projectAliases: input.projectAliases,
          defaultProjectId: input.defaultProjectId,
          hasDerivedBlockers,
        }),
      };
    });

    const conflicts = candidates.filter(
      (candidate) => candidate.normalized.conflicts.length > 0,
    );
    const changed = candidates.filter(
      (candidate) => candidate.normalized.changed,
    );
    const preview = candidates.map((candidate) => ({
      actionId: candidate.action.id,
      changed: candidate.normalized.changed,
      warnings: candidate.normalized.warnings,
      conflicts: candidate.normalized.conflicts,
      projectId: candidate.normalized.action.projectId,
    }));
    const hasMore = eligible.length > page.length;
    const nextCursor =
      hasMore && page.length > 0
        ? encodeMigrationCursor(page[page.length - 1].id)
        : null;
    const baseResult = {
      step: "actions-v2",
      dryRun,
      scanned: page.length,
      changed: changed.length,
      skipped: page.length - changed.length,
      warningCount: candidates.reduce(
        (count, candidate) => count + candidate.normalized.warnings.length,
        0,
      ),
      conflictCount: conflicts.reduce(
        (count, candidate) => count + candidate.normalized.conflicts.length,
        0,
      ),
      unresolvedActionIds: conflicts.map((candidate) => candidate.action.id),
      preview,
      revisionBefore: initialState.revision,
      hasMore,
      nextCursor,
    };

    if (dryRun) {
      return {
        success: conflicts.length === 0 && !initialState.pending,
        ...(initialState.pending
          ? {
              error: "pending_action_store_recovery",
              message:
                "A pending action-store write must be recovered before migration",
            }
          : {}),
        ...baseResult,
        revisionAfter: initialState.revision,
      };
    }
    if (conflicts.length > 0) {
      return {
        success: false,
        error: "migration_conflict",
        message: "Resolve conflicting action identities before mutation",
        ...baseResult,
        revisionAfter: initialState.revision,
      };
    }

    let revisionAfter = initialState.revision;
    for (const candidate of changed) {
      const persisted = await persistActionUnlocked(kv, candidate.action, {
        actor: input.actor || "migration:actions-v2",
        type: "migrated",
        reason: candidate.normalized.warnings.join(",") || "Actions v2 normalization",
        before: candidate.action,
        projectAliases: input.projectAliases,
        defaultProjectId: input.defaultProjectId,
        hasDerivedBlockers: candidate.hasDerivedBlockers,
      });
      revisionAfter = persisted.state.revision;
    }
    if (changed.length > 0) {
      await safeAudit(
        kv,
        "action_update",
        "mem::migrate",
        changed.map((candidate) => candidate.action.id),
        {
          actor: input.actor || "migration:actions-v2",
          step: "actions-v2",
          scanned: page.length,
          changed: changed.length,
          revisionBefore: initialState.revision,
          revisionAfter,
        },
      );
    }
    return { success: true, ...baseResult, revisionAfter };
  });
}

function validateMigrationInput(input: ActionsV2MigrationInput): string[] {
  const errors: string[] = [];
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
    errors.push("dryRun must be boolean");
  }
  if (
    input.defaultProjectId !== undefined &&
    !isCanonicalProjectId(input.defaultProjectId)
  ) {
    errors.push("defaultProjectId must be a canonical non-path identifier");
  }
  if (
    input.projectAliases !== undefined &&
    (!input.projectAliases ||
      typeof input.projectAliases !== "object" ||
      Array.isArray(input.projectAliases))
  ) {
    errors.push("projectAliases must be an object");
  } else {
    for (const [alias, projectId] of Object.entries(
      input.projectAliases ?? {},
    )) {
      if (!alias.trim()) errors.push("projectAliases cannot contain empty keys");
      if (!isCanonicalProjectId(projectId)) {
        errors.push(`projectAliases[${alias}] must map to a canonical project ID`);
      }
    }
  }
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || input.limit < 1)
  ) {
    errors.push("limit must be a positive integer");
  }
  return [...new Set(errors)];
}

function hasUnresolvedDerivedBlockers(
  actionId: string,
  actions: Action[],
  edges: ActionEdge[],
  checkpoints: Checkpoint[],
  sentinels: Sentinel[],
): boolean {
  const actionMap = new Map(actions.map((action) => [action.id, action]));
  const checkpointMap = new Map(
    checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
  );
  const sentinelMap = new Map(
    sentinels.map((sentinel) => [sentinel.id, sentinel]),
  );
  return edges.some((edge) => {
    if (edge.sourceActionId !== actionId) return false;
    if (edge.type === "requires") {
      const dependency = actionMap.get(edge.targetActionId);
      return (
        (dependency?.lifecycle ?? dependency?.status) !== "done"
      );
    }
    if (edge.type === "gated_by") {
      return (
        checkpointMap.get(edge.targetActionId)?.status !== "passed" &&
        sentinelMap.get(edge.targetActionId)?.status !== "triggered"
      );
    }
    return false;
  });
}

function normalizeLimit(value?: number): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return DEFAULT_MIGRATION_LIMIT;
  }
  return Math.min(value, MAX_MIGRATION_LIMIT);
}

function encodeMigrationCursor(afterId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, afterId }), "utf8").toString(
    "base64url",
  );
}

function decodeMigrationCursor(cursor?: string): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { v?: unknown; afterId?: unknown };
    if (parsed.v !== 1 || typeof parsed.afterId !== "string" || !parsed.afterId) {
      throw new Error("invalid cursor");
    }
    return parsed.afterId;
  } catch {
    throw new Error("cursor must be a valid actions-v2 migration cursor");
  }
}
