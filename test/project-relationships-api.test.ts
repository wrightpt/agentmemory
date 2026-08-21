import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

import { registerProjectRelationshipsFunction } from "../src/functions/project-relationships.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { ProjectRelationship } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("project relationships REST adapter", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    sdk = mockSdk();
    const kv = mockKV();
    registerProjectRelationshipsFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, "test-secret");
  });

  const authorizedHeaders = {
    authorization: "Bearer test-secret",
  };

  it("authenticates, maps a normalized upsert, lists it, and surfaces revision conflicts", async () => {
    const body = {
      operation: "upsert",
      sourceRepoId: "https://github.com/WrightPT/Trading-System.git",
      targetRepoId: "git@github.com:WrightPT/Workstation-Shell.git",
      relationType: "orchestrates-through",
      sourceAliases: ["trading-system"],
      targetAliases: ["workstation-shell"],
      provenance: {
        kind: "registry",
        source: "projects.yaml",
        recordedAt: "2026-08-21T12:00:00.000Z",
        recordedBy: "codex",
        sessionId: "ses_review",
        commitSha: "a".repeat(40),
      },
      reason: "The launch broker owns process birth.",
    };

    const unauthorized = (await sdk.trigger("api::project-relationships", {
      headers: {},
      body,
    })) as { status_code: number };
    expect(unauthorized.status_code).toBe(401);

    const created = (await sdk.trigger("api::project-relationships", {
      headers: authorizedHeaders,
      body,
    })) as {
      status_code: number;
      body: { success: boolean; relationship: ProjectRelationship };
    };
    expect(created.status_code).toBe(201);
    expect(created.body).toMatchObject({
      success: true,
      relationship: {
        sourceRepoId: "wrightpt/trading-system",
        targetRepoId: "wrightpt/workstation-shell",
        relationType: "orchestrates_through",
        sourceAliases: ["trading-system"],
        targetAliases: ["workstation-shell"],
        revision: 1,
        provenance: [
          {
            kind: "registry",
            source: "projects.yaml",
            recordedAt: "2026-08-21T12:00:00.000Z",
            recordedBy: "codex",
            sessionId: "ses_review",
            commitSha: "a".repeat(40),
          },
        ],
      },
    });

    const listed = (await sdk.trigger("api::project-relationships", {
      headers: authorizedHeaders,
      body: {
        operation: "list",
        repoId: "wrightpt/trading-system",
        direction: "outgoing",
      },
    })) as {
      status_code: number;
      body: { relationships: ProjectRelationship[] };
    };
    expect(listed.status_code).toBe(200);
    expect(listed.body.relationships.map((relationship) => relationship.id))
      .toEqual([created.body.relationship.id]);

    const conflict = (await sdk.trigger("api::project-relationships", {
      headers: authorizedHeaders,
      body: { ...body, reason: "Updated assertion without a revision." },
    })) as { status_code: number; body: { error: string } };
    expect(conflict).toEqual({
      status_code: 409,
      body: {
        success: false,
        error: "project_relationship_revision_conflict",
      },
    });

    const updated = (await sdk.trigger("api::project-relationships", {
      headers: authorizedHeaders,
      body: {
        ...body,
        reason: "Updated assertion with optimistic concurrency.",
        expectedRevision: 1,
      },
    })) as {
      status_code: number;
      body: { relationship: ProjectRelationship };
    };
    expect(updated.status_code).toBe(200);
    expect(updated.body.relationship.revision).toBe(2);
  });
});
