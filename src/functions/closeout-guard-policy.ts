import type { StateKV } from '../state/kv.js';
import { KV } from '../state/schema.js';
import { getWorkAuthority } from '../state/work-authority.js';
import { isCanonicalProjectId } from './action-model.js';
import { fingerprint, timestamp, validRows } from './stale-cleanup-policy.js';

export const CLOSEOUT_GUARD_PROTOCOL = 'closeout-guard/v1';
export interface CloseoutGuardRequest {
  protocol: typeof CLOSEOUT_GUARD_PROTOCOL;
  requestId: string;
  session: string;
  projectIds: string[];
}
export class CloseoutGuardError extends Error {
  constructor(readonly code: string) { super(code); }
}
export const guardFail: (code: string) => never = code => { throw new CloseoutGuardError(code); };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const optionalText = (value: unknown): string | null => {
  if (value === undefined || value === '') return null;
  if (!text(value)) guardFail('closeout_guard_invalid_inventory');
  return value as string;
};
const enumText = (value: unknown, allowed: readonly string[]): string => {
  if (typeof value !== 'string' || !allowed.includes(value)) return guardFail('closeout_guard_invalid_inventory');
  return value;
};
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const sortedStrings = (value: unknown, maximum: number): string[] => {
  if (!Array.isArray(value) || value.length > maximum || !value.every(text)
      || new Set(value).size !== value.length) guardFail('closeout_guard_invalid_inventory');
  return [...value as string[]].sort();
};

export function parseGuardRequest(value: unknown): CloseoutGuardRequest {
  if (!object(value) || value.protocol !== CLOSEOUT_GUARD_PROTOCOL
      || typeof value.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId)
      || typeof value.session !== 'string' || !/^shared-auto-launch-interactive-[A-Za-z0-9._-]{1,192}$/.test(value.session)
      || !Array.isArray(value.projectIds) || value.projectIds.length > 64
      || !value.projectIds.every(p => typeof p === 'string' && p.length <= 128 && isCanonicalProjectId(p))
      || new Set(value.projectIds).size !== value.projectIds.length) guardFail('closeout_guard_invalid_request');
  return { protocol: CLOSEOUT_GUARD_PROTOCOL, requestId: value.requestId as string,
    session: value.session as string, projectIds: [...value.projectIds as string[]].sort() };
}

export function closeoutAliases(session: string): string[] {
  return [...new Set([session, `wsh:${session}`, `wsh:${session.slice(0, 128)}`])].sort();
}

async function authoritySnapshot(kv: StateKV, projectId: string) {
  const row = await getWorkAuthority(kv, projectId);
  if (!row) return { projectId, phase: 'agentmemory', generation: 0, authority: null };
  const selectedIds = sortedStrings(row.selectedIds, 1000), deferredIds = sortedStrings(row.deferredIds, 1000);
  const heldClaimIds = sortedStrings(row.heldClaimIds, 1000);
  if (!natural(row.generation) || !natural(row.sourceRevision) || !hash(row.planDigest) || !hash(row.sourceDigest)
      || !/^[a-z][a-z0-9]{1,7}$/.test(row.prefix)
      || [...selectedIds, ...deferredIds, ...heldClaimIds].some(id => !/^act_[A-Za-z0-9_]+$/.test(id))
      || new Set([...selectedIds, ...deferredIds]).size !== selectedIds.length + deferredIds.length
      || !heldClaimIds.every(id => selectedIds.includes(id) || deferredIds.includes(id))) guardFail('closeout_guard_invalid_authority');
  const authority: Record<string, unknown> = { protocol: row.protocol, projectId, phase: row.phase,
    generation: row.generation, prefix: row.prefix, planDigest: row.planDigest, sourceDigest: row.sourceDigest,
    sourceRevision: row.sourceRevision, selectedIds, deferredIds, heldClaimIds };
  if (row.selectionMode !== undefined) authority.selectionMode = row.selectionMode;
  if (row.phase === 'beads') {
    if (!hash(row.receiptDigest) || !Array.isArray(row.mapping) || row.mapping.length !== selectedIds.length
        || row.mapping.some(m => !object(m) || !selectedIds.includes(m.sourceActionId)
          || !new RegExp(`^${row.prefix}-[a-z0-9]+$`).test(m.beadId))
        || new Set(row.mapping.map(m => m.sourceActionId)).size !== selectedIds.length
        || new Set(row.mapping.map(m => m.beadId)).size !== selectedIds.length) guardFail('closeout_guard_invalid_authority');
    authority.receiptDigest = row.receiptDigest;
    authority.mapping = row.mapping.map(m => ({ sourceActionId: m.sourceActionId, beadId: m.beadId }))
      .sort((a, b) => a.sourceActionId.localeCompare(b.sourceActionId));
    if (row.deferredTrackingId !== undefined) {
      if (!new RegExp(`^${row.prefix}-[a-z0-9]+$`).test(row.deferredTrackingId)) guardFail('closeout_guard_invalid_authority');
      authority.deferredTrackingId = row.deferredTrackingId;
    }
  }
  return { projectId, phase: row.phase, generation: row.generation, authority };
}

