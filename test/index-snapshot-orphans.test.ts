import { describe, expect, it } from "vitest";
import {
  assertManifestCoverage,
  classifyIndexScopeFiles,
  isIndexShardManifest,
  stateScopeFromFileName,
  type IndexShardManifest,
} from "../scripts/index-snapshot-orphans.js";

function stateFile(scope: string, bytes = 100) {
  return {
    path: `/state/${encodeURIComponent(scope)}.bin`,
    bytes,
    mtimeMs: 1,
  };
}

describe("index snapshot orphan inventory", () => {
  it("decodes iii file-backed state scope names", () => {
    expect(
      stateScopeFromFileName(
        "mem%3Aindex%3Abm25%3Abm25%3Abank-a%3A00000.bin",
      ),
    ).toBe("mem:index:bm25:bm25:bank-a:00000");
    expect(stateScopeFromFileName("not-a-state-file.txt")).toBeNull();
    expect(stateScopeFromFileName("%ZZ.bin")).toBeNull();
  });

  it("separates referenced BM25/vector shards from unrelated and orphan scopes", () => {
    const bm25Scope = "mem:index:bm25:bm25:bank-a:00000";
    const vectorScope = "mem:index:bm25:vectors:bank-b:00000";
    const orphanScope = "mem:index:bm25:bm25:idx_old:00000";
    const manifest = (scope: string): IndexShardManifest => ({
      v: 1,
      generation: scope.includes("bank-a") ? "bank-a" : "bank-b",
      shards: [{ scope, key: "data", chars: 10 }],
      chars: 10,
    });

    const result = classifyIndexScopeFiles(
      [
        stateFile(bm25Scope),
        stateFile(vectorScope),
        stateFile(orphanScope, 250),
        stateFile("mem:audit", 500),
      ],
      [manifest(bm25Scope), manifest(vectorScope), null],
      { scanStartedAtMs: 10_000, minOrphanAgeMs: 1_000 },
    );

    expect(result.referenced.map((file) => file.scope)).toEqual([
      bm25Scope,
      vectorScope,
    ]);
    expect(result.orphans).toEqual([
      expect.objectContaining({ scope: orphanScope, bytes: 250 }),
    ]);
    expect(result.deferred).toEqual([]);
  });

  it("defers recently modified unreferenced scopes", () => {
    const oldScope = "mem:index:bm25:bm25:idx_old:00000";
    const inFlightScope = "mem:index:bm25:bm25:bank-b:00000";

    const result = classifyIndexScopeFiles(
      [
        { ...stateFile(oldScope), mtimeMs: 1_000 },
        { ...stateFile(inFlightScope), mtimeMs: 9_500 },
      ],
      [],
      { scanStartedAtMs: 10_000, minOrphanAgeMs: 1_000 },
    );

    expect(result.orphans.map((file) => file.scope)).toEqual([oldScope]);
    expect(result.deferred.map((file) => file.scope)).toEqual([
      inFlightScope,
    ]);
  });

  it("refuses a missing primary manifest when shard files exist", () => {
    expect(() =>
      assertManifestCoverage(
        [stateFile("mem:index:bm25:bm25:idx_old:00000")],
        [null, null, null],
      ),
    ).toThrow("primary BM25 manifest is missing");
  });

  it("refuses a manifest whose referenced shard file is missing", () => {
    const missingScope = "mem:index:bm25:bm25:bank-a:00000";
    const manifest: IndexShardManifest = {
      v: 1,
      generation: "bank-a",
      shards: [{ scope: missingScope, key: "data", chars: 10 }],
      chars: 10,
    };

    expect(() => assertManifestCoverage([], [manifest, null, null])).toThrow(
      "manifest references 1 missing shard file",
    );
  });

  it("rejects empty, cross-index, duplicate, and inconsistent manifests", () => {
    const bm25Prefix = "mem:index:bm25:bm25:";
    const valid: IndexShardManifest = {
      v: 1,
      generation: "bank-a",
      shards: [
        {
          scope: `${bm25Prefix}bank-a:00000`,
          key: "data",
          chars: 10,
        },
      ],
      chars: 10,
    };

    expect(isIndexShardManifest(valid, bm25Prefix)).toBe(true);
    expect(
      isIndexShardManifest({ ...valid, shards: [], chars: 0 }, bm25Prefix),
    ).toBe(false);
    expect(
      isIndexShardManifest(
        {
          ...valid,
          shards: [
            {
              scope: "mem:index:bm25:vectors:bank-a:00000",
              key: "data",
              chars: 10,
            },
          ],
        },
        bm25Prefix,
      ),
    ).toBe(false);
    expect(
      isIndexShardManifest(
        { ...valid, shards: [valid.shards[0]!, valid.shards[0]!] },
        bm25Prefix,
      ),
    ).toBe(false);
    expect(isIndexShardManifest({ ...valid, chars: 11 }, bm25Prefix)).toBe(
      false,
    );
  });
});
