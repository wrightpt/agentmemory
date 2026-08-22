import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  BM25_MANIFEST_KEY,
  BM25_SHARD_SCOPE_PREFIX,
  INDEX_SHARD_KEY,
  INDEX_STATE_SCOPE,
  REBUILD_BARRIER_KEY,
  VECTOR_FALLBACK_MANIFEST_KEY,
  VECTOR_MANIFEST_KEY,
  VECTOR_SHARD_SCOPE_PREFIX,
} from "../src/state/index-persistence-layout.js";

const execFileAsync = promisify(execFile);
const INDEX_SCOPE_PREFIXES = [
  BM25_SHARD_SCOPE_PREFIX,
  VECTOR_SHARD_SCOPE_PREFIX,
] as const;
const MANIFEST_LAYOUTS = [
  { key: BM25_MANIFEST_KEY, scopePrefix: BM25_SHARD_SCOPE_PREFIX },
  { key: VECTOR_MANIFEST_KEY, scopePrefix: VECTOR_SHARD_SCOPE_PREFIX },
  {
    key: VECTOR_FALLBACK_MANIFEST_KEY,
    scopePrefix: VECTOR_SHARD_SCOPE_PREFIX,
  },
] as const;
const DEFAULT_ORPHAN_MIN_AGE_MS = 6 * 60 * 60 * 1000;

export type IndexShardManifest = {
  v: 1;
  generation?: string;
  shards: Array<{ scope: string; key: string; chars: number }>;
  chars: number;
};

export type StateFile = {
  path: string;
  bytes: number;
  mtimeMs: number;
};

export type ClassifiedIndexFile = StateFile & { scope: string };

export function isIndexShardManifest(
  value: unknown,
  expectedScopePrefix: string,
): value is IndexShardManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IndexShardManifest>;
  if (
    candidate.v !== 1 ||
    !Number.isInteger(candidate.chars) ||
    candidate.chars! < 0 ||
    !Array.isArray(candidate.shards) ||
    candidate.shards.length === 0
  ) {
    return false;
  }

  const scopes = new Set<string>();
  let shardChars = 0;
  for (const shard of candidate.shards) {
    if (
      shard === null ||
      typeof shard !== "object" ||
      typeof shard.scope !== "string" ||
      !shard.scope.startsWith(expectedScopePrefix) ||
      shard.key !== INDEX_SHARD_KEY ||
      !Number.isInteger(shard.chars) ||
      shard.chars < 0 ||
      scopes.has(shard.scope)
    ) {
      return false;
    }
    scopes.add(shard.scope);
    shardChars += shard.chars;
  }
  return shardChars === candidate.chars;
}

export function stateScopeFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(".bin")) return null;
  try {
    return decodeURIComponent(fileName.slice(0, -4));
  } catch {
    return null;
  }
}

export function classifyIndexScopeFiles(
  files: StateFile[],
  manifests: Array<IndexShardManifest | null>,
  options: {
    scanStartedAtMs?: number;
    minOrphanAgeMs?: number;
  } = {},
): {
  referenced: ClassifiedIndexFile[];
  orphans: ClassifiedIndexFile[];
  deferred: ClassifiedIndexFile[];
} {
  const scanStartedAtMs = options.scanStartedAtMs ?? Date.now();
  const minOrphanAgeMs =
    options.minOrphanAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS;
  if (!Number.isFinite(scanStartedAtMs) || !Number.isFinite(minOrphanAgeMs)) {
    throw new Error("orphan classification timestamps must be finite");
  }
  if (minOrphanAgeMs < 0) {
    throw new Error("minimum orphan age must not be negative");
  }
  const orphanCutoffMs = scanStartedAtMs - minOrphanAgeMs;
  const referencedScopes = new Set(
    manifests.flatMap((manifest) =>
      manifest ? manifest.shards.map((shard) => shard.scope) : [],
    ),
  );
  const referenced: ClassifiedIndexFile[] = [];
  const orphans: ClassifiedIndexFile[] = [];
  const deferred: ClassifiedIndexFile[] = [];

  for (const file of files) {
    const scope = stateScopeFromFileName(basename(file.path));
    if (!scope || !INDEX_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix))) {
      continue;
    }
    const classified = { ...file, scope };
    if (referencedScopes.has(scope)) referenced.push(classified);
    else if (file.mtimeMs <= orphanCutoffMs) orphans.push(classified);
    else deferred.push(classified);
  }

  const byScope = (a: ClassifiedIndexFile, b: ClassifiedIndexFile): number =>
    a.scope.localeCompare(b.scope);
  return {
    referenced: referenced.sort(byScope),
    orphans: orphans.sort(byScope),
    deferred: deferred.sort(byScope),
  };
}

