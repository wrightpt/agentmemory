import type { ISdk, TriggerRequest } from "iii-sdk";
import { logger } from "../logger.js";

type TrackedTriggerRequest<TInput> = Omit<TriggerRequest<TInput>, "action"> & {
  action?: never;
};

// iii-engine 0.11.2 tracks action:void work in the worker's invocation set but
// intentionally receives no InvocationResult to remove it. A regular trigger
// keeps the caller non-blocking while preserving the cleanup acknowledgement.
export function triggerDetached<TInput>(
  sdk: Pick<ISdk, "trigger">,
  request: TrackedTriggerRequest<TInput>,
  context: Record<string, unknown> = {},
): void {
  void sdk.trigger(request).catch((error: unknown) => {
    logger.warn("Detached trigger failed", {
      functionId: request.function_id,
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
