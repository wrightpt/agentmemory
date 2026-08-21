import type { CompressedObservation, Memory } from "../types.js";
import { memoryToObservation } from "./memory-utils.js";
import { resolveRetrievalProvenance } from "./provenance.js";
import { QdrantVectorStore } from "./qdrant-vector-store.js";
import { KV } from "./schema.js";
import { ShadowVectorStore, type VectorShadowDiagnostics } from "./shadow-vector-store.js";
import type { StateKV } from "./kv.js";
import type {
  LocalVectorEntry,
  PersistableLocalVectorStore,
  VectorMetadata,
} from "./vector-store.js";

export type VectorShadowRuntimeDiagnostics =
  | VectorShadowDiagnostics
  | {
      enabled: false;
      authority: "local";
      backend: "qdrant" | null;
      state: "disabled" | "configuration_error";
      error: string | null;
    };

let activeShadow: ShadowVectorStore | null = null;
let inactiveDiagnostics: VectorShadowRuntimeDiagnostics = {
  enabled: false,
  authority: "local",
  backend: null,
  state: "disabled",
  error: null,
};

function numberFromEnv(
  name: string,
  fallback: number,
  options: { min: number; max?: number; integer?: boolean },
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  const bounded =
    Number.isFinite(parsed) &&
    parsed >= options.min &&
    (options.max === undefined || parsed <= options.max) &&
    (!options.integer || Number.isSafeInteger(parsed));
  if (!bounded) throw new Error(`${name} has an invalid value`);
  return parsed;
}

function booleanEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

async function resolveVectorMetadata(
  kv: StateKV,
  entry: LocalVectorEntry,
): Promise<VectorMetadata> {
  const memory = await kv.get<Memory>(KV.memories, entry.obsId).catch(() => null);
  let observation: CompressedObservation | null = memory
    ? memoryToObservation(memory)
    : null;
  if (!observation && entry.sessionId && entry.sessionId !== "memory") {
    observation = await kv
      .get<CompressedObservation>(KV.observations(entry.sessionId), entry.obsId)
      .catch(() => null);
  }
  if (!observation) {
    return {
      ...(entry.metadata ?? {}),
      isLatest: true,
      attributed: false,
    };
  }
  const provenance = await resolveRetrievalProvenance(kv, observation, memory);
  return {
    ...(provenance.project ? { project: provenance.project } : {}),
    ...(provenance.projectAliases?.length
      ? { projectAliases: provenance.projectAliases }
      : {}),
    ...(provenance.canonicalRepoId
      ? { canonicalRepoId: provenance.canonicalRepoId }
      : {}),
    ...(provenance.missionId ? { missionId: provenance.missionId } : {}),
    ...(provenance.agentId ? { agentId: provenance.agentId } : {}),
    ...(provenance.memoryType ? { memoryType: provenance.memoryType } : {}),
    ...(provenance.files.length ? { files: provenance.files } : {}),
    isLatest: provenance.isLatest !== false,
    attributed: provenance.attributed,
  };
}

export function configureVectorShadow(
  local: PersistableLocalVectorStore,
  dimensions: number,
  kv: StateKV,
): {
  store: PersistableLocalVectorStore;
  shadow: ShadowVectorStore | null;
  warning?: string;
} {
  activeShadow = null;
  const mode = (process.env.AGENTMEMORY_VECTOR_SHADOW ?? "off")
    .trim()
    .toLowerCase();
  if (!mode || mode === "off" || mode === "false" || mode === "0") {
    inactiveDiagnostics = {
      enabled: false,
      authority: "local",
      backend: null,
      state: "disabled",
      error: null,
    };
    return { store: local, shadow: null };
  }
  if (mode !== "qdrant") {
    const error = `Unsupported AGENTMEMORY_VECTOR_SHADOW mode: ${mode}`;
    inactiveDiagnostics = {
      enabled: false,
      authority: "local",
      backend: "qdrant",
      state: "configuration_error",
      error,
    };
    return { store: local, shadow: null, warning: error };
  }

  try {
    const remote = new QdrantVectorStore({
      baseUrl: process.env.AGENTMEMORY_QDRANT_URL ?? "http://127.0.0.1:6333",
      collection:
        process.env.AGENTMEMORY_QDRANT_COLLECTION ??
        "agentmemory_shadow_main",
      dimensions,
      timeoutMs: numberFromEnv("AGENTMEMORY_QDRANT_TIMEOUT_MS", 2_000, {
        min: 100,
        max: 120_000,
        integer: true,
      }),
      ...(process.env.AGENTMEMORY_QDRANT_API_KEY
        ? { apiKey: process.env.AGENTMEMORY_QDRANT_API_KEY }
        : {}),
      allowRemote: booleanEnv("AGENTMEMORY_QDRANT_ALLOW_REMOTE"),
    });
    const shadow = new ShadowVectorStore(local, remote, {
      sampleRate: numberFromEnv("AGENTMEMORY_VECTOR_SHADOW_SAMPLE_RATE", 0.05, {
        min: 0,
        max: 1,
      }),
      pendingLimit: numberFromEnv("AGENTMEMORY_VECTOR_SHADOW_PENDING_LIMIT", 10_000, {
        min: 1,
        max: 1_000_000,
        integer: true,
      }),
      reconcileBatchSize: numberFromEnv(
        "AGENTMEMORY_VECTOR_SHADOW_BATCH_SIZE",
        256,
        { min: 1, max: 10_000, integer: true },
      ),
      retryMs: numberFromEnv("AGENTMEMORY_VECTOR_SHADOW_RETRY_MS", 30_000, {
        min: 0,
        max: 3_600_000,
        integer: true,
      }),
      metadataResolver: (entry) => resolveVectorMetadata(kv, entry),
    });
    activeShadow = shadow;
    return { store: shadow, shadow };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .slice(0, 300);
    inactiveDiagnostics = {
      enabled: false,
      authority: "local",
      backend: "qdrant",
      state: "configuration_error",
      error: message,
    };
    return { store: local, shadow: null, warning: message };
  }
}

export function getVectorShadowDiagnostics(): VectorShadowRuntimeDiagnostics {
  return activeShadow?.diagnostics() ?? inactiveDiagnostics;
}

export function resetVectorShadowRuntimeForTests(): void {
  activeShadow = null;
  inactiveDiagnostics = {
    enabled: false,
    authority: "local",
    backend: null,
    state: "disabled",
    error: null,
  };
}
