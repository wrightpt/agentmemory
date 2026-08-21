import { describe, expect, it } from "vitest";
import type { CompressedObservation, Memory } from "../src/types.js";
import {
  durableMemoryIndexingDisposition,
  observationIndexingDisposition,
} from "../src/state/indexing-policy.js";

function observation(
  type: CompressedObservation["type"],
  importance: number,
): CompressedObservation {
  return {
    id: `obs_${type}_${importance}`,
    sessionId: "ses_1",
    timestamp: "2026-01-01T00:00:00.000Z",
    type,
    title: "compressed title",
    facts: [],
    narrative: "compressed narrative",
    concepts: [],
    files: [],
    importance,
  };
}

function memory(isLatest = true): Memory {
  return {
    id: "mem_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    type: "architecture",
    title: "Launch authority",
    content: "The reason for the architectural choice",
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 8,
    version: 1,
    isLatest,
  };
}

describe("institutional-memory indexing policy", () => {
  it("stores routine noise and keeps it lexical without embedding it", () => {
    expect(observationIndexingDisposition(observation("file_read", 3))).toMatchObject({
      stored: true,
      lexicallySearchable: true,
      semanticallyIndexed: false,
      promotedToDurableMemory: false,
    });
  });

  it("semantically indexes decisions and important implementation conclusions", () => {
    expect(
      observationIndexingDisposition(observation("decision", 6))
        .semanticallyIndexed,
    ).toBe(true);
    expect(
      observationIndexingDisposition(observation("file_edit", 7))
        .semanticallyIndexed,
    ).toBe(true);
  });

  it("keeps explicit durable memories semantic until superseded", () => {
    expect(durableMemoryIndexingDisposition(memory(true))).toMatchObject({
      semanticallyIndexed: true,
      promotedToDurableMemory: true,
    });
    expect(durableMemoryIndexingDisposition(memory(false))).toMatchObject({
      stored: true,
      lexicallySearchable: true,
      semanticallyIndexed: false,
      promotedToDurableMemory: true,
    });
  });
});
