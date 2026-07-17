import { createHash } from "node:crypto";
import { basename, isAbsolute, win32 } from "node:path";
import type {
  Action,
  ActionApproval,
  ActionApprovalState,
  ActionBlocker,
  ActionEdge,
  ActionLifecycle,
  ActionReadinessView,
  ActionViewItem,
  Checkpoint,
  Lease,
  Sentinel,
} from "../types.js";

export const ACTION_SCHEMA_VERSION = 2 as const;
export const DEFAULT_ACTION_PROJECT_ID = "workstation";

const LIFECYCLES = new Set<ActionLifecycle>([
  "pending",
  "active",
  "done",
  "cancelled",
]);
const APPROVAL_STATES = new Set<ActionApprovalState>([
  "not_required",
  "pending",
  "approved",
  "rejected",
]);
const HUMAN_WAIT_TAGS = new Set([
  "requires-confirmation",
  "awaiting-human",
  "approval-required",
]);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface NormalizeActionOptions {
  projectAliases?: Record<string, string>;
  defaultProjectId?: string;
  hasDerivedBlockers?: boolean;
  revision?: number;
}

export interface NormalizeActionResult {
  action: Action;
  changed: boolean;
  warnings: string[];
  conflicts: string[];
}

export interface ActionViewContext {
  actions: Action[];
  edges: ActionEdge[];
  checkpoints: Checkpoint[];
  sentinels: Sentinel[];
  leases: Lease[];
  agentId?: string;
  now?: number;
  index?: ActionViewIndex;
}

export interface ActionViewIndex {
  actionMap: Map<string, Action>;
  edgesByActionId: Map<string, ActionEdge[]>;
  checkpointMap: Map<string, Checkpoint>;
  sentinelMap: Map<string, Sentinel>;
  activeLeaseMap: Map<string, Lease>;
}

interface ActionCursorPayload {
  v: 1;
  revision: number;
  offset: number;
  filter: string;
  asOf: number;
}

export function isActionLifecycle(value: unknown): value is ActionLifecycle {
  return typeof value === "string" && LIFECYCLES.has(value as ActionLifecycle);
}

export function isActionApprovalState(
  value: unknown,
): value is ActionApprovalState {
  return (
    typeof value === "string" &&
    APPROVAL_STATES.has(value as ActionApprovalState)
  );
}

export function isCanonicalProjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PROJECT_ID_PATTERN.test(value) &&
    !isProjectPath(value)
  );
}

export function isValidActionTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

