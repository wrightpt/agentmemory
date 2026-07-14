#!/usr/bin/env node
import { resolveProjectContext } from "./_project.js";
import { submitObservation } from "./_observe.js";

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (isSdkChildContext(data)) return;
  const notificationType = data.notification_type ?? data.notificationType;
  if (notificationType !== "permission_prompt") return;

  const rawSessionId = data.session_id ?? data.sessionId;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0
      ? rawSessionId
      : "unknown";
  const context = resolveProjectContext(data.cwd as string | undefined);

  await submitObservation({
    hookType: "notification",
    sessionId,
    ...context,
    timestamp: new Date().toISOString(),
    data: {
      notification_type: notificationType,
      title: data.title,
      message: data.message,
    },
  });
}

main();
