export const FINDING_CAPTURE_EXCLUDED = "shared_findings_capture_excluded";

const FINDING_REFERENCES = /verified-shared-findings-v1|lsn_fnd_|fsnap_|\/agentmemory\/findings(?:\b|\/)|\bmem::finding-|\bmemory_finding_|\b(?:npm|pnpm|yarn|bun)(?:\s+[\w./=-]+){0,4}\s+findings\b|\bagentmemory\s+findings\b|(?:^|[/\\])shared-findings\.(?:ts|mjs|js)\b/i;
const JSON_ESCAPES = /\\u([0-9a-f]{4})|\\([/\\"bfnrt])/gi;
const ESCAPED_CHARACTERS: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function containsReference(value: string): boolean {
  let decoded = value;
  for (let depth = 0; depth < 8; depth++) {
    if (FINDING_REFERENCES.test(decoded)) return true;
    const next = decoded.replace(JSON_ESCAPES, (_match, unicode: string | undefined, escaped: string | undefined) =>
      unicode ? String.fromCharCode(Number.parseInt(unicode, 16)) : ESCAPED_CHARACTERS[escaped!] ?? escaped!);
    if (next === decoded) return false;
    decoded = next;
  }
  return true;
}

export function containsFindingCapture(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > 100_000) return true;
    const current = pending.pop();
    if (typeof current === "string") {
      if (containsReference(current)) return true;
    } else if (current !== null && typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);
      try {
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
          if (containsReference(key) || !Object.hasOwn(descriptor, "value")) return true;
          pending.push(descriptor.value);
        }
      } catch { return true; }
    }
  }
  return false;
}
