# agentmemory (Python)

Thin Python REST client for the [agentmemory](https://github.com/rohitg00/agentmemory) daemon. Speaks the daemon's HTTP surface at `:3111` and nothing more — embedding, BM25, vector indexing, and lifecycle all live in the daemon. This package is a transport wrapper with typed responses.

## Install

```bash
pip install agentmemory
```

Requires Python 3.10+. The only runtime dependency is `httpx`.

## Quickstart

```python
from agentmemory import Client

c = Client(base_url="http://localhost:3111")

c.remember(
    content="iii-engine collapses workflow, queue, and agent runtimes into three primitives.",
    project="iii",
    title="Three primitives",
    concepts=["iii-engine", "primitives"],
)

result = c.smart_search(query="three primitives", project="iii", limit=10)
for hit in result.get("hits", []):
    print(hit["memory"]["title"])

c.health()
```

Async variant with identical surface:

```python
import asyncio
from agentmemory import AsyncClient

async def main():
    async with AsyncClient() as a:
        await a.remember(content="hello", project="x")
        print(await a.health())

asyncio.run(main())
```

## API surface

| Method                                 | HTTP                                  |
| -------------------------------------- | ------------------------------------- |
| `health()`                             | `GET /agentmemory/livez`              |
| `remember(content=..., ...)`           | `POST /agentmemory/remember`          |
| `smart_search(query=..., limit=...)`   | `POST /agentmemory/smart-search`      |
| `memories(project=..., latest=False)`  | `GET /agentmemory/memories`           |
| `memory(memory_id)`                    | `GET /agentmemory/memories/{id}`      |
| `forget(memory_id=...)`                | `POST /agentmemory/forget`            |
| `semantic()`                           | `GET /agentmemory/semantic`           |
| `procedural()`                         | `GET /agentmemory/procedural`         |
| `relations()`                          | `GET /agentmemory/relations`          |
| `request(method, path, json=..., ...)` | escape hatch for any other endpoint   |

The full daemon REST surface lives in [`src/triggers/api.ts`](https://github.com/rohitg00/agentmemory/blob/main/src/triggers/api.ts). Use `Client.request()` (or `AsyncClient.request()`) for endpoints not yet wrapped as typed methods.

## Environment variables

| Variable                     | Default                  | Effect                                                                                                                                                                                                  |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTMEMORY_URL`            | `http://localhost:3111`  | Resolved when `base_url=None` is passed to `Client`/`AsyncClient`.                                                                                                                                      |
| `AGENTMEMORY_SECRET`         | (unset)                  | Resolved when `api_key=None` is passed. Sent as `Authorization: Bearer <value>`.                                                                                                                        |
| `AGENTMEMORY_REQUIRE_HTTPS`  | `0`                      | When `1`, refuse to send a bearer token over plaintext HTTP to a non-loopback host (raises `AuthError`). When unset, the client warns once on stderr and still sends. Mirrors the v0.9.12 daemon guard. |

## Plaintext-bearer guard

When a bearer token would cross plaintext HTTP to anything other than `localhost` / `127.0.0.1` / `::1`, the client behaves like the v0.9.12 plugin guard:

- Default: one stderr warning per process, request proceeds.
- `AGENTMEMORY_REQUIRE_HTTPS=1`: `AuthError` raised at `Client` construction and before every request, no token is sent.

Loopback bearer + plaintext HTTP is silent — the typical local-daemon setup is treated as safe.

## Errors

All errors derive from `AgentMemoryError`:

- `AuthError` — `401`/`403` from the daemon, or guard refusal.
- `NetworkError` — connection refused, DNS failure, TLS error, timeout.
- `ResponseError` — non-2xx response with `status_code` and `body` attributes.

## Testing

```bash
pip install -e ".[dev]"
pytest packages/python/tests
```

Set `AGENTMEMORY_LIVE=1` to additionally hit a running daemon at `:3111` from `test_live_health_against_local_daemon`.

## License

Apache-2.0. Same as the daemon.
