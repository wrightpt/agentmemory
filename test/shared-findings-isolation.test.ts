import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ISdk } from "iii-sdk";
import type { StateKV } from "../src/state/kv.js";
import type { Crystal, ExportData, Insight, Lesson, MemoryProvider } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import {
  buildCrystalAccessIndex,
  buildLessonAccessIndex,
  canReadCrystal,
  canReadInsight,
  canReadLesson,
  resolveLessonBoundaryAccess,
  systemLessonAccessContext,
} from "../src/functions/lesson-access.js";
import {
  isSharedFindingLesson,
  lessonCanonicalId,
  normalizeLesson,
  parseImportedLesson,
  parseLessonSaveInput,
} from "../src/functions/lesson-model.js";
import { registerLessonsFunctions } from "../src/functions/lessons.js";
import { registerContextFunction } from "../src/functions/context.js";
import { registerCrystallizeFunction } from "../src/functions/crystallize.js";
import { registerReflectFunctions } from "../src/functions/reflect.js";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import { registerObsidianExportFunction } from "../src/functions/obsidian-export.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { registerDiagnosticsFunction } from "../src/functions/diagnostics.js";
import { queryAudit, recordAudit } from "../src/functions/audit.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SECRET = "post-freeze-market-result-secret";
const FINDING_ID = "lsn_fnd_" + "a".repeat(32);
const TIME = "2026-09-28T00:00:00.000Z";

function lesson(overrides: Record<string, unknown> = {}): Lesson {
  return {
    id: "lsn_ordinary",
    identityKind: "legacy-prose",
    content: "normal reusable coding lesson",
    context: "",
    confidence: 0.8,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    project: "agentmemory",
    tags: [],
    createdAt: TIME,
    updatedAt: TIME,
    decayRate: 0.05,
    scope: { ring: "repo", scopeId: "agentmemory" },
    sensitivity: "internal",
    ...overrides,
  } as Lesson;
}

function finding(overrides: Record<string, unknown> = {}): Lesson {
  return lesson({ id: FINDING_ID, content: SECRET, sharedFinding: null, ...overrides });
}

function crystal(id: string, sourceLessonIds: string[] = []): Crystal {
  return {
    id,
    narrative: sourceLessonIds.length ? SECRET : "ordinary crystal",
    keyOutcomes: [],
    filesAffected: [],
    lessons: sourceLessonIds,
    sourceLessonIds,
    sourceActionIds: [],
    createdAt: TIME,
  };
}

function insight(id: string, sourceCrystalIds: string[] = []): Insight {
  return {
    id,
    title: "insight",
    content: sourceCrystalIds.length ? SECRET : "ordinary insight",
    confidence: 0.8,
    reinforcements: 0,
    sourceConceptCluster: [],
    sourceMemoryIds: [],
    sourceLessonIds: [],
    sourceCrystalIds,
    tags: [],
    createdAt: TIME,
    updatedAt: TIME,
    decayRate: 0.05,
  };
}

