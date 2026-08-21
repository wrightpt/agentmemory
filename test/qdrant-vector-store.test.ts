import { describe, expect, it, vi } from "vitest";
import {
  QdrantVectorStore,
  buildQdrantFilter,
  qdrantPointId,
} from "../src/state/qdrant-vector-store.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeQdrant(options: {
  exists?: boolean;
  dimensions?: number;
  queryPoints?: Array<{
    id: string;
    score: number;
    payload?: Record<string, unknown>;
  }>;
} = {}) {
  let exists = options.exists ?? false;
  const dimensions = options.dimensions ?? 3;
  const points = new Map<string, Record<string, unknown>>();
  const bodies: Array<{ path: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    bodies.push({ path: `${url.pathname}${url.search}`, method, body });
    if (/^\/collections\/[^/]+$/.test(url.pathname) && method === "GET") {
      return exists
        ? json({
            result: {
              points_count: points.size,
              config: { params: { vectors: { size: dimensions } } },
            },
          })
        : json({ status: "not found" }, 404);
    }
    if (/^\/collections\/[^/]+$/.test(url.pathname) && method === "PUT") {
      exists = true;
      return json({ result: true });
    }
    if (/^\/collections\/[^/]+$/.test(url.pathname) && method === "DELETE") {
      exists = false;
      points.clear();
      return json({ result: true });
    }
    if (url.pathname.endsWith("/index") && method === "PUT") {
      return json({ result: true });
    }
    if (url.pathname.endsWith("/points") && method === "PUT") {
      for (const point of body.points as Array<Record<string, unknown>>) {
        points.set(String(point.id), point);
      }
      return json({ result: { status: "completed" } });
    }
    if (url.pathname.endsWith("/points/delete") && method === "POST") {
      for (const id of body.points as string[]) points.delete(String(id));
      return json({ result: { status: "completed" } });
    }
    if (url.pathname.endsWith("/points/query") && method === "POST") {
      return json({ result: { points: options.queryPoints ?? [] } });
    }
    return json({ error: "unhandled" }, 500);
  });
  return { fetchMock, bodies, points };
}

describe("QdrantVectorStore", () => {
  it("uses deterministic UUID point IDs", () => {
    expect(qdrantPointId("obs-1")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(qdrantPointId("obs-1")).toBe(qdrantPointId("obs-1"));
    expect(qdrantPointId("obs-1")).not.toBe(qdrantPointId("obs-2"));
  });

  it("creates only a dedicated shadow collection and makes repeated upserts idempotent", async () => {
    const fake = fakeQdrant();
    const store = new QdrantVectorStore(
      {
        baseUrl: "http://127.0.0.1:6333",
        collection: "agentmemory_shadow_test",
        dimensions: 3,
      },
      fake.fetchMock,
    );
    await store.add("obs-1", "session-1", new Float32Array([1, 0, 0]), {
      canonicalRepoId: "wrightpt/agentmemory",
    });
    await store.add("obs-1", "session-2", new Float32Array([0, 1, 0]));

    expect(fake.points.size).toBe(1);
    expect(store.size).toBe(1);
    const point = fake.points.get(qdrantPointId("obs-1"));
    expect(point?.payload).toMatchObject({ obsId: "obs-1", sessionId: "session-2" });
    expect(fake.bodies.filter((call) => call.path.includes("/index?"))).toHaveLength(6);

    await store.remove("obs-1");
    expect(fake.points.size).toBe(0);
    expect(store.size).toBe(0);
  });

  it("emits payload filters and stabilizes equal-score result ordering", async () => {
    const fake = fakeQdrant({
      queryPoints: [
        { id: "2", score: 0.9, payload: { obsId: "obs-b", sessionId: "s" } },
        { id: "1", score: 0.9, payload: { obsId: "obs-a", sessionId: "s" } },
        { id: "3", score: 0.5, payload: { obsId: "obs-c", sessionId: "s" } },
      ],
    });
    const store = new QdrantVectorStore(
      {
        baseUrl: "http://localhost:6333",
        collection: "agentmemory_shadow_filter",
        dimensions: 3,
      },
      fake.fetchMock,
    );
    const result = await store.search(new Float32Array([1, 0, 0]), {
      limit: 2,
      filter: {
        canonicalRepoIds: ["wrightpt/workstation-shell"],
        agentIds: ["kimi", "codex"],
        isLatest: true,
      },
    });

    expect(result.map((row) => row.obsId)).toEqual(["obs-a", "obs-b"]);
    const query = fake.bodies.find((call) => call.path.endsWith("/points/query"));
    expect(query?.body).toMatchObject({
      limit: 4,
      filter: {
        must: [
          {
            key: "canonicalRepoId",
            match: { value: "wrightpt/workstation-shell" },
          },
          { key: "agentId", match: { any: ["codex", "kimi"] } },
          { key: "isLatest", match: { value: true } },
        ],
      },
    });
  });

  it("rejects unsafe endpoints, collection names, and dimensions before network access", async () => {
    const fake = fakeQdrant();
    expect(
      () =>
        new QdrantVectorStore(
          {
            baseUrl: "http://qdrant.example.test:6333",
            collection: "agentmemory_shadow_test",
            dimensions: 3,
          },
          fake.fetchMock,
        ),
    ).toThrow(/allowRemote/);
    expect(
      () =>
        new QdrantVectorStore(
          {
            baseUrl: "http://127.0.0.1:6333",
            collection: "production_memories",
            dimensions: 3,
          },
          fake.fetchMock,
        ),
    ).toThrow(/shadow collection/);

    const store = new QdrantVectorStore(
      {
        baseUrl: "http://127.0.0.1:6333",
        collection: "agentmemory_shadow_dimension",
        dimensions: 3,
      },
      fake.fetchMock,
    );
    await expect(store.add("bad", "s", new Float32Array([1, 2]))).rejects.toThrow(
      /dimension mismatch/,
    );
  });

  it("refuses to attach to a collection with a different dimension", async () => {
    const fake = fakeQdrant({ exists: true, dimensions: 7 });
    const store = new QdrantVectorStore(
      {
        baseUrl: "http://127.0.0.1:6333",
        collection: "agentmemory_shadow_mismatch",
        dimensions: 3,
      },
      fake.fetchMock,
    );
    await expect(store.search(new Float32Array([1, 0, 0]))).rejects.toThrow(
      /expected 3, got 7/,
    );
  });

  it("builds no empty filter", () => {
    expect(buildQdrantFilter(undefined)).toBeUndefined();
    expect(buildQdrantFilter({ agentIds: [] })).toBeUndefined();
  });
});
