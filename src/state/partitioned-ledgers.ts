import { createHash } from "node:crypto";
import type {
  AuditEntry,
  ActionEvent,
  ActionEventLocation,
} from "../types.js";
import { KV } from "./schema.js";

export type LedgerKV = {
  get<T = unknown>(scope: string, key: string): Promise<T | null>;
  set<T = unknown>(scope: string, key: string, value: T): Promise<T>;
  delete(scope: string, key: string): Promise<void>;
  list<T = unknown>(scope: string): Promise<T[]>;
  listGroups?(): Promise<string[]>;
};

export type PartitionedLedgerEntry<T> = {
  scope: string;
  value: T;
};

const AUDIT_DAY_SCOPE = /^mem:audit:day:\d{4}-\d{2}-\d{2}$/;
const ACTION_EVENT_PARTITION_SCOPE =
  /^mem:action-events:(?:month:\d{4}-\d{2}|import):b\d{2}$/;
const ACTION_EVENT_BUCKET_COUNT = 64;
const ACTION_EVENT_LOCATION_SCHEMA_VERSION = 1;

function partitionWritesEnabled(kv: LedgerKV): boolean {
  const mode = process.env.AGENTMEMORY_LEDGER_WRITE_MODE ?? "partitioned";
  if (mode !== "partitioned" && mode !== "legacy") {
    throw new Error(`Invalid AGENTMEMORY_LEDGER_WRITE_MODE: ${mode}`);
  }
  return Boolean(kv.listGroups) && mode === "partitioned";
}

