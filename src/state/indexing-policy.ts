import type { CompressedObservation, Memory } from "../types.js";

export interface MemoryQualityDisposition {
  stored: true;
  lexicallySearchable: boolean;
  semanticallyIndexed: boolean;
  promotedToDurableMemory: boolean;
  reason: string;
}

export const OBSERVATION_INDEX_POLICY_VERSION = 2;

const INSTITUTIONAL_TYPES = new Set<CompressedObservation["type"]>([
  "decision",
  "discovery",
  "error",
  "task",
  "subagent",
]);

const ROUTINE_TYPES = new Set<CompressedObservation["type"]>([
  "file_read",
  "command_run",
  "search",
  "web_fetch",
  "notification",
]);

/**
 * Raw observations remain stored.  This policy only controls derived search
 * indexes, keeping exact source/code lookup in git while reserving semantic
 * embeddings for durable institutional signal.
 */
export function observationIndexingDisposition(
  observation: CompressedObservation,
): MemoryQualityDisposition {
  const hasSearchText = Boolean(
    observation.title?.trim() && observation.narrative?.trim(),
  );
  const importance = Math.max(0, Math.min(10, observation.importance ?? 0));
  let lexicallySearchable = false;
  let semanticallyIndexed = false;
  let reason = "observation is stored but has no searchable text";

  if (hasSearchText && INSTITUTIONAL_TYPES.has(observation.type)) {
    lexicallySearchable = true;
    semanticallyIndexed = importance >= 4;
    reason = semanticallyIndexed
      ? "institutional observation type with sufficient importance"
      : "institutional observation below semantic importance floor";
  } else if (
    hasSearchText &&
    (observation.type === "file_write" || observation.type === "file_edit")
  ) {
    lexicallySearchable = importance >= 4;
    semanticallyIndexed = importance >= 7;
    reason = semanticallyIndexed
      ? "important source change summary"
      : lexicallySearchable
        ? "source change remains lexical only"
        : "low-importance source change remains stored only";
  } else if (hasSearchText && observation.type === "conversation") {
    lexicallySearchable = importance >= 6;
    semanticallyIndexed = importance >= 8;
    reason = semanticallyIndexed
      ? "high-importance conversation conclusion"
      : lexicallySearchable
        ? "substantive conversation remains lexical only"
        : "routine conversation remains stored only";
  } else if (hasSearchText && ROUTINE_TYPES.has(observation.type)) {
    lexicallySearchable = importance >= 8;
    semanticallyIndexed = importance >= 9;
    reason = semanticallyIndexed
      ? "exceptionally important routine event"
      : lexicallySearchable
        ? "important routine event remains lexical only"
        : "routine tool/status noise remains stored only";
  } else if (hasSearchText) {
    lexicallySearchable = importance >= 6;
    semanticallyIndexed = importance >= 8;
    reason = semanticallyIndexed
      ? "high-importance observation"
      : lexicallySearchable
        ? "observation remains lexical only"
        : "low-signal observation remains stored only";
  }

  return {
    stored: true,
    lexicallySearchable,
    semanticallyIndexed,
    promotedToDurableMemory: false,
    reason,
  };
}

export function durableMemoryIndexingDisposition(
  memory: Memory,
): MemoryQualityDisposition {
  const searchable = Boolean(memory.title?.trim() && memory.content?.trim());
  return {
    stored: true,
    lexicallySearchable: searchable,
    semanticallyIndexed: searchable && memory.isLatest !== false,
    promotedToDurableMemory: true,
    reason:
      memory.isLatest === false
        ? "superseded durable memory is retained but removed from active indexes"
        : "explicit durable memory participates in lexical and semantic retrieval",
  };
}

export function shouldSemanticallyIndexObservation(
  observation: CompressedObservation,
): boolean {
  return observationIndexingDisposition(observation).semanticallyIndexed;
}

export function shouldLexicallyIndexObservation(
  observation: CompressedObservation,
): boolean {
  return observationIndexingDisposition(observation).lexicallySearchable;
}
