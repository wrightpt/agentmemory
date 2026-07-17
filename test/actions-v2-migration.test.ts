import { describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { migrateActionsV2 } from "../src/functions/actions-v2-migration.js";
import type {
  Action,
  ActionCollectionState,
  ActionEvent,
} from "../src/types.js";
import { mockKV } from "./helpers/mocks.js";

function legacyAction(
  id: string,
  overrides: Partial<Action> & { tags?: unknown } = {},
): Action {
  return {
    id,
    title: `Legacy ${id}`,
    description: "",
    status: "pending",
    priority: 5,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    createdBy: "unknown",
    tags: [],
    sourceObservationIds: [],
    sourceMemoryIds: [],
    ...overrides,
  } as Action;
}

describe("Actions v2 migration", () => {
  it("rejects invalid migration configuration before reading or writing rows", async () => {
    const kv = mockKV();
    await kv.set("mem:actions", "act_config", legacyAction("act_config"));

    const result = await migrateActionsV2(kv as never, {
      dryRun: false,
      defaultProjectId: "/not/a/project-id",
      projectAliases: { "/legacy": "also/not-valid" },
    });

    expect(result).toMatchObject({
      success: false,
      error: "invalid_migration_config",
    });
    expect(result.configurationErrors).toHaveLength(2);
    expect(await kv.list("mem:action-events")).toEqual([]);
    expect(await kv.get("mem:action-state", "current")).toBeNull();
  });

  it("defaults to a byte-for-byte non-mutating dry run", async () => {
    const kv = mockKV();
    const action = legacyAction("act_dry", {
      project: "/home/cp/repos/agent-infra/agentmemory",
      tags: "agent:codex,worktree:v2" as never,
    });
    await kv.set("mem:actions", action.id, action);
    const before = structuredClone(action);

    const result = await migrateActionsV2(kv as never);

    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      scanned: 1,
      changed: 1,
      revisionBefore: 0,
      revisionAfter: 0,
    });
    expect(await kv.get("mem:actions", action.id)).toEqual(before);
    expect(await kv.list("mem:action-events")).toEqual([]);
    expect(await kv.get("mem:action-state", "current")).toBeNull();
    expect(await kv.list("mem:audit")).toEqual([]);
  });

  it("normalizes legacy identity and typed tags, then skips an identical retry", async () => {
    const kv = mockKV();
    const dueAt = "2026-07-20T14:00:00.000Z";
    const repoRoot = "/home/cp/repos/trading/trading-system";
    const action = legacyAction("act_apply", {
      status: "blocked",
      project: repoRoot,
      tags: `agent:claude,worktree:wallet-cohort,branch:feat/v2,due:${dueAt}` as never,
    });
    await kv.set("mem:actions", action.id, action);

    const first = await migrateActionsV2(kv as never, {
      dryRun: false,
      projectAliases: { [repoRoot]: "trading-system" },
      actor: "migration-test",
    });
    const migrated = await kv.get<Action>("mem:actions", action.id);
    const eventsAfterFirst = await kv.list<ActionEvent>("mem:action-events");
    const second = await migrateActionsV2(kv as never, {
      dryRun: false,
      projectAliases: { [repoRoot]: "trading-system" },
      actor: "migration-test",
    });

    expect(first).toMatchObject({
      success: true,
      dryRun: false,
      scanned: 1,
      changed: 1,
      revisionBefore: 0,
      revisionAfter: 1,
    });
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      revision: 1,
      lifecycle: "pending",
      status: "blocked",
      project: "trading-system",
      projectId: "trading-system",
      owner: "claude",
      repoRoot,
      worktree: "wallet-cohort",
      branch: "feat/v2",
      dueAt,
      blockedReason: "Legacy blocked state",
      awaitingHuman: false,
    });
    expect(migrated?.projectAliases).toContain(repoRoot);
    expect(migrated?.tags).toEqual([
      "agent:claude",
      "worktree:wallet-cohort",
      "branch:feat/v2",
      `due:${dueAt}`,
    ]);
    expect(eventsAfterFirst).toHaveLength(1);
    expect(eventsAfterFirst[0]).toMatchObject({
      actionId: action.id,
      type: "migrated",
      actor: "migration-test",
      revision: 1,
    });
    expect(second).toMatchObject({
      success: true,
      changed: 0,
      skipped: 1,
      revisionBefore: 1,
      revisionAfter: 1,
    });
    expect(await kv.list("mem:action-events")).toHaveLength(1);
    expect(await kv.list("mem:audit")).toHaveLength(1);
  });

  it("infers canonical IDs from Unix and Windows repository paths", async () => {
    const kv = mockKV();
    await kv.set(
      "mem:actions",
      "act_unix",
      legacyAction("act_unix", { project: "/srv/repos/agentmemory/" }),
    );
    await kv.set(
      "mem:actions",
      "act_windows",
      legacyAction("act_windows", { project: "C:\\repos\\trading-system\\" }),
    );

    const result = await migrateActionsV2(kv as never, { dryRun: false });

    expect(result).toMatchObject({ success: true, changed: 2 });
    expect(await kv.get<Action>("mem:actions", "act_unix")).toMatchObject({
      projectId: "agentmemory",
    });
    expect(await kv.get<Action>("mem:actions", "act_windows")).toMatchObject({
      projectId: "trading-system",
    });
  });

  it("stops before any mutation when explicit project identities conflict", async () => {
    const kv = mockKV();
    const legacyPath = "/legacy/repo";
    const action = legacyAction("act_conflict", {
      project: legacyPath,
      projectId: "alpha",
    });
    await kv.set("mem:actions", action.id, action);
    const before = structuredClone(action);

    const result = await migrateActionsV2(kv as never, {
      dryRun: false,
      projectAliases: { [legacyPath]: "beta" },
    });

    expect(result).toMatchObject({
      success: false,
      error: "migration_conflict",
      conflictCount: 1,
      unresolvedActionIds: [action.id],
      revisionBefore: 0,
      revisionAfter: 0,
    });
    expect(await kv.get("mem:actions", action.id)).toEqual(before);
    expect(await kv.list("mem:action-events")).toEqual([]);
    expect(await kv.get("mem:action-state", "current")).toBeNull();
  });

  it("processes deterministic bounded batches with an opaque cursor", async () => {
    const kv = mockKV();
    for (const id of ["act_001", "act_002", "act_003"]) {
      await kv.set("mem:actions", id, legacyAction(id));
    }

    const first = await migrateActionsV2(kv as never, {
      dryRun: false,
      limit: 2,
    });
    expect(first).toMatchObject({
      success: true,
      scanned: 2,
      changed: 2,
      hasMore: true,
      revisionAfter: 2,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await migrateActionsV2(kv as never, {
      dryRun: false,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second).toMatchObject({
      success: true,
      scanned: 1,
      changed: 1,
      hasMore: false,
      nextCursor: null,
      revisionBefore: 2,
      revisionAfter: 3,
    });
    expect(await kv.list("mem:action-events")).toHaveLength(3);
  });

  it("reports a pending store write during dry-run without recovering it", async () => {
    const kv = mockKV();
    const pendingState: ActionCollectionState = {
      schemaVersion: 2,
      revision: 7,
      updatedAt: "2026-07-17T06:00:00.000Z",
      pending: { revision: 8, eventId: "aev_pending" },
    };
    await kv.set("mem:action-state", "current", pendingState);
    const event: ActionEvent = {
      schemaVersion: 2,
      id: "aev_pending",
      actionId: "act_pending",
      entityType: "action",
      revision: 8,
      type: "created",
      actor: "codex",
      timestamp: pendingState.updatedAt,
    };
    await kv.set("mem:action-events", event.id, event);

    const result = await migrateActionsV2(kv as never, { dryRun: true });

    expect(result).toMatchObject({
      success: false,
      error: "pending_action_store_recovery",
      revisionBefore: 7,
      revisionAfter: 7,
    });
    expect(await kv.get("mem:action-state", "current")).toEqual(pendingState);
    expect(await kv.get("mem:actions", "act_pending")).toBeNull();
    expect(await kv.get("mem:action-events", event.id)).toEqual(event);
  });
});
