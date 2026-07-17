import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type {
  ActionBlocker,
  ActionReadinessView,
  Checkpoint,
  Lease,
  Sentinel,
} from "../types.js";
import { classifyAction, computeActionScore } from "./action-model.js";
import { matchesActionProject } from "./action-query.js";
import { readActionStoreSnapshot } from "./action-store.js";

export interface FrontierItem {
  action: import("../types.js").Action;
  score: number;
  blockers: ActionBlocker[];
  leased: boolean;
  view: ActionReadinessView;
}

export function registerFrontierFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::frontier",
    async (data: {
      project?: string;
      agentId?: string;
      limit?: number;
      includeLeasedByOthers?: boolean;
    }) => {
      const [snapshot, leases, checkpoints, sentinels] = await Promise.all([
        readActionStoreSnapshot(kv),
        kv.list<Lease>(KV.leases).catch(() => []),
        kv.list<Checkpoint>(KV.checkpoints).catch(() => []),
        kv.list<Sentinel>(KV.sentinels).catch(() => []),
      ]);
      const now = Date.now();
      const frontier = snapshot.actions
        .filter(
          (action) =>
            !data.project || matchesActionProject(action, data.project),
        )
        .map((action) =>
          classifyAction(action, {
            actions: snapshot.actions,
            edges: snapshot.edges,
            checkpoints,
            sentinels,
            leases,
            agentId: data.includeLeasedByOthers ? undefined : data.agentId,
            now,
          }),
        )
        .filter((item) => item.view === "actionable")
        .map<FrontierItem>((item) => ({
          ...item,
          score: computeActionScore(item.action, snapshot.edges, now),
        }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.action.id.localeCompare(right.action.id),
        );
      const limit =
        Number.isInteger(data.limit) && (data.limit ?? 0) > 0
          ? Math.min(data.limit!, 500)
          : 20;
      return {
        success: true,
        frontier: frontier.slice(0, limit),
        totalActions: snapshot.actions.length,
        totalUnblocked: frontier.length,
        revision: snapshot.state.revision,
      };
    },
  );

  sdk.registerFunction(
    "mem::next",
    async (data: { project?: string; agentId?: string }) => {
      const result = await sdk.trigger<
        { project?: string; agentId?: string; limit?: number },
        {
          success: boolean;
          frontier: FrontierItem[];
          totalActions: number;
          totalUnblocked: number;
          revision: number;
        }
      >({
        function_id: "mem::frontier",
        payload: { project: data.project, agentId: data.agentId, limit: 1 },
      });

      if (!result.success) {
        return {
          success: false,
          suggestion: null,
          message: "Failed to compute frontier",
          totalActions: 0,
        };
      }
      if (result.frontier.length === 0) {
        return {
          success: true,
          suggestion: null,
          message: "No actionable work found",
          totalActions: result.totalActions || 0,
          totalUnblocked: 0,
          revision: result.revision,
        };
      }

      const top = result.frontier[0];
      return {
        success: true,
        suggestion: {
          actionId: top.action.id,
          title: top.action.title,
          description: top.action.description,
          priority: top.action.priority,
          score: top.score,
          tags: top.action.tags,
          view: top.view,
          dueAt: top.action.dueAt,
          owner: top.action.owner,
        },
        message: `Suggested: ${top.action.title} (priority ${top.action.priority}, score ${top.score.toFixed(2)})`,
        totalActions: result.totalActions,
        totalUnblocked: result.totalUnblocked,
        revision: result.revision,
      };
    },
  );
}