export async function captureGuardSnapshot(kv: StateKV, request: CloseoutGuardRequest, actionRevision: number, now: number) {
  if (!natural(actionRevision)) guardFail('closeout_guard_invalid_inventory');
  const [actionRows, leaseRows, workAuthority] = await Promise.all([
    kv.list(KV.actions), kv.list(KV.leases), Promise.all(request.projectIds.map(id => authoritySnapshot(kv, id))),
  ]);
  const actions = validRows(actionRows, 20_000).map(row => {
    const status = enumText(row.status, ['pending', 'active', 'done', 'blocked', 'cancelled']);
    const lifecycle = row.lifecycle === undefined ? null : enumText(row.lifecycle, ['pending', 'active', 'done', 'cancelled']);
    if ((row.revision !== undefined && !natural(row.revision))
        || (lifecycle !== null && ['done', 'cancelled'].includes(status) !== ['done', 'cancelled'].includes(lifecycle))) {
      guardFail('closeout_guard_invalid_inventory');
    }
    return { id: row.id as string, revision: row.revision ?? null, status,
      lifecycle, projectId: optionalText(row.projectId) || optionalText(row.project),
      owner: optionalText(row.owner), assignedTo: optionalText(row.assignedTo), tags: sortedStrings(row.tags, 256) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const leases = validRows(leaseRows, 20_000).map(row => {
    const status = enumText(row.status, ['active', 'expired', 'released']);
    const acquired = timestamp(row.acquiredAt), expires = timestamp(row.expiresAt);
    const renewed = row.renewedAt === undefined ? acquired : timestamp(row.renewedAt);
    if (!text(row.actionId) || !text(row.agentId)
        || ![acquired, expires, renewed].every(Number.isFinite) || expires < acquired || renewed < acquired || renewed > expires) {
      guardFail('closeout_guard_invalid_inventory');
    }
    return { id: row.id as string, actionId: row.actionId as string, agentId: row.agentId as string,
      status, acquiredAt: row.acquiredAt as string, expiresAt: row.expiresAt as string,
      renewedAt: row.renewedAt ?? null };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const aliases = closeoutAliases(request.session);
  const tags = [`tmux:${request.session}`, `tmux:${request.session.slice(0, 128)}`];
  const claims = actions.filter(a => !['done', 'cancelled'].includes(a.lifecycle ?? a.status)
    && (aliases.includes(a.owner || '') || aliases.includes(a.assignedTo || '') || tags.some(t => a.tags.includes(t))));
  const activeLeases = leases.filter(l => aliases.includes(l.agentId) && l.status === 'active' && timestamp(l.expiresAt) > now);
  if (claims.length || activeLeases.length) guardFail('closeout_guard_session_claimed');
  return { version: 1, session: request.session, aliases, actionRevision,
    actions: { count: actions.length, digest: fingerprint(actions) },
    leases: { count: leases.length, digest: fingerprint(leases) }, claims, activeLeases, workAuthority };
}
