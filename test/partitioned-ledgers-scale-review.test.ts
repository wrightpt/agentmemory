import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listAuditEntries } from "../src/state/partitioned-ledgers.js";
import { KV } from "../src/state/schema.js";
import type { AuditEntry } from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

function idsHash(rows: AuditEntry[]): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${row.id}\n`);
  return hash.digest("hex");
}

describe("partitioned-ledger large legacy collection compatibility", () => {
  it("reads a large legacy audit collection without a JavaScript argument-count limit", async () => {
    const rows: AuditEntry[] = Array.from({ length: 160_000 }, (_, index) => ({
      id: `synthetic-audit-${index}`,
      timestamp: "2026-09-05T00:00:00.000Z",
      operation: "observe",
      functionId: "synthetic::review",
      targetIds: [],
      details: {},
    }));
    const kv = mockKV();
    kv.list = async <T>(scope: string): Promise<T[]> =>
      scope === KV.audit ? rows as T[] : [];

    const result = await listAuditEntries(kv);

    expect(result).toHaveLength(rows.length);
    expect(idsHash(result)).toBe(idsHash(rows));
    expect(result[0]).toEqual(rows[0]);
    expect(result.at(-1)).toEqual(rows.at(-1));
  });
});
