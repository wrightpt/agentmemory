import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerActionsFunction } from "../src/functions/actions.js";
import { registerSentinelsFunction } from "../src/functions/sentinels.js";
import { registerCheckpointsFunction } from "../src/functions/checkpoints.js";
import {
  ActionRevisionConflictError,
  persistAction,
} from "../src/functions/action-store.js";
import { registerLeasesFunction } from "../src/functions/leases.js";
import type {
  Action,
  ActionCollectionState,
  ActionEvent,
  ActionViewItem,
  Checkpoint,
  Lease,
  Sentinel,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("Actions v2", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerActionsFunction(sdk as never, kv as never);
    registerSentinelsFunction(sdk as never, kv as never);
    registerCheckpointsFunction(sdk as never, kv as never);
    registerLeasesFunction(sdk as never, kv as never);
  });

  it("normalizes new actions into the v2 projection and appends a creation event", async () => {
    const dueAt = "2026-07-18T12:00:00.000Z";
    const result = (await sdk.trigger("mem::action-create", {
      title: "Ship Actions v2",
      project: "/home/cp/repos/agent-infra/agentmemory",
      tags: `agent:codex,worktree:actions-v2,due:${dueAt},schema`,
      actor: "codex",
    })) as { success: boolean; action: Action; revision: number };

    expect(result.success).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.action).toMatchObject({
      schemaVersion: 2,
      revision: 1,
      lifecycle: "pending",
      status: "pending",
      project: "agentmemory",
      projectId: "agentmemory",
      owner: "codex",
      worktree: "actions-v2",
      dueAt,
      awaitingHuman: false,
    });
    expect(result.action.projectAliases).toContain(
      "/home/cp/repos/agent-infra/agentmemory",
    );
    expect(result.action.tags).toEqual([
      "agent:codex",
      "worktree:actions-v2",
      `due:${dueAt}`,
      "schema",
    ]);

    const events = await kv.list<ActionEvent>("mem:action-events");
    const state = await kv.get<ActionCollectionState>(
      "mem:action-state",
      "current",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actionId: result.action.id,
      entityType: "action",
      revision: 1,
      type: "created",
      actor: "codex",
    });
    expect(state).toMatchObject({ schemaVersion: 2, revision: 1 });
    expect(state?.pending).toBeUndefined();
  });

  it.each([
    [{ title: "Bad wait", awaitingHuman: "false" }, "awaitingHuman must be boolean"],
    [
      { title: "Bad aliases", projectAliases: "legacy" },
      "projectAliases must be an array of strings",
    ],
    [{ title: "Bad priority", priority: Number.NaN }, "priority must be a finite number"],
  ])("rejects malformed typed fields at the action boundary", async (input, error) => {
    const result = (await sdk.trigger("mem::action-create", input)) as {
      success: boolean;
      error: string;
    };
    expect(result).toEqual({ success: false, error });
  });

  it("returns the final collection revision for an action plus inline edges", async () => {
    const first = (await sdk.trigger("mem::action-create", {
      title: "First dependency",
    })) as { action: Action };
    const second = (await sdk.trigger("mem::action-create", {
      title: "Second dependency",
    })) as { action: Action };

    const result = (await sdk.trigger("mem::action-create", {
      title: "Dependent action",
      edges: [
        { type: "requires", targetActionId: first.action.id },
        { type: "requires", targetActionId: second.action.id },
      ],
    })) as { success: boolean; revision: number };
    const state = await kv.get<ActionCollectionState>(
      "mem:action-state",
      "current",
    );

    expect(result.success).toBe(true);
    expect(result.revision).toBe(5);
    expect(result.revision).toBe(state?.revision);
    expect(await kv.list<ActionEvent>("mem:action-events")).toHaveLength(5);
  });

  it("derives separate actionable, scheduled, waiting, blocked, and completed views", async () => {
    await sdk.trigger("mem::action-create", { title: "Ready" });
    await sdk.trigger("mem::action-create", {
      title: "Later",
      notBefore: "2999-01-01T00:00:00.000Z",
    });
    await sdk.trigger("mem::action-create", {
      title: "Needs approval",
      awaitingHuman: true,
    });
    await sdk.trigger("mem::action-create", {
      title: "Manually blocked",
      blockedReason: "Waiting for an external artifact",
    });
    await sdk.trigger("mem::action-create", {
      title: "Finished",
      lifecycle: "done",
    });

    const expected = new Map([
      ["actionable", "Ready"],
      ["scheduled", "Later"],
      ["waiting", "Needs approval"],
      ["blocked", "Manually blocked"],
      ["completed", "Finished"],
    ]);
    for (const [view, title] of expected) {
      const page = (await sdk.trigger("mem::action-list", { view })) as {
        success: boolean;
        views: ActionViewItem[];
      };
      expect(page.success).toBe(true);
      expect(page.views.map((item) => item.action.title)).toEqual([title]);
      expect(page.views[0].view).toBe(view);
    }
  });

  it.each([
    [
      { title: "Scheduled lease", notBefore: "2999-01-01T00:00:00.000Z" },
      "scheduled",
    ],
    [{ title: "Human-gated lease", awaitingHuman: true }, "waiting"],
  ])("refuses leases for %s actions", async (input, view) => {
    const created = (await sdk.trigger("mem::action-create", input)) as {
      action: Action;
    };
    const result = (await sdk.trigger("mem::lease-acquire", {
      actionId: created.action.id,
      agentId: "worker-a",
    })) as { success: boolean; error: string };

    expect(result).toMatchObject({
      success: false,
      error: `action is ${view}`,
    });
    expect(await kv.list("mem:leases")).toEqual([]);
  });

  it("invalidates readiness revisions when a legacy lease is released without an assignment projection", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Legacy leased action",
    })) as { action: Action };
    const lease: Lease = {
      id: "lse_legacy",
      actionId: created.action.id,
      agentId: "worker-a",
      acquiredAt: "2026-07-17T10:00:00.000Z",
      expiresAt: "2999-07-17T11:00:00.000Z",
      status: "active",
    };
    await kv.set("mem:leases", lease.id, lease);
    const before = (await sdk.trigger("mem::action-list", {
      agentId: "worker-b",
    })) as { revision: number };

    const released = (await sdk.trigger("mem::lease-release", {
      actionId: created.action.id,
      agentId: "worker-a",
    })) as { success: boolean };
    const stale = (await sdk.trigger("mem::action-list", {
      agentId: "worker-b",
      revision: before.revision,
    })) as { success: boolean; error: string };

    expect(released.success).toBe(true);
    expect(stale).toMatchObject({
      success: false,
      error: "revision_conflict",
    });
  });

  it("rolls back a lease when the action completes during acquisition", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Racing action",
    })) as { action: Action };
    const originalSet = kv.set;
    let injectedCompletion = false;
    kv.set = async <T>(scope: string, key: string, value: T): Promise<T> => {
      const stored = await originalSet(scope, key, value);
      if (scope === "mem:leases" && !injectedCompletion) {
        injectedCompletion = true;
        await sdk.trigger("mem::action-update", {
          actionId: created.action.id,
          lifecycle: "done",
          actor: "concurrent-worker",
        });
      }
      return stored;
    };

    const result = (await sdk.trigger("mem::lease-acquire", {
      actionId: created.action.id,
      agentId: "worker-a",
    })) as { success: boolean; error: string };

    expect(result).toMatchObject({
      success: false,
      error: "action_revision_conflict",
    });
    expect(await kv.list("mem:leases")).toEqual([]);
    expect(await kv.get<Action>("mem:actions", created.action.id)).toMatchObject({
      lifecycle: "done",
      status: "done",
    });
  });

  it("derives sentinel gates as blocked until the sentinel triggers", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Wait for sentinel",
    })) as { action: Action };
    const sentinel = (await sdk.trigger("mem::sentinel-create", {
      name: "Approval gate",
      type: "approval",
      linkedActionIds: [created.action.id],
    })) as { success: boolean; sentinel: Sentinel };
    expect(sentinel.success).toBe(true);

    const blocked = (await sdk.trigger("mem::action-list", {
      view: "blocked",
    })) as { views: ActionViewItem[]; revision: number };
    expect(blocked.views).toHaveLength(1);
    expect(blocked.views[0].blockers[0].message).toContain("Approval gate");

    await sdk.trigger("mem::sentinel-trigger", {
      sentinelId: sentinel.sentinel.id,
    });
    const stale = (await sdk.trigger("mem::action-list", {
      revision: blocked.revision,
    })) as { success: boolean; error: string };
    expect(stale).toMatchObject({
      success: false,
      error: "revision_conflict",
    });
    const actionable = (await sdk.trigger("mem::action-list", {
      view: "actionable",
    })) as { actions: Action[]; revision: number };
    expect(actionable.revision).toBeGreaterThan(blocked.revision);
    expect(actionable.actions.map((action) => action.id)).toContain(
      created.action.id,
    );
  });

  it("invalidates readiness revisions when a checkpoint resolves", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Wait for CI",
    })) as { action: Action };
    const checkpoint = (await sdk.trigger("mem::checkpoint-create", {
      name: "CI",
      type: "ci",
      linkedActionIds: [created.action.id],
    })) as { success: boolean; checkpoint: Checkpoint };
    expect(checkpoint.success).toBe(true);
    const before = (await sdk.trigger("mem::action-list", {
      view: "blocked",
    })) as { revision: number; actions: Action[] };
    expect(before.actions.map((action) => action.id)).toContain(
      created.action.id,
    );

    await sdk.trigger("mem::checkpoint-resolve", {
      checkpointId: checkpoint.checkpoint.id,
      status: "passed",
      resolvedBy: "ci",
    });
    const stale = (await sdk.trigger("mem::action-list", {
      revision: before.revision,
    })) as { success: boolean; error: string };
    expect(stale).toMatchObject({
      success: false,
      error: "revision_conflict",
    });
  });

  it("lets typed approval clear a migrated wait tag without inventing a manual block", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Confirm rollout",
      tags: "awaiting-human",
    })) as { action: Action };
    expect(created.action.awaitingHuman).toBe(true);
    expect(created.action.status).toBe("blocked");

    const updated = (await sdk.trigger("mem::action-update", {
      actionId: created.action.id,
      awaitingHuman: false,
      approval: {
        state: "approved",
        decidedAt: "2026-07-17T06:00:00.000Z",
        decidedBy: "human",
      },
    })) as { success: boolean; action: Action };

    expect(updated.success).toBe(true);
    expect(updated.action.tags).toContain("awaiting-human");
    expect(updated.action.awaitingHuman).toBe(false);
    expect(updated.action.blockedReason).toBeUndefined();
    expect(updated.action.status).toBe("pending");
    const page = (await sdk.trigger("mem::action-list", {
      view: "actionable",
    })) as { actions: Action[] };
    expect(page.actions.map((action) => action.id)).toContain(created.action.id);
  });

  it("preserves append-only history for lifecycle, result, and correction changes", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Original title",
      actor: "planner",
    })) as { action: Action };
    const firstEvent = (
      await kv.list<ActionEvent>("mem:action-events")
    )[0];

    await sdk.trigger("mem::action-update", {
      actionId: created.action.id,
      lifecycle: "active",
      actor: "worker",
    });
    await sdk.trigger("mem::action-update", {
      actionId: created.action.id,
      lifecycle: "done",
      result: "Validated",
      actor: "worker",
    });
    await sdk.trigger("mem::action-update", {
      actionId: created.action.id,
      title: "Corrected title",
      correctionOf: firstEvent.id,
      correctionReason: "Fix the initial wording",
      actor: "reviewer",
    });

    const result = (await sdk.trigger("mem::action-get", {
      actionId: created.action.id,
    })) as { action: Action; events: ActionEvent[]; revision: number };
    expect(result.events.map((event) => event.type)).toEqual([
      "created",
      "lifecycle_changed",
      "result_recorded",
      "corrected",
    ]);
    expect(result.events.map((event) => event.revision)).toEqual([1, 2, 3, 4]);
    expect(result.events[3]).toMatchObject({
      actor: "reviewer",
      correctionOf: firstEvent.id,
      reason: "Fix the initial wording",
    });
    expect(result.events[0].after).toMatchObject({ title: "Original title" });
    expect(result.action).toMatchObject({
      title: "Corrected title",
      lifecycle: "done",
      result: "Validated",
    });
    expect(result.revision).toBe(4);
  });

  it("paginates a stable revision and fails closed after a collection change", async () => {
    for (let index = 0; index < 5; index += 1) {
      await sdk.trigger("mem::action-create", { title: `Task ${index}` });
    }

    const ids = new Set<string>();
    let cursor: string | null = null;
    let revision: number | undefined;
    do {
      const page = (await sdk.trigger("mem::action-list", {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      })) as {
        success: boolean;
        actions: Action[];
        revision: number;
        nextCursor: string | null;
      };
      expect(page.success).toBe(true);
      revision ??= page.revision;
      expect(page.revision).toBe(revision);
      for (const action of page.actions) ids.add(action.id);
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.size).toBe(5);

    const firstPage = (await sdk.trigger("mem::action-list", {
      limit: 2,
    })) as { nextCursor: string; revision: number };
    await sdk.trigger("mem::action-create", { title: "Concurrent change" });
    const stalePage = (await sdk.trigger("mem::action-list", {
      limit: 2,
      cursor: firstPage.nextCursor,
    })) as { success: boolean; error: string };
    expect(stalePage).toMatchObject({
      success: false,
      error: "revision_conflict",
    });
  });

  it("matches canonical projects and retained aliases", async () => {
    const legacyPath = "/home/cp/repos/agent-infra/agentmemory";
    const created = (await sdk.trigger("mem::action-create", {
      title: "Alias-aware task",
      project: legacyPath,
      projectId: "agentmemory",
    })) as { action: Action };

    for (const project of ["agentmemory", legacyPath]) {
      const page = (await sdk.trigger("mem::action-list", { project })) as {
        actions: Action[];
      };
      expect(page.actions.map((action) => action.id)).toEqual([
        created.action.id,
      ]);
    }
  });

  it("keeps legacy project updates functional while retaining the old canonical ID", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Move initiative",
      projectId: "alpha",
    })) as { action: Action };

    const updated = (await sdk.trigger("mem::action-update", {
      actionId: created.action.id,
      project: "beta",
    })) as { success: boolean; action: Action };

    expect(updated.success).toBe(true);
    expect(updated.action).toMatchObject({
      project: "beta",
      projectId: "beta",
    });
    expect(updated.action.projectAliases).toContain("alpha");
  });

  it("keeps the legacy blocked projection when an unrelated writer touches a dependent action", async () => {
    const dependency = (await sdk.trigger("mem::action-create", {
      title: "Dependency",
    })) as { action: Action };
    const dependent = (await sdk.trigger("mem::action-create", {
      title: "Dependent",
      edges: [{ type: "requires", targetActionId: dependency.action.id }],
    })) as { action: Action };

    const touched = { ...dependent.action, description: "Metadata touch" };
    const persisted = await persistAction(kv as never, touched, {
      actor: "secondary-writer",
      before: dependent.action,
    });

    expect(persisted.action).toMatchObject({
      lifecycle: "pending",
      status: "blocked",
      description: "Metadata touch",
    });
  });

  it("rebases a stale secondary mutation when concurrent fields do not overlap", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Original title",
    })) as { action: Action };
    const stale = structuredClone(created.action);
    const concurrent = (await sdk.trigger("mem::action-update", {
      actionId: created.action.id,
      description: "Concurrent description",
      actor: "primary-writer",
    })) as { action: Action };

    const secondaryInput = {
      ...stale,
      title: "Secondary title",
      updatedAt: "2026-07-17T12:00:00.000Z",
    };
    const persisted = await persistAction(kv as never, secondaryInput, {
      actor: "secondary-writer",
      before: stale,
    });

    expect(persisted.action).toMatchObject({
      title: "Secondary title",
      description: "Concurrent description",
    });
    expect(persisted.action.revision).toBeGreaterThan(
      concurrent.action.revision ?? 0,
    );
  });

  it("rejects a stale secondary mutation when the same field changed concurrently", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Original title",
    })) as { action: Action };
    const stale = structuredClone(created.action);
    const concurrent = (await sdk.trigger("mem::action-update", {
      actionId: created.action.id,
      title: "Primary title",
      actor: "primary-writer",
    })) as { action: Action };

    const secondaryInput = {
      ...stale,
      title: "Secondary title",
      updatedAt: "2026-07-17T12:00:00.000Z",
    };

    await expect(
      persistAction(kv as never, secondaryInput, {
        actor: "secondary-writer",
        before: stale,
      }),
    ).rejects.toEqual(
      expect.objectContaining<ActionRevisionConflictError>({
        name: "ActionRevisionConflictError",
        actionId: created.action.id,
        fields: ["title"],
      }),
    );
    expect(await kv.get<Action>("mem:actions", created.action.id)).toEqual(
      concurrent.action,
    );
  });

  it("does not turn a transient v2 assignee into the durable owner", async () => {
    const created = (await sdk.trigger("mem::action-create", {
      title: "Unowned task",
    })) as { action: Action };
    expect(created.action.owner).toBeUndefined();

    const assigned = { ...created.action, assignedTo: "worker-a" };
    const persisted = await persistAction(kv as never, assigned, {
      actor: "worker-a",
      before: created.action,
    });

    expect(persisted.action.assignedTo).toBe("worker-a");
    expect(persisted.action.owner).toBeUndefined();
  });

  it("lets typed v2 context be cleared without deleting retained legacy tags", async () => {
    const dueAt = "2026-07-20T12:00:00.000Z";
    const created = (await sdk.trigger("mem::action-create", {
      title: "Clear typed context",
      tags: `due:${dueAt},worktree:legacy-tree`,
    })) as { action: Action };
    expect(created.action).toMatchObject({ dueAt, worktree: "legacy-tree" });

    const updated = (await sdk.trigger("mem::action-update", {
      actionId: created.action.id,
      dueAt: "",
      worktree: "",
    })) as { success: boolean; action: Action };

    expect(updated.success).toBe(true);
    expect(updated.action.dueAt).toBeUndefined();
    expect(updated.action.worktree).toBeUndefined();
    expect(updated.action.tags).toEqual([
      `due:${dueAt}`,
      "worktree:legacy-tree",
    ]);
  });

  it("recovers a pending event before serving a revision-bound read", async () => {
    const action: Action = {
      id: "act_recover",
      title: "Recovered action",
      description: "",
      status: "pending",
      lifecycle: "pending",
      priority: 5,
      createdAt: "2026-07-17T06:00:00.000Z",
      updatedAt: "2026-07-17T06:00:00.000Z",
      createdBy: "codex",
      project: "agentmemory",
      projectId: "agentmemory",
      projectAliases: [],
      tags: [],
      sourceObservationIds: [],
      sourceMemoryIds: [],
      schemaVersion: 2,
      revision: 1,
      awaitingHuman: false,
    };
    const event: ActionEvent = {
      schemaVersion: 2,
      id: "aev_recover",
      actionId: action.id,
      entityType: "action",
      revision: 1,
      type: "created",
      actor: "codex",
      timestamp: action.createdAt,
      after: action,
    };
    await kv.set("mem:action-events", event.id, event);
    await kv.set<ActionCollectionState>("mem:action-state", "current", {
      schemaVersion: 2,
      revision: 0,
      updatedAt: action.createdAt,
      pending: { revision: 1, eventId: event.id },
    });

    const page = (await sdk.trigger("mem::action-list", {})) as {
      actions: Action[];
      revision: number;
    };
    const state = await kv.get<ActionCollectionState>(
      "mem:action-state",
      "current",
    );
    expect(page.actions.map((candidate) => candidate.id)).toEqual([action.id]);
    expect(page.revision).toBe(1);
    expect(state).toMatchObject({ revision: 1 });
    expect(state?.pending).toBeUndefined();
  });
});
