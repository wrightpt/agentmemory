import type { ApiRequest, ISdk } from 'iii-sdk';
import { resolveLessonBoundaryAccess, type LessonCallerPolicy } from '../functions/lesson-access.js';
import { parseFindingProposal } from '../findings/evidence.js';
import { parseFindingView } from '../findings/service.js';
import { FINDING_ROUTES } from '../findings/types.js';

type Response = { status_code: number; body: unknown };
const FIELDS = {
  prepare: [], publish: [],
  snapshot: ['snapshotId', 'limit', 'maxBytes'],
  expand: ['snapshotId', 'lessonId', 'level', 'sourceIndex', 'offset', 'maxChars'],
  correct: ['lessonId', 'reason', 'expectedUpdatedAt', 'replacementLessonId'],
} as const;

export function registerFindingApi(sdk: ISdk, checkAuth: (req: ApiRequest) => Response | null, options: { callerPolicy?: LessonCallerPolicy } = {}): void {
  for (const { operation, api_path, http_method } of FINDING_ROUTES) {
    sdk.registerFunction(`api::finding-${operation}`, async (req: ApiRequest) => {
      const denied = checkAuth(req);
      if (denied) return denied;
      const access = resolveLessonBoundaryAccess(req.headers as Record<string, string | string[] | undefined>, { mode: 'enforce', policy: options.callerPolicy });
      if (!access.success) return { status_code: access.statusCode, body: { success: false, code: access.code } };
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return { status_code: 400, body: { success: false, code: 'invalid_request' } };
      }
      const body = req.body as Record<string, unknown>;
      const payload: Record<string, unknown> = { accessContext: access.context };
      try {
        payload.view = parseFindingView(body.view);
        if (operation === 'prepare' || operation === 'publish') payload.proposal = parseFindingProposal(body.proposal);
        for (const field of FIELDS[operation]) {
          if (body[field] !== undefined) payload[field] = body[field];
        }
      } catch { return { status_code: 400, body: { success: false, code: 'invalid_request' } }; }
      const result = await sdk.trigger({ function_id: `mem::finding-${operation}`, payload }) as { success?: boolean; code?: string };
      const status = result.success ? 200 : result.code === 'access_denied' ? 403 :
        result.code === 'finding_policy_unavailable' ? 503 : 409;
      return { status_code: status, body: result };
    });
    sdk.registerTrigger({ type: 'http', function_id: `api::finding-${operation}`,
      config: { api_path, http_method } });
  }
}
