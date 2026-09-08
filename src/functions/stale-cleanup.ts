import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { MAINTENANCE_REFERENCE_SCOPES } from "../state/maintenance-barrier.js";
import { recordAudit } from "./audit.js";
import { flushIndexSave, getSearchIndex, vectorIndexRemove } from "./search.js";
import {
  STALE_DELETE_PROTOCOL, MIN_IDLE_MS, fingerprint, validRequest, validRows,
  memoryRetentionReason, leaseRetentionReason, type CleanupRow,
} from "./stale-cleanup-policy.js";

export function registerStaleCleanupFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::maintenance-stale-delete", async (data: unknown) => {
    if (data && typeof data === "object" && "kind" in data && data.kind === "capabilities"
      && "protocol" in data && data.protocol === STALE_DELETE_PROTOCOL) {
      return {
        success: true, protocol: STALE_DELETE_PROTOCOL, minIdleMs: MIN_IDLE_MS,
        conditional: true, requiresReconciliation: kv.maintenanceBarrier.needsReconciliation,
      };
    }
    const now = Date.now();
    if (!validRequest(data, now)) return { success: false, error: "invalid_stale_delete_request" };
    const { kind, id, cutoff, expectedFingerprint } = data;
    const receipt = { success: true, protocol: STALE_DELETE_PROTOCOL, kind, id };
    const retained = (reason: string) => ({ ...receipt, outcome: "retained", deleted: 0, reason });
    const revision = kv.maintenanceBarrier.snapshot();
    const scope = kind === "memory" ? KV.memories : KV.leases;
    const row = await kv.get<CleanupRow>(scope, id);
    if (!row) return retained("missing");
    if (row.id !== id || fingerprint(row) !== expectedFingerprint) return retained("changed");
    const cutoffMs = Date.parse(cutoff);
    if (kind === "memory") {
      const access = await kv.get(KV.accessLog, id);
      const reason = memoryRetentionReason(row, access, cutoffMs);
      if (reason) return retained(reason);
      for (const referenceScope of MAINTENANCE_REFERENCE_SCOPES) {
        const maximum = referenceScope === KV.memories ? 5000 : 20000;
        const rows = validRows(await kv.list(referenceScope), maximum);
        if (rows.some(other => !(referenceScope === KV.memories && other.id === id)
          && JSON.stringify(other).includes(id))) return retained("referenced");
      }
    } else {
      const action = typeof row.actionId === "string" ? await kv.get(KV.actions, row.actionId) : undefined;
      const reason = leaseRetentionReason(row, action, cutoffMs);
      if (reason) return retained(reason);
    }

    const committed = await kv.maintenanceBarrier.tryCommit(revision, async invalidate => {
      await recordAudit(kv, "delete", "mem::maintenance-stale-delete", [id], {
        phase: "intent", protocol: STALE_DELETE_PROTOCOL, kind, cutoff, expectedFingerprint,
      });
      invalidate(id);
      await kv.delete(scope, id);
      if (kind === "memory") {
        // Per-access keyed locks can be held by a writer waiting at this barrier.
        await kv.delete(KV.accessLog, id);
        getSearchIndex().remove(id);
        await vectorIndexRemove(id);
        await flushIndexSave();
      }
      await recordAudit(kv, "delete", "mem::maintenance-stale-delete", [id], {
        phase: "completed", protocol: STALE_DELETE_PROTOCOL, kind, cutoff,
      });
      return { ...receipt, outcome: "deleted", deleted: 1 };
    });
    return committed.committed ? committed.value
      : retained(kv.maintenanceBarrier.needsReconciliation ? "state-write-uncertain" : "concurrent-write");
  });
}
