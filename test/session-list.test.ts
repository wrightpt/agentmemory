import { describe, expect, it } from "vitest";
import { selectSessionPage } from "../src/functions/session-list.js";
import type { Session } from "../src/types.js";

function session(
  id: string,
  project: string,
  status: Session["status"],
  updatedAt: string,
): Session {
  return {
    id,
    project,
    cwd: `/repo/${project}`,
    startedAt: updatedAt,
    updatedAt,
    status,
    observationCount: 3,
    firstPrompt: `private prompt ${id}`,
    summary: `summary ${id}`,
  };
}

describe("bounded session listing", () => {
  const sessions = [
    session("ses_1", "alpha", "completed", "2026-07-01T00:00:00Z"),
    session("ses_2", "alpha", "active", "2026-07-03T00:00:00Z"),
    session("ses_3", "beta", "active", "2026-07-02T00:00:00Z"),
  ];
  sessions[2].projectAliases = ["beta-legacy"];

  it("sorts newest first and returns an opaque next cursor", () => {
    const first = selectSessionPage(sessions, { limit: 2 });
    expect(first.sessions.map((item) => item.id)).toEqual(["ses_2", "ses_3"]);
    expect(first.pagination).toMatchObject({ total: 3, hasMore: true });
    expect(first.pagination.malformedExcluded).toBe(0);
    expect(first.pagination.nextCursor).toBeTruthy();

    const second = selectSessionPage(sessions, {
      limit: 2,
      cursor: first.pagination.nextCursor!,
    });
    expect(second.sessions.map((item) => item.id)).toEqual(["ses_1"]);
    expect(second.pagination.hasMore).toBe(false);
  });

  it("filters by canonical project, recorded alias, status, and since", () => {
    expect(selectSessionPage(sessions, { project: "alpha" }).pagination.total).toBe(2);
    expect(selectSessionPage(sessions, { project: "beta-legacy" }).sessions[0].id).toBe("ses_3");
    expect(selectSessionPage(sessions, { status: "completed" }).sessions[0].id).toBe("ses_1");
    expect(
      selectSessionPage(sessions, { since: "2026-07-02T12:00:00Z" }).sessions.map((item) => item.id),
    ).toEqual(["ses_2"]);
  });

  it("omits prompts in compact and full output unless explicitly requested", () => {
    const compact = selectSessionPage(sessions, { limit: 1, format: "compact" }).sessions[0];
    expect(compact).not.toHaveProperty("firstPrompt");
    expect(compact).not.toHaveProperty("summary");

    const full = selectSessionPage(sessions, { limit: 1, format: "full" }).sessions[0];
    expect(full).not.toHaveProperty("firstPrompt");
    expect(full).toHaveProperty("summary");

    const withPrompt = selectSessionPage(sessions, {
      limit: 1,
      format: "full",
      includePrompt: true,
    }).sessions[0];
    expect(withPrompt.firstPrompt).toContain("private prompt");
  });

  it("does not trust malformed projectAliases values", () => {
    const badAliases = { ...sessions[0], projectAliases: { alpha: true } } as unknown as Session;
    expect(selectSessionPage([badAliases], { project: "missing" }).pagination.total).toBe(0);
  });

  it("rejects invalid cursors, statuses, formats, and timestamps", () => {
    expect(() => selectSessionPage(sessions, { cursor: "not-a-cursor" })).toThrow("cursor");
    expect(() => selectSessionPage(sessions, { status: "stuck" as never })).toThrow("status");
    expect(() => selectSessionPage(sessions, { format: "huge" as never })).toThrow("format");
    expect(() => selectSessionPage(sessions, { since: "yesterday-ish" })).toThrow("since");
  });

  it("excludes malformed legacy sessions by default and labels them on request", () => {
    const malformed = { project: "legacy", status: "active" } as Session;
    const safe = selectSessionPage([...sessions, malformed]);
    expect(safe.pagination.malformedExcluded).toBe(1);
    expect(safe.pagination.total).toBe(3);

    const included = selectSessionPage([...sessions, malformed], { includeMalformed: true });
    expect(included.pagination.malformedExcluded).toBe(0);
    expect(included.pagination.total).toBe(4);
    expect(included.sessions.find((item) => item.project === "legacy")?.issues).toContain("missing_id");
  });
});