export function normalizeActionTags(value: unknown): string[] {
  const input = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [
    ...new Set(
      input
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

export function normalizeActionV2(
  input: Action,
  options: NormalizeActionOptions = {},
): NormalizeActionResult {
  const raw = input as Action & { tags?: unknown };
  const warnings: string[] = [];
  const conflicts: string[] = [];
  const tags = normalizeActionTags(raw.tags);
  if (!Array.isArray(raw.tags)) warnings.push("tags_normalized");

  const tagProjectIds = uniqueTagValues(tags, "projectId");
  const validTagProjectIds = tagProjectIds.filter(isCanonicalProjectId);
  const invalidTagProjectIds = tagProjectIds.filter(
    (value) => !isCanonicalProjectId(value),
  );

  const legacyProject = nonEmpty(raw.project);
  const explicitProjectId = nonEmpty(raw.projectId);
  const mappedProject = legacyProject
    ? nonEmpty(options.projectAliases?.[legacyProject])
    : undefined;
  let projectId: string | undefined;

  if (explicitProjectId) {
    if (!isCanonicalProjectId(explicitProjectId)) {
      conflicts.push("invalid_explicit_project_id");
    } else {
      projectId = explicitProjectId;
    }
  }
  if (mappedProject) {
    if (!isCanonicalProjectId(mappedProject)) {
      conflicts.push("invalid_mapped_project_id");
    } else if (projectId && mappedProject !== projectId) {
      conflicts.push("conflicting_project_mapping");
    } else {
      projectId = mappedProject;
      warnings.push("project_resolved_from_alias_map");
    }
  }
  if (!projectId && legacyProject && !isProjectPath(legacyProject)) {
    if (isCanonicalProjectId(legacyProject)) {
      projectId = legacyProject;
    } else {
      conflicts.push("invalid_legacy_project_id");
    }
  }
  const projectResolvedWithoutTags = projectId !== undefined;
  if (!projectId) {
    if (validTagProjectIds.length > 1) {
      conflicts.push("conflicting_project_tags");
    } else if (validTagProjectIds[0]) {
      projectId = validTagProjectIds[0];
      warnings.push("project_resolved_from_tag");
    }
    if (invalidTagProjectIds.length > 0) {
      conflicts.push("invalid_project_tag");
    }
  } else {
    const contextualProjectTags = tagProjectIds.filter(
      (value) => value !== projectId,
    );
    if (contextualProjectTags.length > 0) {
      warnings.push("project_tags_retained_as_context");
    }
    if (invalidTagProjectIds.length > 0) {
      warnings.push("invalid_project_tag_ignored");
    }
  }
  if (!projectId && legacyProject && isProjectPath(legacyProject)) {
    const trimmedPath = legacyProject.replace(/[\\/]+$/, "");
    const inferred = win32.isAbsolute(legacyProject)
      ? win32.basename(trimmedPath)
      : basename(trimmedPath);
    if (isCanonicalProjectId(inferred)) {
      projectId = inferred;
      warnings.push("project_inferred_from_path");
    } else {
      conflicts.push("unresolved_project_path");
    }
  }
  if (!projectId) {
    const fallback = options.defaultProjectId ?? DEFAULT_ACTION_PROJECT_ID;
    if (isCanonicalProjectId(fallback)) {
      projectId = fallback;
      warnings.push("project_defaulted");
    } else {
      conflicts.push("invalid_default_project_id");
      projectId = DEFAULT_ACTION_PROJECT_ID;
    }
  }

  if (
    !projectResolvedWithoutTags &&
    projectId &&
    invalidTagProjectIds.length > 0 &&
    conflicts.includes("invalid_project_tag")
  ) {
    // An invalid tag remains a hard conflict when it was part of identity
    // resolution. Path inference or fallback must not silently hide it.
    warnings.push("project_identity_requires_review");
  }

  const projectAliases = new Set(
    normalizeStringArray(raw.projectAliases).filter(
      (alias) => alias !== projectId,
    ),
  );
  if (legacyProject && legacyProject !== projectId) {
    projectAliases.add(legacyProject);
  }

  const lifecycle = isActionLifecycle(raw.lifecycle)
    ? raw.lifecycle
    : lifecycleFromLegacyStatus(raw.status);

  const owner =
    nonEmpty(raw.owner) ??
    (raw.schemaVersion === ACTION_SCHEMA_VERSION
      ? undefined
      : nonEmpty(raw.assignedTo) ??
        firstTagValue(tags, "agent") ??
        (nonEmpty(raw.createdBy) === "unknown"
          ? undefined
          : nonEmpty(raw.createdBy)));

  const notBefore = typedOrTaggedTimestamp(
    raw.notBefore,
    raw.schemaVersion === ACTION_SCHEMA_VERSION
      ? undefined
      : firstTagValue(tags, "not-before"),
    "not_before",
    warnings,
    conflicts,
  );
  const dueAt = typedOrTaggedTimestamp(
    raw.dueAt,
    raw.schemaVersion === ACTION_SCHEMA_VERSION
      ? undefined
      : firstTagValue(tags, "due"),
    "due_at",
    warnings,
    conflicts,
  );

  const approval = normalizeApproval(raw.approval, warnings, conflicts);
  const waitTag = tags.some((tag) => HUMAN_WAIT_TAGS.has(tag.toLowerCase()));
  let awaitingHuman =
    typeof raw.awaitingHuman === "boolean" ? raw.awaitingHuman : waitTag;
  let normalizedApproval = approval;
  if (normalizedApproval?.state === "pending") awaitingHuman = true;
  if (
    normalizedApproval &&
    normalizedApproval.state !== "pending"
  ) {
    awaitingHuman = false;
  }
  if (awaitingHuman && !normalizedApproval) {
    normalizedApproval = {
      state: "pending",
      requestedAt: isValidActionTimestamp(raw.createdAt)
        ? raw.createdAt
        : undefined,
    };
    warnings.push("approval_inferred_from_wait_state");
  }

  let blockedReason = nonEmpty(raw.blockedReason);
  if (
    raw.schemaVersion !== ACTION_SCHEMA_VERSION &&
    raw.status === "blocked" &&
    !blockedReason &&
    !awaitingHuman &&
    !options.hasDerivedBlockers
  ) {
    blockedReason = "Legacy blocked state";
    warnings.push("manual_block_inferred");
  }

  const repoRoot =
    nonEmpty(raw.repoRoot) ??
    (legacyProject && isProjectPath(legacyProject)
      ? legacyProject
      : undefined);
  const worktree =
    nonEmpty(raw.worktree) ??
    (raw.schemaVersion === ACTION_SCHEMA_VERSION
      ? undefined
      : firstTagValue(tags, "worktree"));
  const branch =
    nonEmpty(raw.branch) ??
    (raw.schemaVersion === ACTION_SCHEMA_VERSION
      ? undefined
      : firstTagValue(tags, "branch"));
  const taskSlug =
    nonEmpty(raw.taskSlug) ??
    (raw.schemaVersion === ACTION_SCHEMA_VERSION
      ? undefined
      : firstTagValue(tags, "task_slug") ??
        firstTagValue(tags, "task-slug"));

  const action: Action = {
    ...raw,
    schemaVersion: ACTION_SCHEMA_VERSION,
    revision:
      options.revision ??
      (Number.isInteger(raw.revision) && (raw.revision ?? -1) >= 0
        ? raw.revision
        : 0),
    lifecycle,
    projectId,
    project: projectId,
    projectAliases: [...projectAliases].sort(),
    owner,
    notBefore,
    dueAt,
    awaitingHuman,
    approval: normalizedApproval,
    blockedReason,
    repoRoot,
    worktree,
    branch,
    taskSlug,
    status: legacyStatusFor({
      lifecycle,
      blockedReason,
      awaitingHuman,
      approval: normalizedApproval,
      hasDerivedBlockers: options.hasDerivedBlockers === true,
    }),
    tags,
    sourceObservationIds: normalizeStringArray(raw.sourceObservationIds),
    sourceMemoryIds: normalizeStringArray(raw.sourceMemoryIds),
  };

  return {
    action,
    changed: JSON.stringify(action) !== JSON.stringify(input),
    warnings: [...new Set(warnings)],
    conflicts: [...new Set(conflicts)],
  };
}

export function classifyAction(
  input: Action,
  context: ActionViewContext,
): ActionViewItem {
  const now = context.now ?? Date.now();
  const index = context.index ?? buildActionViewIndex(context);
  const actionEdges = index.edgesByActionId.get(input.id) ?? [];
  const { actionMap, checkpointMap, sentinelMap } = index;
  const hasDerivedBlockers = actionEdges.some(
    (edge) => {
      if (edge.sourceActionId !== input.id) return false;
      if (edge.type === "requires") {
        const dependency = actionMap.get(edge.targetActionId);
        return (dependency?.lifecycle ?? dependency?.status) !== "done";
      }
      if (edge.type === "gated_by") {
        return (
          checkpointMap.get(edge.targetActionId)?.status !== "passed" &&
          sentinelMap.get(edge.targetActionId)?.status !== "triggered"
        );
      }
      return false;
    },
  );
  const action = normalizeActionV2(input, { hasDerivedBlockers }).action;
  const lifecycle = action.lifecycle ?? lifecycleFromLegacyStatus(action.status);
  if (lifecycle === "done") {
    return { action, view: "completed", blockers: [], leased: false };
  }
  if (lifecycle === "cancelled") {
    return { action, view: "cancelled", blockers: [], leased: false };
  }

  const blockers: ActionBlocker[] = [];

  if (action.blockedReason) {
    blockers.push({ type: "manual", message: action.blockedReason });
  }
  if (action.approval?.state === "rejected") {
    blockers.push({
      type: "approval",
      message: action.approval.note || "Human approval was rejected",
    });
  }
  for (const edge of actionEdges) {
    if (edge.sourceActionId !== action.id) continue;
    if (edge.type === "requires") {
      const dependency = actionMap.get(edge.targetActionId);
      const dependencyLifecycle = dependency
        ? normalizeActionV2(dependency).action.lifecycle
        : undefined;
      if (dependencyLifecycle !== "done") {
        blockers.push({
          type: "requires",
          id: edge.targetActionId,
          message: dependency
            ? `Requires ${dependency.title}`
            : `Required action ${edge.targetActionId} is missing`,
        });
      }
    }
    if (edge.type === "gated_by") {
      const checkpoint = checkpointMap.get(edge.targetActionId);
      const sentinel = sentinelMap.get(edge.targetActionId);
      const passed =
        checkpoint?.status === "passed" || sentinel?.status === "triggered";
      if (!passed) {
        blockers.push({
          type: "checkpoint",
          id: edge.targetActionId,
          message: checkpoint
            ? `Checkpoint ${checkpoint.name} is ${checkpoint.status}`
            : sentinel
              ? `Sentinel ${sentinel.name} is ${sentinel.status}`
              : `Gate ${edge.targetActionId} is missing`,
        });
      }
    }
  }
  for (const edge of actionEdges) {
    if (edge.type !== "conflicts_with") continue;
    const otherId =
      edge.sourceActionId === action.id
        ? edge.targetActionId
        : edge.sourceActionId;
    const other = actionMap.get(otherId);
    const otherLifecycle = other
      ? normalizeActionV2(other).action.lifecycle
      : undefined;
    if (other && otherLifecycle === "active") {
      blockers.push({
        type: "conflict",
        id: other.id,
        message: `Conflicts with active action ${other.title}`,
      });
    }
  }

  const activeLease = index.activeLeaseMap.get(action.id);
  const leased = activeLease !== undefined;
  if (
    activeLease &&
    context.agentId &&
    activeLease.agentId !== context.agentId
  ) {
    blockers.push({
      type: "lease",
      id: activeLease.id,
      message: `Leased by ${activeLease.agentId}`,
    });
  }

  if (blockers.length > 0) {
    return { action, view: "blocked", blockers, leased };
  }
  if (action.awaitingHuman || action.approval?.state === "pending") {
    return { action, view: "waiting", blockers: [], leased };
  }
  if (action.notBefore) {
    const scheduledAt = Date.parse(action.notBefore);
    if (Number.isNaN(scheduledAt)) {
      return {
        action,
        view: "blocked",
        blockers: [
          {
            type: "schedule",
            message: "notBefore is not a valid timestamp",
          },
        ],
        leased,
      };
    }
    if (scheduledAt > now) {
      return { action, view: "scheduled", blockers: [], leased };
    }
  }
  return { action, view: "actionable", blockers: [], leased };
}

export function buildActionViewIndex(
  context: Omit<ActionViewContext, "index">,
): ActionViewIndex {
  const now = context.now ?? Date.now();
  const edgesByActionId = new Map<string, ActionEdge[]>();
  for (const edge of context.edges) {
    const sourceEdges = edgesByActionId.get(edge.sourceActionId) ?? [];
    sourceEdges.push(edge);
    edgesByActionId.set(edge.sourceActionId, sourceEdges);
    if (edge.targetActionId !== edge.sourceActionId) {
      const targetEdges = edgesByActionId.get(edge.targetActionId) ?? [];
      targetEdges.push(edge);
      edgesByActionId.set(edge.targetActionId, targetEdges);
    }
  }
  const activeLeaseMap = new Map<string, Lease>();
  for (const lease of context.leases) {
    if (
      lease.status === "active" &&
      Date.parse(lease.expiresAt) > now
    ) {
      activeLeaseMap.set(lease.actionId, lease);
    }
  }
  return {
    actionMap: new Map(
      context.actions.map((candidate) => [candidate.id, candidate]),
    ),
    edgesByActionId,
    checkpointMap: new Map(
      context.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
    ),
    sentinelMap: new Map(
      context.sentinels.map((sentinel) => [sentinel.id, sentinel]),
    ),
    activeLeaseMap,
  };
}

export function computeActionScore(
  action: Action,
  edges: ActionEdge[],
  now: number,
): number {
  let score = action.priority * 10;
  const createdAt = Date.parse(action.createdAt);
  if (!Number.isNaN(createdAt)) {
    const ageHours = (now - createdAt) / (1000 * 60 * 60);
    score += Math.min(Math.max(ageHours, 0) * 0.5, 20);
  }
  const unlockCount = edges.filter(
    (edge) => edge.sourceActionId === action.id && edge.type === "unlocks",
  ).length;
  score += unlockCount * 5;
  if (
    edges.some(
      (edge) =>
        edge.sourceActionId === action.id && edge.type === "spawned_by",
    )
  ) {
    score += 3;
  }
  if ((action.lifecycle ?? lifecycleFromLegacyStatus(action.status)) === "active") {
    score += 15;
  }
  if (action.dueAt) {
    const dueAt = Date.parse(action.dueAt);
    if (!Number.isNaN(dueAt)) {
      const remainingHours = (dueAt - now) / (1000 * 60 * 60);
      if (remainingHours <= 0) {
        score += 20;
      } else if (remainingHours <= 24) {
        score += 15 * (1 - remainingHours / 24);
      }
    }
  }
  return Math.round(score * 100) / 100;
}

export function actionFilterFingerprint(filters: Record<string, unknown>): string {
  const stable = Object.keys(filters)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const value = filters[key];
      if (value !== undefined) result[key] = value;
      return result;
    }, {});
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex")
    .slice(0, 16);
}

export function encodeActionCursor(
  revision: number,
  offset: number,
  filter: string,
  asOf: number,
): string {
  const payload: ActionCursorPayload = { v: 1, revision, offset, filter, asOf };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeActionCursor(cursor: string): ActionCursorPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<ActionCursorPayload>;
    if (
      parsed.v !== 1 ||
      !Number.isInteger(parsed.revision) ||
      parsed.revision! < 0 ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset! < 0 ||
      typeof parsed.filter !== "string" ||
      !parsed.filter ||
      !Number.isFinite(parsed.asOf) ||
      parsed.asOf! < 0
    ) {
      throw new Error("invalid payload");
    }
    return parsed as ActionCursorPayload;
  } catch {
    throw new Error("invalid_cursor");
  }
}