function normalizedUtcTimestamp(timestamp: string): Date {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ledger timestamp: ${timestamp}`);
  }
  const iso = parsed.toISOString();
  if (!/^\d{4}-/.test(iso)) {
    throw new Error(`Ledger timestamp is outside the partition range: ${timestamp}`);
  }
  return parsed;
}

export function auditPartitionScope(timestamp: string): string {
  const day = normalizedUtcTimestamp(timestamp).toISOString().slice(0, 10);
  return KV.auditPartition(day);
}

function stableBucket(value: string): string {
  const prefix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  const bucket = Number.parseInt(prefix, 16) % ACTION_EVENT_BUCKET_COUNT;
  return `b${String(bucket).padStart(2, "0")}`;
}

export function actionEventBucket(actionId: string): string {
  return stableBucket(actionId);
}

export function actionEventLocationScope(eventId: string): string {
  return KV.actionEventLocations(stableBucket(eventId));
}

export function actionEventPartitionScope(
  timestamp: string,
  actionId: string,
): string {
  const month = normalizedUtcTimestamp(timestamp).toISOString().slice(0, 7);
  return KV.actionEventsPartition(month, actionEventBucket(actionId));
}

export function actionEventImportPartitionScope(actionId: string): string {
  return KV.actionEventsImportPartition(actionEventBucket(actionId));
}

export function isAuditPartitionScope(scope: string): boolean {
  return AUDIT_DAY_SCOPE.test(scope);
}

export function isActionEventPartitionScope(scope: string): boolean {
  return ACTION_EVENT_PARTITION_SCOPE.test(scope);
}

async function partitionScopes(
  kv: LedgerKV,
  predicate: (scope: string) => boolean,
): Promise<string[]> {
  if (!kv.listGroups) return [];
  return (await kv.listGroups()).filter(predicate).sort();
}

async function listEntries<T>(
  kv: LedgerKV,
  scopes: string[],
): Promise<Array<PartitionedLedgerEntry<T>>> {
  const entries: Array<PartitionedLedgerEntry<T>> = [];
  for (const scope of scopes) {
    const values = await kv.list<T>(scope);
    entries.push(...values.map((value) => ({ scope, value })));
  }
  return entries;
}

function dedupeById<T extends { id: string }>(
  entries: Array<PartitionedLedgerEntry<T>>,
): T[] {
  const byId = new Map<string, T>();
  for (const entry of entries) byId.set(entry.value.id, entry.value);
  return [...byId.values()];
}

export async function writeAuditEntry(
  kv: LedgerKV,
  entry: AuditEntry,
): Promise<AuditEntry> {
  const scope = partitionWritesEnabled(kv)
    ? auditPartitionScope(entry.timestamp)
    : KV.audit;
  return kv.set(scope, entry.id, entry);
}

export async function listAuditLedgerEntries(
  kv: LedgerKV,
): Promise<Array<PartitionedLedgerEntry<AuditEntry>>> {
  const scopes = [KV.audit, ...(await partitionScopes(kv, isAuditPartitionScope))];
  return listEntries<AuditEntry>(kv, scopes);
}

export async function listAuditEntries(kv: LedgerKV): Promise<AuditEntry[]> {
  return dedupeById(await listAuditLedgerEntries(kv));
}

export function actionEventStorageScope(
  kv: LedgerKV,
  event: ActionEvent,
  imported = false,
): string {
  if (!partitionWritesEnabled(kv)) return KV.actionEvents;
  return imported
    ? actionEventImportPartitionScope(event.actionId)
    : actionEventPartitionScope(event.timestamp, event.actionId);
}

function isValidActionEventLocation(
  value: ActionEventLocation | null,
  eventId: string,
): value is ActionEventLocation {
  return Boolean(
    value &&
      value.schemaVersion === ACTION_EVENT_LOCATION_SCHEMA_VERSION &&
      value.eventId === eventId &&
      typeof value.actionId === "string" &&
      typeof value.timestamp === "string" &&
      (value.scope === KV.actionEvents ||
        isActionEventPartitionScope(value.scope)),
  );
}

export async function writeActionEventLocation(
  kv: LedgerKV,
  event: ActionEvent,
  scope = actionEventStorageScope(kv, event),
): Promise<void> {
  if (!kv.listGroups) return;
  const location: ActionEventLocation = {
    schemaVersion: ACTION_EVENT_LOCATION_SCHEMA_VERSION,
    eventId: event.id,
    actionId: event.actionId,
    timestamp: event.timestamp,
    scope,
  };
  await kv.set(actionEventLocationScope(event.id), event.id, location);
}

export async function deleteActionEventLocation(
  kv: LedgerKV,
  eventId: string,
): Promise<void> {
  if (!kv.listGroups) return;
  await kv.delete(actionEventLocationScope(eventId), eventId);
}

export async function writeActionEvent(
  kv: LedgerKV,
  event: ActionEvent,
  options: { imported?: boolean } = {},
): Promise<ActionEvent> {
  const scope = actionEventStorageScope(kv, event, options.imported);
  // Publish the tiny locator first. If the event write fails, a retry can
  // safely replace the dangling derived row; if the event commits before a
  // timeout, the locator preserves global event-ID conflict detection.
  await writeActionEventLocation(kv, event, scope);
  return kv.set(scope, event.id, event);
}

export async function listActionEventLedgerEntries(
  kv: LedgerKV,
): Promise<Array<PartitionedLedgerEntry<ActionEvent>>> {
  const scopes = [
    KV.actionEvents,
    ...(await partitionScopes(kv, isActionEventPartitionScope)),
  ];
  return listEntries<ActionEvent>(kv, scopes);
}

function sortActionEvents(events: ActionEvent[]): ActionEvent[] {
  return events.sort(
    (left, right) =>
      left.revision - right.revision ||
      left.timestamp.localeCompare(right.timestamp) ||
      left.id.localeCompare(right.id),
  );
}

export async function listActionEvents(kv: LedgerKV): Promise<ActionEvent[]> {
  return sortActionEvents(dedupeById(await listActionEventLedgerEntries(kv)));
}

export async function listActionEventsForAction(
  kv: LedgerKV,
  actionId: string,
): Promise<ActionEvent[]> {
  const bucket = actionEventBucket(actionId);
  const partitionedScopes = (
    await partitionScopes(kv, isActionEventPartitionScope)
  ).filter((scope) => scope.endsWith(`:${bucket}`));
  const entries = await listEntries<ActionEvent>(kv, partitionedScopes);
  const partitioned = dedupeById(entries).filter(
    (event) => event.actionId === actionId,
  );

  // A write-mode rollback can append legacy events even for actions born in
  // partitions. Imports and migrations also make creation rows insufficient
  // evidence that the legacy collection contains no relevant history.
  const legacy = (await kv.list<ActionEvent>(KV.actionEvents)).filter(
    (event) => event.actionId === actionId,
  );
  return sortActionEvents(
    dedupeById([
      ...legacy.map((value) => ({ scope: KV.actionEvents, value })),
      ...partitioned.map((value) => ({
        scope: "partitioned",
        value,
      })),
    ]),
  );
}

export async function getActionEvent(
  kv: LedgerKV,
  eventId: string,
  options: {
    timestamp?: string;
    actionId?: string;
    scopeHint?: string;
  } = {},
): Promise<ActionEvent | null> {
  const scopes = new Set<string>();
  if (
    options.scopeHint === KV.actionEvents ||
    (options.scopeHint && isActionEventPartitionScope(options.scopeHint))
  ) {
    scopes.add(options.scopeHint);
  }
  if (options.timestamp && options.actionId) {
    try {
      scopes.add(actionEventPartitionScope(options.timestamp, options.actionId));
    } catch {
      // Imported event timestamps may be outside the online partition calendar.
    }
    scopes.add(actionEventImportPartitionScope(options.actionId));
  }
  scopes.add(KV.actionEvents);
  if (kv.listGroups) {
    const location = await kv.get<ActionEventLocation>(
      actionEventLocationScope(eventId),
      eventId,
    );
    if (isValidActionEventLocation(location, eventId)) {
      scopes.add(location.scope);
    }
  }
  if (!options.scopeHint && !(options.timestamp && options.actionId)) {
    for (const scope of await partitionScopes(kv, isActionEventPartitionScope)) {
      scopes.add(scope);
    }
  }
  for (const scope of scopes) {
    const event = await kv.get<ActionEvent>(scope, eventId);
    if (event) return event;
  }
  return null;
}
