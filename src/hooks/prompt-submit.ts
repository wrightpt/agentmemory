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
  const context = resolveProjectContext(data.cwd as string | undefined);
  const prompt = data.prompt ?? data.userPrompt;
  const promptData = promptCapture(prompt);

  await submitObservation({
    hookType: "prompt_submit",
    sessionId,
    ...context,
    timestamp: new Date().toISOString(),
    data: promptData,
  });
}

function promptCapture(value: unknown): Record<string, unknown> {
  const text = typeof value === "string" ? value : "";
  const mode = (process.env["AGENTMEMORY_CAPTURE_PROMPTS"] || "full").toLowerCase();
  if (mode === "off" || mode === "metadata") {
    return { prompt_length: text.length, prompt_capture: mode };
  }
  const max = Number(process.env["AGENTMEMORY_MAX_PROMPT_CAPTURE_CHARS"] || "4000");
  const limit = Number.isFinite(max) && max >= 0 ? Math.min(Math.floor(max), 16_000) : 4000;
  return { prompt: text.slice(0, limit) };
}

main();