function lifecycleFromLegacyStatus(status: Action["status"]): ActionLifecycle {
  if (status === "active" || status === "done" || status === "cancelled") {
    return status;
  }
  return "pending";
}

function legacyStatusFor(input: {
  lifecycle: ActionLifecycle;
  blockedReason?: string;
  awaitingHuman: boolean;
  approval?: ActionApproval;
  hasDerivedBlockers: boolean;
}): Action["status"] {
  if (input.lifecycle !== "pending") return input.lifecycle;
  if (
    input.blockedReason ||
    input.awaitingHuman ||
    input.approval?.state === "pending" ||
    input.approval?.state === "rejected" ||
    input.hasDerivedBlockers
  ) {
    return "blocked";
  }
  return "pending";
}

function normalizeApproval(
  value: unknown,
  warnings: string[],
  conflicts: string[],
): ActionApproval | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    conflicts.push("invalid_approval");
    return undefined;
  }
  const approval = value as Partial<ActionApproval>;
  if (!isActionApprovalState(approval.state)) {
    conflicts.push("invalid_approval_state");
    return undefined;
  }
  const timestampFields = ["requestedAt", "decidedAt"] as const;
  for (const field of timestampFields) {
    const timestamp = approval[field];
    if (timestamp !== undefined && !isValidActionTimestamp(timestamp)) {
      conflicts.push(`invalid_approval_${field}`);
    }
  }
  if (
    approval.state === "pending" &&
    (approval.decidedAt || approval.decidedBy)
  ) {
    warnings.push("pending_approval_has_decision_metadata");
  }
  return {
    state: approval.state,
    requestedAt: nonEmpty(approval.requestedAt),
    requestedBy: nonEmpty(approval.requestedBy),
    decidedAt: nonEmpty(approval.decidedAt),
    decidedBy: nonEmpty(approval.decidedBy),
    note: nonEmpty(approval.note),
  };
}

