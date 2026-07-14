const DEFAULT_ACK_TIMEOUT_MS = 500;
const MAX_ACK_TIMEOUT_MS = 5_000;

function ackTimeoutMs(): number {
  const configured = Number(
    process.env["AGENTMEMORY_HOOK_ACK_TIMEOUT_MS"] ?? DEFAULT_ACK_TIMEOUT_MS,
  );
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_ACK_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(Math.floor(configured), MAX_ACK_TIMEOUT_MS));
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = process.env["AGENTMEMORY_SECRET"] || "";
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  return headers;
}

export async function submitObservation(
  payload: Record<string, unknown>,
): Promise<void> {
  const restUrl = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
  try {
    const response = await fetch(`${restUrl}/agentmemory/observe/async`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ackTimeoutMs()),
    });
    await response.arrayBuffer();
  } catch {
    // Hook capture is best-effort and must never fail the host agent session.
  }
}
