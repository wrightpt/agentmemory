import { describe, expect, it } from "vitest";
import type { CompressedObservation, Memory } from "../src/types.js";
import {
  OBSERVATION_INDEX_POLICY_VERSION,
  durableMemoryIndexingDisposition,
  observationIndexingDisposition,
  shouldLexicallyIndexObservation,
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
  it("versions derived observation indexing independently from raw storage", () => {
    expect(OBSERVATION_INDEX_POLICY_VERSION).toBe(2);
  });

  it("stores routine noise without adding it to derived search indexes", () => {
    expect(observationIndexingDisposition(observation("file_read", 3))).toMatchObject({
      stored: true,
      lexicallySearchable: false,
      semanticallyIndexed: false,
      promotedToDurableMemory: false,
    });
    expect(shouldLexicallyIndexObservation(observation("command_run", 5))).toBe(
      false,
    );
    expect(shouldLexicallyIndexObservation(observation("web_fetch", 5))).toBe(
      false,
    );
  });

  it("keeps exceptionally important routine events searchable", () => {
    expect(observationIndexingDisposition(observation("command_run", 8))).toMatchObject({
      lexicallySearchable: true,
      semanticallyIndexed: false,
    });
    expect(observationIndexingDisposition(observation("command_run", 9))).toMatchObject({
      lexicallySearchable: true,
      semanticallyIndexed: true,
    });
  });

  it("never embeds an observation that the lexical index excludes", () => {
    const types: CompressedObservation["type"][] = [
      "file_read",
      "file_write",
      "file_edit",
      "command_run",
      "search",
      "web_fetch",
      "conversation",
      "error",
      "decision",
      "discovery",
      "subagent",
      "notification",
      "task",
      "image",
      "other",
    ];
    for (const type of types) {
      for (let importance = 0; importance <= 10; importance++) {
        const disposition = observationIndexingDisposition(
          observation(type, importance),
        );
        expect(
          disposition.semanticallyIndexed && !disposition.lexicallySearchable,
        ).toBe(false);
      }
    }
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
    expect(
      observationIndexingDisposition(observation("file_edit", 5))
        .lexicallySearchable,
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
