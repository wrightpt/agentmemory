#!/usr/bin/env node
const entrypoint = process.argv.slice(2).some((arg) => arg === "--http" || arg === "http")
  ? "@agentmemory/agentmemory/dist/http.mjs"
  : "@agentmemory/agentmemory/dist/standalone.mjs";

import(entrypoint).then(async (module) => {
  if (entrypoint.endsWith("/http.mjs")) {
    await module.runMcpHttpServer();
  }
}).catch((err) => {
  console.error(
    `[@agentmemory/mcp] Failed to load ${entrypoint} from @agentmemory/agentmemory.`,
  );
  console.error(
    "[@agentmemory/mcp] Try installing manually: npm i -g @agentmemory/agentmemory",
  );
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