describe("shared findings stay outside ordinary memory routes", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(async () => {
    vi.stubEnv("AGENTMEMORY_LESSON_ACCESS_MODE", "classify");
    kv = mockKV();
    sdk = mockSdk();
    const engine = sdk as unknown as ISdk;
    const state = kv as StateKV;
    const provider = { summarize: vi.fn() } as unknown as MemoryProvider;
    registerLessonsFunctions(engine, state);
    registerContextFunction(engine, state, 4000);
    registerCrystallizeFunction(engine, state, provider);
    registerReflectFunctions(engine, state, provider);
    registerExportImportFunction(engine, state);
    registerObsidianExportFunction(engine, state);
    registerSmartSearchFunction(engine, state, async () => []);
    registerDiagnosticsFunction(engine, state);
    await kv.set(KV.lessons, "lsn_ordinary", lesson());
    await kv.set(KV.lessons, FINDING_ID, finding());
    await kv.set(KV.crystals, "crystal_protected", crystal("crystal_protected", [FINDING_ID]));
    await kv.set(KV.crystals, "crystal_ordinary", crystal("crystal_ordinary"));
    await kv.set(KV.insights, "insight_protected", insight("insight_protected", ["crystal_protected"]));
    await kv.set(KV.insights, "insight_ordinary", insight("insight_ordinary"));
  });

  afterEach(() => vi.unstubAllEnvs());

  it("denies malformed markers and reserved identities before classify and system access", () => {
    const resolved = resolveLessonBoundaryAccess({}, { mode: "classify" });
    if (!resolved.success) throw new Error("classification context unavailable");
    for (const context of [resolved.context, systemLessonAccessContext()]) {
      for (const protectedLesson of [
        finding(),
        lesson({ id: FINDING_ID }),
        lesson({ sharedFinding: undefined }),
        lesson({ idAliases: [FINDING_ID] }),
        lesson({ sharedFinding: false, content: 42 }),
      ]) {
        expect(canReadLesson(protectedLesson, context)).toBe(false);
      }
      expect(canReadLesson(lesson(), context)).toBe(true);
    }
  });

  it("keeps protection through normalization without accepting it through ordinary saves or imports", () => {
    const normalized = normalizeLesson(finding());
    expect(isSharedFindingLesson(normalized)).toBe(true);
    expect(normalized.id).toBe(FINDING_ID);
    expect(lessonCanonicalId(normalized)).toBe(FINDING_ID);
    for (const record of [finding(), lesson({ id: FINDING_ID }), lesson({ idAliases: [FINDING_ID] })]) {
      expect(parseLessonSaveInput(record).success).toBe(false);
      expect(parseImportedLesson(record).success).toBe(false);
    }
    expect(parseLessonSaveInput(lesson()).success).toBe(true);
    expect(parseImportedLesson(lesson()).success).toBe(true);
  });

  it("blocks dangling finding references and derived summaries in classification mode", () => {
    const resolved = resolveLessonBoundaryAccess({}, { mode: "classify" });
    if (!resolved.success) throw new Error("classification context unavailable");
    const index = buildLessonAccessIndex([lesson(), finding({ content: 42 })]);
    const protectedCrystal = crystal("protected", [FINDING_ID]);
    const missingCrystal = crystal("dangling", ["lsn_fnd_missing"]);
    const metadataOnly = finding({ id: "old_shared_id" });
    index.set(metadataOnly.id, metadataOnly);
    expect(canReadCrystal(protectedCrystal, index, resolved.context)).toBe(false);
    expect(canReadCrystal(missingCrystal, index, resolved.context)).toBe(false);
    expect(canReadCrystal(crystal("metadata", [metadataOnly.id]), index, resolved.context)).toBe(false);
    expect(canReadCrystal(crystal("legacy", ["missing_legacy"]), index, resolved.context)).toBe(true);
    expect(canReadInsight(
      insight("derived", [protectedCrystal.id]), index,
      buildCrystalAccessIndex([protectedCrystal]), resolved.context,
    )).toBe(false);
  });

  it("omits findings from full recall, compact recall, lists, context, smart search and unfolding", async () => {
    const results = await Promise.all([
      sdk.trigger("mem::lesson-recall", { query: "normal reusable coding" }),
      sdk.trigger("mem::lesson-recall", { query: SECRET, compact: true }),
      sdk.trigger("mem::lesson-list", {}),
      sdk.trigger("mem::context", { sessionId: "worker-a", project: "agentmemory" }),
      sdk.trigger("mem::smart-search", { query: SECRET, includeLessons: true, agentId: "*" }),
      sdk.trigger("mem::smart-search", { expandIds: [FINDING_ID], agentId: "*" }),
    ]);
    expect(JSON.stringify(results)).not.toContain(SECRET);
    expect(JSON.stringify(results)).not.toContain(FINDING_ID);
    expect(JSON.stringify(results[0])).toContain("normal reusable coding lesson");
    expect(JSON.stringify(results[3])).toContain("normal reusable coding lesson");
  });

  it("keeps malformed shared content from disrupting normal recall and context", async () => {
    await kv.set(KV.lessons, FINDING_ID, finding({ content: 42, mechanismId: "invalid" }));
    const recall = await sdk.trigger("mem::lesson-recall", { query: "normal reusable" });
    const context = await sdk.trigger("mem::context", { sessionId: "worker-b", project: "agentmemory" });
    expect(JSON.stringify(recall)).toContain("normal reusable coding lesson");
    expect(JSON.stringify(context)).toContain("normal reusable coding lesson");
  });

  it("hides malformed reserved rows before ordinary listing and mutation validation", async () => {
    const malformed = lesson({ id: FINDING_ID, content: 42, mechanismId: "invalid" });
    await kv.set(KV.lessons, FINDING_ID, structuredClone(malformed));
    const listed = await sdk.trigger("mem::lesson-list", {});
    expect(listed).toMatchObject({ success: true, total: 1 });
    expect(JSON.stringify(listed)).toContain("normal reusable coding lesson");
    expect(JSON.stringify(listed)).not.toContain(FINDING_ID);

    const denied = await Promise.all([
      sdk.trigger("mem::lesson-strengthen", { lessonId: FINDING_ID }),
      sdk.trigger("mem::lesson-delete", { lessonId: FINDING_ID, reason: "generic delete" }),
      sdk.trigger("mem::lesson-supersede", {
        lessonId: FINDING_ID, replacementLessonId: "lsn_ordinary", reason: "generic supersede",
      }),
      sdk.trigger("mem::lesson-supersede", {
        lessonId: "lsn_ordinary", replacementLessonId: FINDING_ID, reason: "protected replacement",
      }),
    ]);
    for (const result of denied) expect(result).toMatchObject({ success: false, code: "access_denied" });
    expect(await kv.get(KV.lessons, FINDING_ID)).toEqual(malformed);
    expect(await kv.get(KV.lessons, "lsn_ordinary")).toEqual(lesson());
    expect(await sdk.trigger("mem::lesson-strengthen", { lessonId: "lsn_ordinary" })).toMatchObject({ success: true });
    expect(await sdk.trigger("mem::lesson-delete", { lessonId: "lsn_ordinary", reason: "ordinary correction" })).toMatchObject({ success: true, action: "deleted" });
    expect(await kv.get(KV.lessons, FINDING_ID)).toEqual(malformed);
  });

  it("omits protected crystals, insights and their summaries from legacy reads and export", async () => {
    const results = await Promise.all([
      sdk.trigger("mem::crystal-list", {}),
      sdk.trigger("mem::crystal-get", { crystalId: "crystal_protected" }),
      sdk.trigger("mem::insight-list", {}),
      sdk.trigger("mem::insight-search", { query: SECRET }),
      sdk.trigger("mem::export", {}),
    ]);
    expect(JSON.stringify(results)).not.toContain(SECRET);
    expect(JSON.stringify(results)).not.toContain(FINDING_ID);
    expect(JSON.stringify(results[0])).toContain("ordinary crystal");
    expect(JSON.stringify(results[2])).toContain("ordinary insight");
    expect(JSON.stringify(results[4])).toContain("normal reusable coding lesson");
    expect(results[1]).toMatchObject({ success: false });
  });

  it("rejects generic import before any mutation and prevents replace from deleting shared findings", async () => {
    const exported = await sdk.trigger("mem::export", {}) as ExportData;
    const fabricated = { ...exported, lessons: [finding()] };
    expect(await sdk.trigger("mem::import", { exportData: fabricated })).toMatchObject({ success: false });
    expect(await sdk.trigger("mem::import", { exportData: exported, strategy: "replace" })).toMatchObject({ success: false });
    expect(await kv.get(KV.lessons, FINDING_ID)).toEqual(finding());
    expect(await kv.list(KV.lessons)).toHaveLength(2);
    const merge = await sdk.trigger("mem::import", { exportData: exported, strategy: "merge" }) as { success: boolean };
    expect(merge.success, JSON.stringify(merge)).toBe(true);
  });

  it("writes only ordinary lessons and crystals to Obsidian files", async () => {
    const root = await mkdtemp(join(tmpdir(), "finding-isolation-"));
    vi.stubEnv("AGENTMEMORY_EXPORT_ROOT", root);
    try {
      const result = await sdk.trigger("mem::obsidian-export", {
        vaultDir: root,
        types: ["lessons", "crystals"],
      });
      expect(result).toMatchObject({ success: true });
      const rendered: string[] = [];
      for (const directory of ["lessons", "crystals"]) {
        const files = await readdir(join(root, directory));
        expect(files).toHaveLength(1);
        for (const file of files) rendered.push(await readFile(join(root, directory, file), "utf8"));
      }
      expect(rendered.join("\n")).not.toContain(SECRET);
      expect(rendered.join("\n")).not.toContain(FINDING_ID);
      expect(rendered.join("\n")).toContain("normal reusable coding lesson");
      expect(rendered.join("\n")).toContain("ordinary crystal");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters protected diagnostics and audit details without hiding ordinary records", async () => {
    await kv.set(KV.lessons, FINDING_ID, finding({ confidence: Number.NaN, content: 42 }));
    await recordAudit(kv as StateKV, "lesson_save", "mem::lesson-save", [FINDING_ID], { content: SECRET });
    await recordAudit(kv as StateKV, "lesson_save", "mem::lesson-save", ["lsn_ordinary"], { content: "ordinary-audit" });
    const audit = await queryAudit(kv as StateKV);
    const diagnostics = await sdk.trigger("mem::diagnose", { categories: ["lessons"] });
    expect(JSON.stringify([audit, diagnostics])).not.toContain(SECRET);
    expect(JSON.stringify([audit, diagnostics])).not.toContain(FINDING_ID);
    expect(JSON.stringify(audit)).toContain("ordinary-audit");
  });

  it("filters crystal and insight diagnostics before exposing IDs, malformed fields or counts", async () => {
    await kv.set(KV.lessons, FINDING_ID, finding({ content: 42 }));
    await kv.set(KV.crystals, "crystal_protected", {
      ...crystal("crystal_protected", [FINDING_ID]), narrative: null,
    });
    await kv.set(KV.insights, "insight_protected", {
      ...insight("insight_protected", ["crystal_protected"]), confidence: Number.NaN,
    });
    await kv.set(KV.insights, "insight_direct", {
      ...insight("insight_direct"), sourceLessonIds: [FINDING_ID], confidence: Number.NaN,
    });
    const diagnostics = await sdk.trigger("mem::diagnose", { categories: ["crystals", "insights"] });
    expect(JSON.stringify(diagnostics)).not.toContain("protected");
    expect(JSON.stringify(diagnostics)).not.toContain("insight_direct");
    expect(JSON.stringify(diagnostics)).not.toContain(FINDING_ID);
    expect(diagnostics).toMatchObject({
      success: true,
      checks: [
        { name: "crystals-ok", message: "All 1 crystals are consistent" },
        { name: "insights-ok", message: "All 1 insights are consistent" },
      ],
    });
    await kv.set(KV.crystals, "crystal_ordinary", { ...crystal("crystal_ordinary"), narrative: null });
    await kv.set(KV.insights, "insight_ordinary", { ...insight("insight_ordinary"), confidence: Number.NaN });
    const ordinaryIssues = await sdk.trigger("mem::diagnose", { categories: ["crystals", "insights"] });
    expect(JSON.stringify(ordinaryIssues)).toContain("crystal-empty-narrative:crystal_ordinary");
    expect(JSON.stringify(ordinaryIssues)).toContain("insight-bad-confidence:insight_ordinary");
    expect(JSON.stringify(ordinaryIssues)).not.toContain("protected");
  });

  it("fails descendant diagnostics closed if authoritative access data cannot be read", async () => {
    const originalList = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.lessons) throw new Error(SECRET);
      return originalList<T>(scope);
    };
    const diagnostics = await sdk.trigger("mem::diagnose", { categories: ["crystals", "insights"] });
    expect(JSON.stringify(diagnostics)).not.toContain(SECRET);
    expect(JSON.stringify(diagnostics)).not.toContain("protected");
    expect(diagnostics).toMatchObject({
      checks: [
        { name: "crystals-projection-unavailable", status: "fail" },
        { name: "insights-projection-unavailable", status: "fail" },
      ],
    });
  });

  it("excludes protected descendants from insight decay writes, counters and audit", async () => {
    const old = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const protectedInsight = { ...insight("insight_protected", ["crystal_protected"]), createdAt: old };
    await kv.set(KV.insights, protectedInsight.id, structuredClone(protectedInsight));
    await kv.set(KV.insights, "insight_ordinary", { ...insight("insight_ordinary"), createdAt: old });
    const result = await sdk.trigger("mem::insight-decay-sweep", {});
    expect(result).toMatchObject({ success: true, total: 1, decayed: 1 });
    expect(await kv.get(KV.insights, protectedInsight.id)).toEqual(protectedInsight);
    const ordinary = await kv.get<Insight>(KV.insights, "insight_ordinary");
    expect(ordinary?.confidence).toBeLessThan(0.8);
    expect(JSON.stringify(await queryAudit(kv as StateKV))).not.toContain("insight_protected");
  });
});
