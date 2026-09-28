import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISdk } from "iii-sdk";
import type { StateKV } from "../src/state/kv.js";
import type { DedupMap } from "../src/functions/dedup.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const sideEffects = vi.hoisted(() => ({
  index: vi.fn(), saveIndex: vi.fn(), vector: vi.fn(), image: vi.fn(), audit: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  getAgentId: vi.fn(() => "capture-fixture"), getEnvVar: vi.fn(() => undefined),
  isAutoCompressEnabled: vi.fn(() => false),
}));
vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: sideEffects.index }), scheduleIndexSave: sideEffects.saveIndex,
  vectorIndexAddGuarded: sideEffects.vector,
}));
vi.mock("../src/utils/image-store.js", () => ({ saveImageToDisk: sideEffects.image }));
vi.mock("../src/functions/audit.js", () => ({ safeAudit: sideEffects.audit }));
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../src/replay/jsonl-parser.js", async (original) => {
  const module = await original<typeof import("../src/replay/jsonl-parser.js")>();
  return { ...module, parseJsonlText: vi.fn(module.parseJsonlText) };
});
vi.mock("../src/functions/compress-synthetic.js", async (original) => {
  const module = await original<typeof import("../src/functions/compress-synthetic.js")>();
  return { ...module, buildSyntheticCompression: vi.fn(module.buildSyntheticCompression) };
});

import { containsFindingCapture, FINDING_CAPTURE_EXCLUDED } from "../src/findings/capture.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerReplayFunctions } from "../src/functions/replay.js";
import { parseJsonlText } from "../src/replay/jsonl-parser.js";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";
import { KV } from "../src/state/schema.js";

const RESTRICTED = "withheld-post-freeze-outcome";
const marked = { findingSurface: "verified-shared-findings-v1", success: true, raw: RESTRICTED };
const time = "2026-09-28T01:00:00.000Z";
const roots: string[] = [];

function context() {
  const kv = mockKV();
  const sdk = mockSdk();
  const calls = vi.spyOn(sdk, "trigger");
  const writes = vi.spyOn(kv, "set");
  const reads = vi.spyOn(kv, "get");
  const dedup = { computeHash: vi.fn(() => "dedup"), isDuplicate: vi.fn(() => false), record: vi.fn() };
  for (const name of ["stream::set", "stream::send", "mem::compress"]) sdk.registerFunction(name, async () => ({}));
  registerObserveFunction(sdk as unknown as ISdk, kv as unknown as StateKV, dedup as unknown as DedupMap);
  registerReplayFunctions(sdk as unknown as ISdk, kv as unknown as StateKV);
  return { sdk, kv, calls, writes, reads, dedup };
}

function payload(data: unknown) {
  return { sessionId: "capture-session", project: "fixture", cwd: "/fixture", hookType: "post_tool_use", timestamp: time, data };
}