function typedOrTaggedTimestamp(
  typed: unknown,
  tagged: string | undefined,
  field: string,
  warnings: string[],
  conflicts: string[],
): string | undefined {
  if (typed !== undefined) {
    if (isValidActionTimestamp(typed)) return typed;
    conflicts.push(`invalid_${field}`);
    return typeof typed === "string" ? typed : undefined;
  }
  if (!tagged) return undefined;
  if (isValidActionTimestamp(tagged)) {
    warnings.push(`${field}_migrated_from_tag`);
    return tagged;
  }
  warnings.push(`invalid_${field}_tag`);
  return undefined;
}

function uniqueTagValues(tags: string[], prefix: string): string[] {
  return [
    ...new Set(
      tags
        .map((tag) => tagValue(tag, prefix))
        .filter((value): value is string => value !== undefined),
    ),
  ];
}

function firstTagValue(tags: string[], prefix: string): string | undefined {
  return uniqueTagValues(tags, prefix)[0];
}

function tagValue(tag: string, prefix: string): string | undefined {
  const marker = `${prefix}:`;
  if (!tag.toLowerCase().startsWith(marker.toLowerCase())) return undefined;
  return nonEmpty(tag.slice(marker.length));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function isProjectPath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isActionReadinessView(
  value: unknown,
): value is ActionReadinessView {
  return (
    typeof value === "string" &&
    [
      "actionable",
      "scheduled",
      "waiting",
      "blocked",
      "completed",
      "cancelled",
    ].includes(value)
  );
}
