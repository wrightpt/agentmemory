# @agentmemory/mcp

Standalone MCP server for [agentmemory](https://github.com/rohitg00/agentmemory).

This is a thin shim package that re-exposes the standalone MCP entrypoint from
[`@agentmemory/agentmemory`](https://www.npmjs.com/package/@agentmemory/agentmemory),
so MCP client configs that say `npx @agentmemory/mcp` work out of the box
without installing the full package first.

## Usage

```bash
npx -y @agentmemory/mcp
```

To expose the running AgentMemory engine through a stateless Streamable HTTP endpoint instead of stdio:

```bash
npx -y @agentmemory/mcp --http
# http://127.0.0.1:3114/mcp
```

Or wire it into your MCP client (Claude Desktop, OpenClaw, Cursor, Codex, etc.):

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["-y", "@agentmemory/mcp"]
    }
  }
}
```

This package depends on `@agentmemory/agentmemory` and forwards to its
`dist/standalone.mjs` entrypoint. If you already have `@agentmemory/agentmemory`
installed, you can call the same entrypoint directly:

```bash
npx @agentmemory/agentmemory mcp
```

The two stdio commands do the same thing. The `--http` form requires the full AgentMemory engine at `AGENTMEMORY_URL` and never creates a separate local fallback store. Set `AGENTMEMORY_SECRET` for bridge-to-engine authentication and, independently, `AGENTMEMORY_MCP_HTTP_TOKEN` if the MCP listener itself should require a bearer token.

## Why does this package exist?

The original plan in [issue #120](https://github.com/rohitg00/agentmemory/issues/120)
was to publish `agentmemory-mcp` as an unscoped package, but npm's name-similarity
policy blocks that name because of an unrelated package called `agent-memory-mcp`.
Publishing under the `@agentmemory` scope sidesteps the conflict and keeps the
"dedicated standalone package" UX — `npx @agentmemory/mcp` is one character
longer than `npx agentmemory-mcp` and works on the live registry.

## License

Apache-2.0