function transcript(sessionId: string, output: unknown = "ordinary output") {
  return [
    { type: "user", sessionId, timestamp: time, cwd: "/fixture", message: { role: "user", content: "ordinary first prompt" } },
    { type: "user", sessionId, timestamp: time, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: output }] } },
    { type: "assistant", sessionId, timestamp: time, message: { role: "assistant", content: "ordinary final text" } },
  ].map((row) => JSON.stringify(row)).join("\n");
}

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "finding-capture-"));
  roots.push(root);
  return root;
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("finding capture detection", () => {
  it.each([
    marked,
    { content: [{ type: "text", text: JSON.stringify(marked) }] },
    "lsn_fnd_0123456789abcdef", "fsnap_0123456789abcdef",
    "curl http://127.0.0.1:3111/agentmemory/findings/expand",
    "npm run findings -- snapshot", "npm run --silent findings -- expand", "pnpm findings snapshot",
    "node scripts/shared-findings.ts expand", "agentmemory findings snapshot",
    { function_id: "mem::finding-prepare" }, { tool_name: "memory_finding_expand" },
    '{"findingSurface":"\\u0076erified-shared-findings-v1"}',
    "curl http:\\/\\/localhost\\/agentmemory\\/findings\\/expand",
    '{"command":"npm\\nrun\\nfindings -- snapshot"}',
  ])("detects findings in structured and serialized capture %#", (value) => {
    expect(containsFindingCapture(value)).toBe(true);
  });

  it("does not reject ordinary findings prose, ordinary IDs, or repeated plain objects", () => {
    for (const value of ["These are ordinary findings.", "lsn_1234567890", "Review a snapshot", { raw: "ordinary output" }]) {
      expect(containsFindingCapture(value)).toBe(false);
    }
    const shared = { output: "ordinary" };
    expect(containsFindingCapture([shared, shared])).toBe(false);
  });

  it("scans late fields and fails closed without evaluating getters", () => {
    expect(containsFindingCapture("x".repeat(200_000) + JSON.stringify(marked))).toBe(true);
    const read = vi.fn(() => RESTRICTED);
    expect(containsFindingCapture(Object.defineProperty({}, "raw", { get: read }))).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("ordinary observation capture exclusion", () => {
  it.each([
    { tool_name: "Bash", tool_input: { command: "curl /agentmemory/findings/expand" }, tool_output: RESTRICTED },
    { tool_name: "Bash", tool_output: JSON.stringify(marked) },
    { tool_name: "HTTP", tool_output: { content: [{ text: JSON.stringify(marked) }] } },
    { prompt: "Reuse lsn_fnd_0123456789abcdef: " + RESTRICTED },
    { tool_name: "Read", tool_output: { raw: RESTRICTED, snapshotId: "fsnap_abcdef" } },
  ])("skips marked content before all persistence, dedup, images and model/index work %#", async (data) => {
    const { sdk, calls, writes, reads, dedup } = context();
    const result = await sdk.trigger("mem::observe", payload(data));
    expect(result).toEqual({ success: true, skipped: true, reason: FINDING_CAPTURE_EXCLUDED });
    expect(JSON.stringify(result)).not.toContain(RESTRICTED);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
    expect(dedup.computeHash).not.toHaveBeenCalled();
    expect(dedup.record).not.toHaveBeenCalled();
    expect(buildSyntheticCompression).not.toHaveBeenCalled();
    for (const effect of Object.values(sideEffects)) expect(effect).not.toHaveBeenCalled();
  });

  it("checks session metadata before it can enter an implicit session record", async () => {
    const { sdk, writes } = context();
    const result = await sdk.trigger("mem::observe", { ...payload({ prompt: "ordinary" }), missionTitle: "fsnap_abc " + RESTRICTED });
    expect(result).toMatchObject({ skipped: true, reason: FINDING_CAPTURE_EXCLUDED });
    expect(writes).not.toHaveBeenCalled();
  });

  it("preserves ordinary observation storage, synthetic compression and indexing", async () => {
    const { sdk, kv, writes, dedup } = context();
    const result = await sdk.trigger("mem::observe", payload({ tool_name: "Edit", tool_output: "ordinary output" }));
    expect(result).toHaveProperty("observationId");
    expect(writes).toHaveBeenCalled();
    expect(dedup.record).toHaveBeenCalled();
    expect(buildSyntheticCompression).toHaveBeenCalledOnce();
    expect(sideEffects.index).toHaveBeenCalledOnce();
    expect(await kv.list(KV.observations("capture-session"))).toHaveLength(1);
  });
});

describe("replay finding capture exclusion", () => {
  it.each(["normal", "malformed", "unicode"])("skips entire %s marked transcript before parsing or any writes", async (variant) => {
    const { sdk, writes, calls } = context();
    const root = await directory();
    let text = transcript("marked-session", marked);
    if (variant === "malformed") text = transcript("marked-session") + "\nnot valid JSON " + JSON.stringify(marked);
    if (variant === "unicode") text = text.replace("verified-shared-findings-v1", "\\u0076erified-shared-findings-v1");
    const path = join(root, "transcript.jsonl");
    await writeFile(path, text);
    const result = await sdk.trigger("mem::replay::import-jsonl", { path });
    expect(result).toMatchObject({ success: true, imported: 0, sessionIds: [], observations: 0, skipped: { count: 1, reason: FINDING_CAPTURE_EXCLUDED } });
    expect(JSON.stringify(result)).not.toContain(RESTRICTED);
    expect(parseJsonlText).not.toHaveBeenCalled();
    expect(buildSyntheticCompression).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(calls).toHaveBeenCalledTimes(1);
    for (const effect of Object.values(sideEffects)) expect(effect).not.toHaveBeenCalled();
  });

  it("keeps ordinary files usable in a mixed replay batch without copying marked raw or firstPrompt", async () => {
    const { sdk, kv, writes } = context();
    const root = await directory();
    await writeFile(join(root, "marked.jsonl"), transcript("marked-session", marked));
    await writeFile(join(root, "ordinary.jsonl"), transcript("ordinary-session"));
    const result = await sdk.trigger("mem::replay::import-jsonl", { path: root });
    expect(result).toMatchObject({ success: true, imported: 1, sessionIds: ["ordinary-session"], observations: 3, skipped: { count: 1, reason: FINDING_CAPTURE_EXCLUDED } });
    expect(parseJsonlText).toHaveBeenCalledTimes(1);
    expect(buildSyntheticCompression).toHaveBeenCalledTimes(3);
    expect(sideEffects.index).toHaveBeenCalledTimes(3);
    expect(await kv.get(KV.sessions, "marked-session")).toBeNull();
    expect(await kv.list(KV.observations("marked-session"))).toEqual([]);
    expect(await kv.list(KV.crystals)).toHaveLength(1);
    expect(JSON.stringify(writes.mock.calls)).not.toContain(RESTRICTED);
    expect(JSON.stringify(writes.mock.calls)).not.toContain("marked-session");
    expect(await kv.get(KV.sessions, "ordinary-session")).toMatchObject({ firstPrompt: "ordinary first prompt" });
  });

  it("refuses marked stored replay content before timeline projection and filters marked session metadata", async () => {
    const { sdk, kv } = context();
    await kv.set(KV.sessions, "marked-session", { id: "marked-session", startedAt: time, firstPrompt: JSON.stringify(marked) });
    await kv.set(KV.sessions, "ordinary-session", { id: "ordinary-session", startedAt: time, firstPrompt: "ordinary first prompt" });
    const refused = await sdk.trigger("mem::replay::load", { sessionId: "marked-session" });
    expect(refused).toEqual({ success: false, error: FINDING_CAPTURE_EXCLUDED });
    const sessions = await sdk.trigger("mem::replay::sessions", {});
    expect(sessions).toMatchObject({ success: true, sessions: [{ id: "ordinary-session" }], skipped: { count: 1, reason: FINDING_CAPTURE_EXCLUDED } });
    expect(JSON.stringify([refused, sessions])).not.toContain(RESTRICTED);
    await kv.set(KV.observations("ordinary-session"), "obs_1", { id: "obs_1", title: "HTTP output", narrative: "ordinary", facts: [], extraField: marked });
    expect(await sdk.trigger("mem::replay::load", { sessionId: "ordinary-session" })).toEqual({ success: false, error: FINDING_CAPTURE_EXCLUDED });
  });
});
