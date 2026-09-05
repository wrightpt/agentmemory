// Run in an isolated network namespace; this creates only synthetic state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { registerWorker } from "iii-sdk";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import type { ActionEvent, AuditEntry } from "../src/types.js";
import {
  getActionEvent, listActionEvents, listActionEventsForAction, listAuditEntries,
  writeActionEvent, writeAuditEntry,
} from "../src/state/partitioned-ledgers.js";

const out = path.resolve(process.argv[2] ?? "");
assert(process.argv[2] && !fs.existsSync(out), "provide a new output directory");
fs.mkdirSync(out, { recursive: true });
const binary = "/home/cp/.local/bin/iii";
assert.equal(createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
  "03a2d645c16dc9502fb6a694bb2b16465f6772cbe7c65baa15e3adbf3f021bb7");
const config = path.join(out, "config.json");
fs.writeFileSync(config, JSON.stringify({ workers: [
  { name: "iii-worker-manager", config: { host: "127.0.0.1", port: 41179 } },
  { name: "iii-state", config: { adapter: { name: "kv", config: {
    store_method: "file_based", file_path: path.join(out, "state"), save_interval_ms: 5000,
  } } } },
  { name: "iii-observability", config: { enabled: true, exporter: "memory",
    service_name: "synthetic-ledger-verification", sampling_ratio: 0.1,
    metrics_enabled: true, logs_enabled: false, logs_console_output: false } },
  { name: "iii-telemetry", config: { enabled: false } },
] }));

let child: ReturnType<typeof spawn> | undefined;
let sdk: ReturnType<typeof registerWorker> | undefined;
let kv: StateKV;
const starts: number[] = [];
async function stop() {
  await sdk?.shutdown();
  sdk = undefined;
  if (!child) return;
  const owned = child;
  if (owned.exitCode === null && owned.signalCode === null) {
    const exited = once(owned, "exit");
    owned.kill("SIGTERM");
    const timer = setTimeout(() => owned.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  child = undefined;
}
async function start() {
  const log = fs.openSync(path.join(out, `engine-${starts.length + 1}.log`), "w");
  child = spawn("prlimit", ["--as=1073741824", "--cpu=20:25", "--fsize=16777216",
    "--nofile=256", "--", binary, "--no-update-check", "--config", config], {
    cwd: out, env: { PATH: process.env.PATH, HOME: process.env.HOME,
      III_TELEMETRY_ENABLED: "false", OTEL_ENABLED: "false", CI: "true" },
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  assert(child.pid);
  starts.push(child.pid);
  await sleep(1000);
  assert.equal(child.exitCode, null, "synthetic engine exited before readiness");
  sdk = registerWorker("ws://127.0.0.1:41179", { workerName: "synthetic-ledger-check",
    enableMetricsReporting: false, otel: { enabled: false },
    invocationTimeoutMs: 5000, reconnectionConfig: { maxRetries: 0 } });
  kv = new StateKV(sdk);
  await sdk.listWorkers();
}
const event = (id: string, actionId: string, revision: number): ActionEvent => ({
  schemaVersion: 2, id, actionId, entityType: "action", revision,
  type: revision === 1 ? "created" : "fields_changed", actor: "synthetic-check",
  timestamp: "2026-09-05T00:00:00.000Z",
});
const initial = event("initial", "synthetic-existing", 1);
const audit: AuditEntry = { id: "audit-old", timestamp: initial.timestamp,
  operation: "observe", functionId: "synthetic::check", targetIds: [], details: {} };
const watchdog = setTimeout(() => child?.kill("SIGKILL"), 45000);
let success = false;
try {
  await start();
  await kv!.set(KV.actionEvents, initial.id, initial);
  await kv!.set(KV.audit, audit.id, audit);
  for (let i = 0; i < 64; i++) {
    await writeActionEvent(kv!, event(`new-${i}`, `synthetic-${i}`, i + 2));
  }
  await writeActionEvent(kv!, event("partitioned-update", initial.actionId, 66));
  await writeActionEvent(kv!, event("imported-update", initial.actionId, 67), { imported: true });
  await writeAuditEntry(kv!, { ...audit, id: "audit-new" });
  await sleep(5500);
  await stop();
  await start();
  assert.equal((await listActionEvents(kv!)).length, 67);
  assert.equal((await listAuditEntries(kv!)).length, 2);
  process.env.AGENTMEMORY_LEDGER_WRITE_MODE = "legacy";
  await writeActionEvent(kv!, event("rollback-update", initial.actionId, 68));
  delete process.env.AGENTMEMORY_LEDGER_WRITE_MODE;
  await writeActionEvent(kv!, event("reactivated-update", initial.actionId, 69));
  await sleep(5500);
  await stop();
  await start();
  assert.equal((await listActionEvents(kv!)).length, 69);
  assert.deepEqual((await listActionEventsForAction(kv!, initial.actionId)).map(x => x.id),
    ["initial", "partitioned-update", "imported-update", "rollback-update", "reactivated-update"]);
  assert.equal((await getActionEvent(kv!, "imported-update", {
    actionId: "synthetic-altered", timestamp: "2030-01-01T00:00:00.000Z",
  }))?.actionId, initial.actionId);
  assert.equal((await kv!.list(KV.actionEvents)).length, 2);
  success = true;
} finally {
  clearTimeout(watchdog);
  delete process.env.AGENTMEMORY_LEDGER_WRITE_MODE;
  await stop();
  const result = { success, engineStarts: starts, allOwnedChildrenGone:
    starts.every(pid => !fs.existsSync(`/proc/${pid}`)), events: 69, audits: 2 };
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
