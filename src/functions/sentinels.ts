import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { Action, ActionEdge, CompressedObservation, FunctionMetrics, Sentinel, Session } from "../types.js";
import { recordAudit } from "./audit.js";
import { persistActionEdge } from "./action-store.js";
import { refreshLinkedActionReadiness } from "./action-readiness-refresh.js";

const VALID_TYPES: Sentinel["type"][] = [
  "webhook",
  "timer",
  "threshold",
  "pattern",
  "approval",
  "custom",
];

export function registerSentinelsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::sentinel-create", 
    async (data: {
      name: string;
      type: Sentinel["type"];
      config?: Record<string, unknown>;
      linkedActionIds?: string[];
      expiresInMs?: number;
    }) => {
      if (!data.name || typeof data.name !== "string") {
        return { success: false, error: "name is required" };
      }
      if (!data.type || !VALID_TYPES.includes(data.type)) {
        return {
          success: false,
          error: `type must be one of: ${VALID_TYPES.join(", ")}`,
        };
      }

      if (data.type === "threshold") {
        const cfg = data.config as
          | { metric?: string; operator?: string; value?: number }
          | undefined;
        if (
          !cfg ||
          !cfg.metric ||
          !["gt", "lt", "eq"].includes(cfg.operator || "") ||
          typeof cfg.value !== "number"
        ) {
          return {
            success: false,
            error:
              "threshold config requires metric, operator (gt|lt|eq), and numeric value",
          };
        }
      }

      if (data.type === "pattern") {
        const cfg = data.config as { pattern?: string } | undefined;
        if (!cfg || !cfg.pattern || typeof cfg.pattern !== "string") {
          return {
            success: false,
            error: "pattern config requires a pattern string",
          };
        }
      }

      if (data.type === "webhook") {
        const cfg = data.config as { path?: string } | undefined;
        if (!cfg || !cfg.path || typeof cfg.path !== "string") {
          return {
            success: false,
            error: "webhook config requires a path string",
          };
        }
      }

      if (data.type === "timer") {
        const cfg = data.config as { durationMs?: number } | undefined;
        if (!cfg || typeof cfg.durationMs !== "number" || cfg.durationMs <= 0) {
          return {
            success: false,
            error: "timer config requires a positive durationMs",
          };
        }
      }

      if (data.linkedActionIds && data.linkedActionIds.length > 0) {
        for (const actionId of data.linkedActionIds) {
          const action = await kv.get<Action>(KV.actions, actionId);
          if (!action) {
            return {
              success: false,
              error: `linked action not found: ${actionId}`,
            };
          }
        }
      }

      const now = new Date();
      const sentinel: Sentinel = {
        id: generateId("snl"),
        name: data.name.trim(),
        type: data.type,
        status: "watching",
        config: data.config || {},
        createdAt: now.toISOString(),
        linkedActionIds: data.linkedActionIds || [],
        expiresAt: data.expiresInMs
          ? new Date(now.getTime() + data.expiresInMs).toISOString()
          : undefined,
      };

      await kv.set(KV.sentinels, sentinel.id, sentinel);
      await recordAudit(kv, "sentinel_create", "mem::sentinel-create", [sentinel.id], {
        action: "sentinel.create",
        type: sentinel.type,
        linkedActionIds: sentinel.linkedActionIds,
      });

      if (data.linkedActionIds && data.linkedActionIds.length > 0) {
        for (const actionId of data.linkedActionIds) {
          const edge: ActionEdge = {
            id: generateId("ae"),
            type: "gated_by",
            sourceActionId: actionId,
            targetActionId: sentinel.id,
            createdAt: now.toISOString(),
          };
          await persistActionEdge(kv, edge, {
            actor: "sentinel-create",
            before: null,
            reason: `Sentinel ${sentinel.id} gate added`,
          });
          await recordAudit(kv, "sentinel_create", "mem::sentinel-create", [edge.id], {
            action: "sentinel.create.edge",
            sentinelId: sentinel.id,
            sourceActionId: actionId,
          });
        }
        await refreshLinkedActionReadiness(
          kv,
          data.linkedActionIds,
          "sentinel-create",
          `Sentinel ${sentinel.id} gate added`,
        );
      }

      if (data.type === "timer") {
        const durationMs = (data.config as { durationMs: number }).durationMs;
        setTimeout(async () => {
          try {
            await withKeyedLock(`mem:sentinel:${sentinel.id}`, async () => {
              const fresh = await kv.get<Sentinel>(KV.sentinels, sentinel.id);
              if (!fresh || fresh.status !== "watching") return;
              fresh.status = "triggered";
              fresh.triggeredAt = new Date().toISOString();
              fresh.result = { reason: "timer_elapsed", durationMs };
              await kv.set(KV.sentinels, fresh.id, fresh);
              await recordAudit(kv, "sentinel_trigger", "mem::sentinel-create", [fresh.id], {
                action: "sentinel.timer_trigger",
                reason: "timer_elapsed",
                durationMs,
              });
              await refreshLinkedActionReadiness(
                kv,
                fresh.linkedActionIds,
                "sentinel-timer",
                `Sentinel ${fresh.id} triggered`,
              );
            });
          } catch (err) {
            console.error("sentinel timer callback failed", sentinel.id, err);
          }
        }, durationMs);
      }

      return { success: true, sentinel };
    },
  );

  sdk.registerFunction("mem::sentinel-trigger", 
    async (data: { sentinelId: string; result?: unknown }) => {
      if (!data.sentinelId) {
        return { success: false, error: "sentinelId is required" };
      }

      return withKeyedLock(
        `mem:sentinel:${data.sentinelId}`,
        async () => {
          const sentinel = await kv.get<Sentinel>(
            KV.sentinels,
            data.sentinelId,
          );
          if (!sentinel) {
            return { success: false, error: "sentinel not found" };
          }
          if (sentinel.status !== "watching") {
            return {
              success: false,
              error: `sentinel already ${sentinel.status}`,
            };
          }

          sentinel.status = "triggered";
          sentinel.triggeredAt = new Date().toISOString();
          sentinel.result = data.result;

          await kv.set(KV.sentinels, sentinel.id, sentinel);
          await recordAudit(kv, "sentinel_trigger", "mem::sentinel-trigger", [sentinel.id], {
            action: "sentinel.trigger",
            result: data.result,
          });

          const unblockedCount = await refreshLinkedActionReadiness(
            kv,
            sentinel.linkedActionIds,
            "sentinel-trigger",
            `Sentinel ${sentinel.id} triggered`,
          );

          return { success: true, sentinel, unblockedCount };
        },
      );
    },
  );

  sdk.registerFunction("mem::sentinel-check", 
    async () => {
      const sentinels = await kv.list<Sentinel>(KV.sentinels);
      const active = sentinels.filter((s) => s.status === "watching");
      const triggered: string[] = [];

      for (const sentinel of active) {
        if (sentinel.type === "threshold") {
          const cfg = sentinel.config as {
            metric: string;
            operator: "gt" | "lt" | "eq";
            value: number;
          };
          const metrics = await kv.get<FunctionMetrics>(
            KV.metrics,
            cfg.metric,
          );
          if (!metrics) continue;

          const current = metrics.totalCalls;
          let matched = false;
          if (cfg.operator === "gt") matched = current > cfg.value;
          else if (cfg.operator === "lt") matched = current < cfg.value;
          else if (cfg.operator === "eq") matched = current === cfg.value;

          if (matched) {
            await withKeyedLock(
              `mem:sentinel:${sentinel.id}`,
              async () => {
                const fresh = await kv.get<Sentinel>(
                  KV.sentinels,
                  sentinel.id,
                );
                if (!fresh || fresh.status !== "watching") return;
                fresh.status = "triggered";
                fresh.triggeredAt = new Date().toISOString();
                fresh.result = {
                  reason: "threshold_crossed",
                  metric: cfg.metric,
                  currentValue: current,
                  threshold: cfg.value,
                  operator: cfg.operator,
                };
                await kv.set(KV.sentinels, fresh.id, fresh);
                await recordAudit(kv, "sentinel_trigger", "mem::sentinel-check", [fresh.id], {
                  action: "sentinel.threshold_trigger",
                  result: fresh.result,
                });
                await refreshLinkedActionReadiness(
                  kv,
                  fresh.linkedActionIds,
                  "sentinel-check",
                  `Sentinel ${fresh.id} threshold triggered`,
                );
              },
            );
            triggered.push(sentinel.id);
          }
        }

        if (sentinel.type === "pattern") {
          const cfg = sentinel.config as { pattern: string };
          const regex = new RegExp(cfg.pattern, "i");
          const sessions = await kv.list<Session>(KV.sessions);
          let matchedObs: CompressedObservation | null = null;

          for (const session of sessions) {
            const observations = await kv.list<CompressedObservation>(
              KV.observations(session.id),
            );
            const recent = observations
              .filter(
                (o) =>
                  new Date(o.timestamp).getTime() >=
                  new Date(sentinel.createdAt).getTime(),
              )
              .find((o) => regex.test(o.title));
            if (recent) {
              matchedObs = recent;
              break;
            }
          }

          if (matchedObs) {
            await withKeyedLock(
              `mem:sentinel:${sentinel.id}`,
              async () => {
                const fresh = await kv.get<Sentinel>(
                  KV.sentinels,
                  sentinel.id,
                );
                if (!fresh || fresh.status !== "watching") return;
                fresh.status = "triggered";
                fresh.triggeredAt = new Date().toISOString();
                fresh.result = {
                  reason: "pattern_matched",
                  pattern: cfg.pattern,
                  matchedObservationId: matchedObs!.id,
                  matchedTitle: matchedObs!.title,
                };
                await kv.set(KV.sentinels, fresh.id, fresh);
                await recordAudit(kv, "sentinel_trigger", "mem::sentinel-check", [fresh.id], {
                  action: "sentinel.pattern_trigger",
                  result: fresh.result,
                });
                await refreshLinkedActionReadiness(
                  kv,
                  fresh.linkedActionIds,
                  "sentinel-check",
                  `Sentinel ${fresh.id} pattern triggered`,
                );
              },
            );
            triggered.push(sentinel.id);
          }
        }
      }

      return { success: true, triggered, checkedCount: active.length };
    },
  );

  sdk.registerFunction("mem::sentinel-cancel", 
    async (data: { sentinelId: string }) => {
      if (!data.sentinelId) {
        return { success: false, error: "sentinelId is required" };
      }

      return withKeyedLock(
        `mem:sentinel:${data.sentinelId}`,
        async () => {
          const sentinel = await kv.get<Sentinel>(
            KV.sentinels,
            data.sentinelId,
          );
          if (!sentinel) {
            return { success: false, error: "sentinel not found" };
          }
          if (sentinel.status !== "watching") {
            return {
              success: false,
              error: `cannot cancel sentinel with status ${sentinel.status}`,
            };
          }

          sentinel.status = "cancelled";
          await kv.set(KV.sentinels, sentinel.id, sentinel);
          await recordAudit(kv, "sentinel_trigger", "mem::sentinel-cancel", [sentinel.id], {
            action: "sentinel.cancel",
            status: "cancelled",
          });
          await refreshLinkedActionReadiness(
            kv,
            sentinel.linkedActionIds,
            "sentinel-cancel",
            `Sentinel ${sentinel.id} cancelled`,
          );

          return { success: true, sentinel };
        },
      );
    },
  );

  sdk.registerFunction("mem::sentinel-list", 
    async (data: { status?: string; type?: string }) => {
      let sentinels = await kv.list<Sentinel>(KV.sentinels);

      if (data.status) {
        sentinels = sentinels.filter((s) => s.status === data.status);
      }
      if (data.type) {
        sentinels = sentinels.filter((s) => s.type === data.type);
      }

      sentinels.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      return { success: true, sentinels };
    },
  );

  sdk.registerFunction("mem::sentinel-expire", 
    async () => {
      const sentinels = await kv.list<Sentinel>(KV.sentinels);
      const now = Date.now();
      let expired = 0;

      for (const sentinel of sentinels) {
        if (
          sentinel.status === "watching" &&
          sentinel.expiresAt &&
          new Date(sentinel.expiresAt).getTime() <= now
        ) {
          const didExpire = await withKeyedLock(
            `mem:sentinel:${sentinel.id}`,
            async () => {
              const fresh = await kv.get<Sentinel>(
                KV.sentinels,
                sentinel.id,
              );
              if (!fresh || fresh.status !== "watching") return false;
              fresh.status = "expired";
              fresh.triggeredAt = new Date().toISOString();
              await kv.set(KV.sentinels, fresh.id, fresh);
              await recordAudit(kv, "sentinel_trigger", "mem::sentinel-expire", [fresh.id], {
                action: "sentinel.expire",
                status: "expired",
              });
              await refreshLinkedActionReadiness(
                kv,
                fresh.linkedActionIds,
                "sentinel-expire",
                `Sentinel ${fresh.id} expired`,
              );
              return true;
            },
          );
          if (didExpire) expired++;
        }
      }

      return { success: true, expired };
    },
  );
}
