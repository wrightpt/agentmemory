import { AsyncLocalStorage } from "node:async_hooks";
import { KV } from "./schema.js";

export const MAINTENANCE_REFERENCE_SCOPES = [
  KV.memories, KV.actions, KV.lessons, KV.relations,
  KV.semantic, KV.procedural, KV.insights, KV.crystals,
] as const;

const guardedScopes = new Set<string>([
  ...MAINTENANCE_REFERENCE_SCOPES, KV.accessLog, KV.leases,
]);

interface Commit {
  active: boolean;
  invalidated: Set<string>;
  finished: Promise<void>;
  release: () => void;
}

export class MaintenanceConflictError extends Error {
  readonly retryable = true;
  constructor() {
    super("maintenance_write_conflict: reload the record before retrying");
  }
}

export class MaintenanceBarrier {
  private revision = 0;
  private writers = 0;
  private uncertainWrite = false;
  private commit?: Commit;
  private context = new AsyncLocalStorage<Commit>();

  snapshot(): number { return this.revision; }
  get needsReconciliation(): boolean { return this.uncertainWrite; }

  async mutate<T>(
    scope: string, key: string, value: unknown, operation: () => Promise<T>,
  ): Promise<T> {
    if (!guardedScopes.has(scope)) return operation();
    const own = this.context.getStore();
    if (own?.active && own === this.commit) return operation();
    while (this.commit) {
      const pending = this.commit;
      await pending.finished;
      const serialized = JSON.stringify(value) ?? "";
      if ([...pending.invalidated].some(id => key === id || serialized.includes(id))) {
        throw new MaintenanceConflictError();
      }
    }
    this.writers++;
    this.revision++;
    try { return await operation(); }
    catch (error) { this.uncertainWrite = true; throw error; }
    finally { this.writers--; this.revision++; }
  }

  async tryCommit<T>(
    expectedRevision: number,
    operation: (invalidate: (id: string) => void) => Promise<T>,
  ): Promise<{ committed: false } | { committed: true; value: T }> {
    if (this.uncertainWrite || this.commit || this.writers || this.revision !== expectedRevision) {
      return { committed: false };
    }
    let release!: () => void;
    const commit: Commit = {
      active: true, invalidated: new Set(),
      finished: new Promise<void>(resolve => { release = resolve; }),
      release: () => release(),
    };
    this.commit = commit;
    this.revision++;
    try {
      const value = await this.context.run(commit, () => operation(id => commit.invalidated.add(id)));
      return { committed: true, value };
    } catch (error) {
      this.uncertainWrite = true;
      throw error;
    } finally {
      commit.active = false;
      this.commit = undefined;
      this.revision++;
      commit.release();
    }
  }
}

const barriers = new WeakMap<object, MaintenanceBarrier>();
export function maintenanceBarrierFor(sdk: object): MaintenanceBarrier {
  let barrier = barriers.get(sdk);
  if (!barrier) { barrier = new MaintenanceBarrier(); barriers.set(sdk, barrier); }
  return barrier;
}
