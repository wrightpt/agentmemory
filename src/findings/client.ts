import type { FindingProposal, FindingView } from './types.js';

export type FindingCommand = 'prepare' | 'publish' | 'snapshot' | 'expand' | 'correct';
export type FindingResponse = { success: true } & Record<string, unknown>;

export interface FindingClientOptions {
  url?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface FindingRequests {
  prepare: { view: FindingView; proposal: FindingProposal };
  publish: { view: FindingView; proposal: FindingProposal };
  snapshot: { view: FindingView; limit?: number; maxBytes?: number; snapshotId?: string };
  expand: {
    view: FindingView;
    snapshotId: string;
    lessonId: string;
    level: 'evidence' | 'raw';
    sourceIndex?: number;
    offset?: number;
    maxChars?: number;
  };
  correct: {
    view: FindingView;
    lessonId: string;
    reason: string;
    expectedUpdatedAt?: string;
    replacementLessonId?: string;
  };
}

export const FINDING_COMMANDS: readonly FindingCommand[] = [
  'prepare', 'publish', 'snapshot', 'expand', 'correct',
];
export const FINDING_REQUEST_MAX_BYTES = 256 * 1024;
const RESPONSE_MAX_BYTES = 512 * 1024;

export class FindingClientError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = 'FindingClientError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function endpointOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new FindingClientError('finding_invalid_url'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new FindingClientError('finding_invalid_url');
  }
  return url.origin;
}

function credential(value: string | undefined, required = false): string | undefined {
  if (!value && !required) return undefined;
  if (!value || value.length > 4096 || /[\r\n]/.test(value) || value.trim() !== value) {
    throw new FindingClientError('finding_credentials_required');
  }
  return value;
}

async function responseBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new FindingClientError('finding_invalid_response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new FindingClientError('finding_response_too_large');
      }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new FindingClientError('finding_invalid_response'); }
}

export class FindingClient {
  private readonly origin: string;
  private readonly headers: Record<string, string>;
  private readonly send: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: FindingClientOptions = {}) {
    this.origin = endpointOrigin(options.url ?? 'http://127.0.0.1:3111');
    const env = options.env ?? process.env;
    const token = credential(env.AGENTMEMORY_CALLER_TOKEN, true)!;
    const secret = credential(env.AGENTMEMORY_SECRET);
    this.headers = {
      'Content-Type': 'application/json',
      'X-AgentMemory-Caller-Token': token,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    };
    this.send = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new FindingClientError('finding_invalid_timeout');
    }
  }

  async request<T extends FindingCommand>(command: T, request: FindingRequests[T]): Promise<FindingResponse> {
    if (!FINDING_COMMANDS.includes(command)) throw new FindingClientError('finding_invalid_command');
    if (!object(request) || !object(request.view)) throw new FindingClientError('finding_invalid_request');
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body, 'utf8') > FINDING_REQUEST_MAX_BYTES) {
      throw new FindingClientError('finding_request_too_large');
    }
    try {
      const response = await this.send(`${this.origin}/agentmemory/findings/${command}`, {
        method: 'POST',
        headers: this.headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new FindingClientError('finding_request_rejected', response.status);
      }
      const result = await responseBody(response);
      if (!object(result) || result.success !== true) {
        throw new FindingClientError('finding_request_rejected', response.status);
      }
      return result as FindingResponse;
    } catch (error) {
      if (error instanceof FindingClientError) throw error;
      throw new FindingClientError('finding_transport_failed');
    }
  }
}