export function assertManifestCoverage(
  files: StateFile[],
  manifests: Array<IndexShardManifest | null>,
): void {
  const physicalScopes = new Set(
    files
      .map((file) => stateScopeFromFileName(basename(file.path)))
      .filter(
        (scope): scope is string =>
          scope !== null &&
          INDEX_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix)),
      ),
  );
  if (physicalScopes.size > 0 && manifests[0] === null) {
    throw new Error(
      "primary BM25 manifest is missing while index shard files exist",
    );
  }

  const referencedScopes = new Set(
    manifests.flatMap((manifest) =>
      manifest ? manifest.shards.map((shard) => shard.scope) : [],
    ),
  );
  const missing = [...referencedScopes].filter(
    (scope) => !physicalScopes.has(scope),
  );
  if (missing.length > 0) {
    throw new Error(
      `manifest references ${missing.length} missing shard file(s); refusing orphan classification`,
    );
  }
}

async function listStateFiles(storeDir: string): Promise<StateFile[]> {
  const entries = await readdir(storeDir, { withFileTypes: true });
  const files: StateFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = resolve(storeDir, entry.name);
    const metadata = await stat(path);
    files.push({ path, bytes: metadata.size, mtimeMs: metadata.mtimeMs });
  }
  return files;
}

async function readStateValue(options: {
  iiiBin: string;
  address: string;
  port: string;
  key: string;
}): Promise<unknown> {
  const { stdout } = await execFileAsync(options.iiiBin, [
    "trigger",
    "--address",
    options.address,
    "--port",
    options.port,
    "--function-id",
    "state::get",
    "--payload",
    JSON.stringify({ scope: INDEX_STATE_SCOPE, key: options.key }),
    "--timeout-ms",
    "10000",
  ]);
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? JSON.parse(trimmed) : null;
}

async function readManifestSet(options: {
  iiiBin: string;
  address: string;
  port: string;
}): Promise<{
  barrier: unknown;
  manifests: Array<IndexShardManifest | null>;
}> {
  const barrier = await readStateValue({
    ...options,
    key: REBUILD_BARRIER_KEY,
  });
  const values = await Promise.all(
    MANIFEST_LAYOUTS.map(({ key }) => readStateValue({ ...options, key })),
  );
  const manifests = values.map((value, index) => {
    if (value == null) return null;
    const layout = MANIFEST_LAYOUTS[index]!;
    if (!isIndexShardManifest(value, layout.scopePrefix)) {
      throw new Error(`invalid ${layout.key} manifest`);
    }
    return value;
  });
  return { barrier, manifests };
}

function manifestFingerprint(manifests: Array<IndexShardManifest | null>): string {
  return JSON.stringify(
    manifests.map((manifest) =>
      manifest
        ? {
            generation: manifest.generation,
            chars: manifest.chars,
            shards: manifest.shards.map((shard) => [
              shard.scope,
              shard.key,
              shard.chars,
            ]),
          }
        : null,
    ),
  );
}

async function main(): Promise<void> {
  const scanStartedAtMs = Date.now();
  const { values } = parseArgs({
    options: {
      store: { type: "string" },
      "iii-bin": { type: "string", default: "iii" },
      address: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "49134" },
    },
  });
  if (!values.store) {
    throw new Error("--store is required; this command is read-only");
  }

  const storeDir = resolve(values.store);
  const connection = {
    iiiBin: values["iii-bin"]!,
    address: values.address!,
    port: values.port!,
  };
  const before = await readManifestSet(connection);
  if (before.barrier != null) {
    throw new Error("index rebuild barrier is active; refusing orphan classification");
  }
  const files = await listStateFiles(storeDir);
  const after = await readManifestSet(connection);
  if (after.barrier != null) {
    throw new Error("index rebuild started during scan; rerun after it completes");
  }
  if (
    manifestFingerprint(before.manifests) !==
    manifestFingerprint(after.manifests)
  ) {
    throw new Error("index manifests changed during scan; rerun for a stable plan");
  }

  assertManifestCoverage(files, before.manifests);
  const classified = classifyIndexScopeFiles(files, before.manifests, {
    scanStartedAtMs,
  });
  const sumBytes = (items: ClassifiedIndexFile[]): number =>
    items.reduce((total, item) => total + item.bytes, 0);
  console.log(
    JSON.stringify(
      {
        mode: "read-only",
        generatedAt: new Date().toISOString(),
        storeDir,
        orphanEligibility: {
          minAgeMs: DEFAULT_ORPHAN_MIN_AGE_MS,
          cutoffMtimeMs: scanStartedAtMs - DEFAULT_ORPHAN_MIN_AGE_MS,
          reason:
            "recent unreferenced scopes may belong to a generation whose manifest has not published yet",
        },
        manifests: MANIFEST_LAYOUTS.map(({ key }, index) => ({
          key,
          generation: before.manifests[index]?.generation ?? null,
          shards: before.manifests[index]?.shards.length ?? 0,
          chars: before.manifests[index]?.chars ?? 0,
        })),
        referenced: {
          files: classified.referenced.length,
          bytes: sumBytes(classified.referenced),
        },
        orphans: {
          files: classified.orphans.length,
          bytes: sumBytes(classified.orphans),
          entries: classified.orphans,
        },
        deferredUnreferenced: {
          files: classified.deferred.length,
          bytes: sumBytes(classified.deferred),
          entries: classified.deferred,
        },
        nextStep:
          "Save this plan, stop AgentMemory in an approved maintenance window, back up the complete state store, and move only unchanged listed orphan files into a quarantine directory.",
      },
      null,
      2,
    ),
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
