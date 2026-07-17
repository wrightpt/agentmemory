import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV } from "../state/schema.js";
import type {
  Action,
  ActionEdge,
  Checkpoint,
  Sentinel,
} from "../types.js";
import { persistAction } from "./action-store.js";

/**
 * Re-project linked actions after a checkpoint or sentinel changes state.
 * The touch event is deliberate: readiness-view cursors are bound to the
 * action collection revision, so an external gate transition must advance it.
 */
export async function refreshLinkedActionReadiness(
  kv: StateKV,
  actionIds: string[],
  actor: string,
  reason: string,
): Promise<number> {
  const uniqueActionIds = [...new Set(actionIds)];
  if (uniqueActionIds.length === 0) return 0;
  const [edges, actions, checkpoints, sentinels] = await Promise.all([
    kv.list<ActionEdge>(KV.actionEdges).catch(() => []),
    kv.list<Action>(KV.actions).catch(() => []),
    kv.list<Checkpoint>(KV.checkpoints).catch(() => []),
    kv.list<Sentinel>(KV.sentinels).catch(() => []),
  ]);
  const actionMap = new Map(actions.map((action) => [action.id, action]));
  const checkpointMap = new Map(
    checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
  );
  const sentinelMap = new Map(
    sentinels.map((sentinel) => [sentinel.id, sentinel]),
  );
  let unblockedCount = 0;

  for (const actionId of uniqueActionIds) {
    await withKeyedLock(`mem:action:${actionId}`, async () => {
      const action = await kv.get<Action>(KV.actions, actionId);
      if (!action) return;
      const lifecycle =
        action.lifecycle ??
        (action.status === "active" ||
          action.status === "done" ||
          action.status === "cancelled"
          ? action.status
          : "pending");
      if (lifecycle === "done" || lifecycle === "cancelled") return;

      const relevantEdges = edges.filter(
        (edge) => edge.sourceActionId === actionId,
      );
      const hasDerivedBlockers = relevantEdges.some((edge) => {
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
      });

      const before = structuredClone(action);
      if (lifecycle === "pending") {
        action.lifecycle = "pending";
        action.status = hasDerivedBlockers ? "blocked" : "pending";
      }
      action.updatedAt = new Date().toISOString();
      const persisted = await persistAction(kv, action, {
        actor,
        before,
        hasDerivedBlockers,
        reason,
      });
      actionMap.set(action.id, persisted.action);
      if (before.status === "blocked" && persisted.action.status !== "blocked") {
        unblockedCount += 1;
      }
    });
  }

  return unblockedCount;
}
