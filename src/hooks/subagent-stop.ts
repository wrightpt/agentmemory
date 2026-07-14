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

  const sessionId = ((data.session_id || data.sessionId) as string) || "unknown";
  const agentId = data.agent_id || data.agentName;
  const agentType = data.agent_type || data.agentDisplayName || data.agentName;
  const lastMsg =
    typeof data.last_assistant_message === "string"
      ? data.last_assistant_message.slice(0, 4000)
      : "";
  const context = resolveProjectContext(data.cwd as string | undefined);

  await submitObservation({
    hookType: "subagent_stop",
    sessionId,
    ...context,
    timestamp: new Date().toISOString(),
    data: {
      agent_id: agentId,
      agent_type: agentType,
      last_message: lastMsg,
    },
  });
}

main();
