import { afterEach, describe, expect, it } from "vitest";
import { LocalVectorStore } from "../src/state/vector-store.js";
import {
  configureVectorShadow,
  getVectorShadowDiagnostics,
  resetVectorShadowRuntimeForTests,
} from "../src/state/vector-shadow-runtime.js";
import type { StateKV } from "../src/state/kv.js";

const ENV_KEYS = [
  "AGENTMEMORY_VECTOR_SHADOW",
  "AGENTMEMORY_QDRANT_URL",
  "AGENTMEMORY_QDRANT_COLLECTION",
  "AGENTMEMORY_QDRANT_API_KEY",
  "AGENTMEMORY_QDRANT_ALLOW_REMOTE",
  "AGENTMEMORY_VECTOR_SHADOW_SAMPLE_RATE",
];

describe("vector shadow runtime configuration", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetVectorShadowRuntimeForTests();
  });

  it("keeps the local store unchanged when shadow mode is off", () => {
    const local = new LocalVectorStore();
    const configured = configureVectorShadow(local, 3, {} as StateKV);
    expect(configured.store).toBe(local);
    expect(configured.shadow).toBeNull();
    expect(getVectorShadowDiagnostics()).toEqual({
      enabled: false,
      authority: "local",
      backend: null,
      state: "disabled",
      error: null,
    });
  });

  it("degrades invalid opt-in configuration without replacing local authority", () => {
    process.env.AGENTMEMORY_VECTOR_SHADOW = "qdrant";
    process.env.AGENTMEMORY_QDRANT_URL = "http://qdrant.example.test:6333";
    const local = new LocalVectorStore();
    const configured = configureVectorShadow(local, 3, {} as StateKV);

    expect(configured.store).toBe(local);
    expect(configured.shadow).toBeNull();
    expect(configured.warning).toMatch(/allowRemote/);
    expect(getVectorShadowDiagnostics()).toMatchObject({
      enabled: false,
      authority: "local",
      backend: "qdrant",
      state: "configuration_error",
    });
  });

  it("constructs an awaiting shadow without making a network request", () => {
    process.env.AGENTMEMORY_VECTOR_SHADOW = "qdrant";
    process.env.AGENTMEMORY_QDRANT_URL = "http://127.0.0.1:6333";
    process.env.AGENTMEMORY_QDRANT_COLLECTION = "agentmemory_shadow_runtime_test";
    process.env.AGENTMEMORY_VECTOR_SHADOW_SAMPLE_RATE = "0";
    const local = new LocalVectorStore();
    const configured = configureVectorShadow(local, 3, {} as StateKV);

    expect(configured.store).toBe(configured.shadow);
    expect(configured.shadow).not.toBeNull();
    expect(getVectorShadowDiagnostics()).toMatchObject({
      enabled: true,
      authority: "local",
      backend: "qdrant",
      state: "awaiting_reconcile",
      localSize: 0,
    });
  });
});
