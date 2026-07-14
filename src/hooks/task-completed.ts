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

  const sessionId = (data.session_id as string) || "unknown";
  const context = resolveProjectContext(data.cwd as string | undefined);

  await submitObservation({
    hookType: "task_completed",
    sessionId,
    ...context,
    timestamp: new Date().toISOString(),
    data: {
      task_id: data.task_id,
      task_subject: data.task_subject,
      task_description: typeof data.task_description === "string"
        ? data.task_description.slice(0, 2000)
        : "",
      teammate_name: data.teammate_name,
      team_name: data.team_name,
    },
  });
}

main();
