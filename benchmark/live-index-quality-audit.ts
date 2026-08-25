/**
 * Read-only audit of the observation indexing-quality policy against a live
 * AgentMemory API. The report contains aggregate counts and sizes only; it
 * never emits observation or memory content.
 *
 * Usage:
 *   AGENTMEMORY_BENCH_BASE_URL=http://127.0.0.1:3111 \
 *   BENCH_OUT=/tmp/agentmemory-index-quality.json \
 *   npm run bench:index-quality-live
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { memoryToObservation } from "../src/state/memory-utils.js";
import { SearchIndex } from "../src/state/search-index.js";
import {
  OBSERVATION_INDEX_POLICY_VERSION,
  observationIndexingDisposition,
} from "../src/state/indexing-policy.js";
import type { CompressedObservation, Memory, Session } from "../src/types.js";

interface SessionPage {
  sessions: Session[];
  pagination?: { nextCursor?: string };
}

interface ObservationPage {
  observations: CompressedObservation[];
}

interface MemoryPage {
  memories: Memory[];
  total: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const baseUrl = (
  process.env["AGENTMEMORY_BENCH_BASE_URL"] ?? "http://127.0.0.1:3111"
).replace(/\/$/, "");
const concurrency = Math.min(
  positiveInteger(process.env["BENCH_CONCURRENCY"], 4),
  16,
);
const outputPath = process.env["BENCH_OUT"];

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function listSessions(): Promise<Session[]> {
  const sessions: Session[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: "200", format: "compact" });
    if (cursor) query.set("cursor", cursor);
    const page = await getJson<SessionPage>(
      `/agentmemory/sessions?${query.toString()}`,
    );
    sessions.push(...page.sessions);
    cursor = page.pagination?.nextCursor;
  } while (cursor);
  return sessions;
}

async function main(): Promise<void> {
  global.gc?.();
  const baseline = process.memoryUsage();
  const startedAt = performance.now();
  const sessions = await listSessions();
  const index = new SearchIndex();
  const byType: Record<string, number> = {};
  const retainedByType: Record<string, number> = {};
  let rawObservations = 0;
  let textBearingObservations = 0;
  let retainedObservations = 0;
  let sourceChars = 0;
  let retainedSourceChars = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const position = cursor++;
      if (position >= sessions.length) return;
      const session = sessions[position]!;
      const page = await getJson<ObservationPage>(
        `/agentmemory/observations?sessionId=${encodeURIComponent(session.id)}`,
      );
      for (const observation of page.observations ?? []) {
        rawObservations++;
        byType[observation.type] = (byType[observation.type] ?? 0) + 1;
        const hasText = Boolean(
          observation.title?.trim() && observation.narrative?.trim(),
        );
        if (hasText) {
          textBearingObservations++;
          sourceChars += observation.title.length + observation.narrative.length;
        }
        if (!observationIndexingDisposition(observation).lexicallySearchable) {
          continue;
        }
        retainedObservations++;
        retainedByType[observation.type] =
          (retainedByType[observation.type] ?? 0) + 1;
        retainedSourceChars +=
          observation.title.length + observation.narrative.length;
        index.add(observation);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const memoryPage = await getJson<MemoryPage>(
    "/agentmemory/memories?limit=5000&offset=0",
  );
  let activeDurableMemories = 0;
  for (const memory of memoryPage.memories ?? []) {
    if (
      memory.isLatest === false ||
      !memory.title?.trim() ||
      !memory.content?.trim()
    ) {
      continue;
    }
    activeDurableMemories++;
    index.add(memoryToObservation(memory));
  }

  const builtAt = performance.now();
  const serialized = index.serialize();
  const serializedAt = performance.now();
  global.gc?.();
  const finalMemory = process.memoryUsage();
  const report = {
    schemaVersion: 1,
    benchmark: "live-observation-index-quality-bound",
    measuredAt: new Date().toISOString(),
    baseUrl,
    readOnly: true,
    contentEmitted: false,
    visibleScopeOnly: true,
    concurrency,
    policyVersion: OBSERVATION_INDEX_POLICY_VERSION,
    sessionCount: sessions.length,
    rawObservations,
    textBearingObservations,
    retainedObservations,
    observationRowReductionPct: Number(
      ((1 - retainedObservations / textBearingObservations) * 100).toFixed(4),
    ),
    sourceChars,
    retainedSourceChars,
    sourceCharReductionPct: Number(
      ((1 - retainedSourceChars / sourceChars) * 100).toFixed(4),
    ),
    durableMemoriesTotal: memoryPage.total,
    activeDurableMemories,
    resultingBm25Entries: index.size,
    serializedChars: serialized.length,
    projectedShardCountAt2mChars: Math.ceil(serialized.length / 2_000_000),
    fetchAndBuildMs: Number((builtAt - startedAt).toFixed(1)),
    serializeMs: Number((serializedAt - builtAt).toFixed(1)),
    processMemoryBytes: {
      baselineRss: baseline.rss,
      finalRss: finalMemory.rss,
      rssDelta: finalMemory.rss - baseline.rss,
      finalHeapUsed: finalMemory.heapUsed,
      finalHeapTotal: finalMemory.heapTotal,
    },
    byType: Object.fromEntries(Object.entries(byType).sort()),
    retainedByType: Object.fromEntries(
      Object.entries(retainedByType).sort(),
    ),
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const absolute = resolve(outputPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, rendered, "utf8");
  }
  process.stdout.write(rendered);
}

await main();
