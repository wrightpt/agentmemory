import type {
  Action,
  ActionReadinessView,
  ActionViewItem,
  Checkpoint,
  Lease,
  Sentinel,
} from "../types.js";
import {
  actionFilterFingerprint,
  buildActionViewIndex,
  classifyAction,
  decodeActionCursor,
  encodeActionCursor,
  normalizeActionTags,
} from "./action-model.js";
import type { ActionStoreSnapshot } from "./action-store.js";

const DEFAULT_ACTION_LIMIT = 50;
const MAX_ACTION_LIMIT = 500;

export interface ActionListOptions {
  status?: string;
  project?: string;
  parentId?: string;
  tags?: string[];
  owner?: string;
  view?: ActionReadinessView;
  agentId?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
  revision?: number;
}

export interface ActionPage {
  success: true;
  actions: Action[];
  views: ActionViewItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  revision: number;
  nextCursor: string | null;
  asOf: string;
}

export class ActionQueryError extends Error {
  constructor(
    readonly code: "invalid_cursor" | "revision_conflict",
    message: string,
  ) {
    super(message);
    this.name = "ActionQueryError";
  }
}

export function selectActionPage(
  snapshot: ActionStoreSnapshot,
  checkpoints: Checkpoint[],
  sentinels: Sentinel[],
  leases: Lease[],
  options: ActionListOptions = {},
): ActionPage {
  const limit = normalizedLimit(options.limit);
  const filter = actionFilterFingerprint({
    status: options.status,
    project: options.project,
    parentId: options.parentId,
    tags: options.tags ? [...options.tags].sort() : undefined,
    owner: options.owner,
    view: options.view,
    agentId: options.agentId,
  });
  let offset = normalizedOffset(options.offset);
  let expectedRevision = options.revision;
  let asOf = Date.now();
  if (options.cursor) {
    let decoded;
    try {
      decoded = decodeActionCursor(options.cursor);
    } catch {
      throw new ActionQueryError("invalid_cursor", "cursor is invalid");
    }
    if (decoded.filter !== filter) {
      throw new ActionQueryError(
        "invalid_cursor",
        "cursor does not match the requested filters",
      );
    }
    offset = decoded.offset;
    asOf = decoded.asOf;
    if (
      expectedRevision !== undefined &&
      expectedRevision !== decoded.revision
    ) {
      throw new ActionQueryError(
        "revision_conflict",
        "cursor and explicit revision do not match",
      );
    }
    expectedRevision = decoded.revision;
  }
  if (
    expectedRevision !== undefined &&
    expectedRevision !== snapshot.state.revision
  ) {
    throw new ActionQueryError(
      "revision_conflict",
      `action collection changed from revision ${expectedRevision} to ${snapshot.state.revision}`,
    );
  }

  const viewContext = {
    actions: snapshot.actions,
    edges: snapshot.edges,
    checkpoints,
    sentinels,
    leases,
    agentId: options.agentId,
    now: asOf,
  };
  const index = buildActionViewIndex(viewContext);
  const views = snapshot.actions
    .map((action) =>
      classifyAction(action, {
        ...viewContext,
        index,
      }),
    )
    .filter((item) => {
      const action = item.action;
      if (options.status && action.status !== options.status) return false;
      if (options.project && !matchesActionProject(action, options.project)) {
        return false;
      }
      if (options.parentId && action.parentId !== options.parentId) return false;
      if (options.owner && action.owner !== options.owner) return false;
      if (options.view && item.view !== options.view) return false;
      if (options.tags && options.tags.length > 0) {
        const actionTags = normalizeActionTags(action.tags);
        if (!options.tags.some((tag) => actionTags.includes(tag))) return false;
      }
      return true;
    })
    .sort((left, right) => {
      const byUpdatedAt = String(right.action.updatedAt || "").localeCompare(
        String(left.action.updatedAt || ""),
      );
      return byUpdatedAt || left.action.id.localeCompare(right.action.id);
    });

  const pageViews = views.slice(offset, offset + limit);
  const nextOffset = offset + pageViews.length;
  const hasMore = nextOffset < views.length;
  return {
    success: true,
    actions: pageViews.map((item) => item.action),
    views: pageViews,
    total: views.length,
    limit,
    offset,
    hasMore,
    revision: snapshot.state.revision,
    asOf: new Date(asOf).toISOString(),
    nextCursor: hasMore
      ? encodeActionCursor(snapshot.state.revision, nextOffset, filter, asOf)
      : null,
  };
}

export function matchesActionProject(action: Action, project: string): boolean {
  return (
    action.projectId === project ||
    action.project === project ||
    (Array.isArray(action.projectAliases) &&
      action.projectAliases.includes(project))
  );
}

function normalizedLimit(value?: number): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return DEFAULT_ACTION_LIMIT;
  }
  return Math.min(value, MAX_ACTION_LIMIT);
}

function normalizedOffset(value?: number): number {
  return Number.isInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}
