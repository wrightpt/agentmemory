"""Tests for ``Client`` and ``AsyncClient``.

Network is mocked via ``respx`` so every assertion exercises the real
``httpx`` transport stack — there are no hand-rolled fakes. Sync and async
both flow through the same helper to keep the parity assertions honest.
"""

from __future__ import annotations

import os

import httpx
import pytest
import respx

from agentmemory import (
    AsyncClient,
    AuthError,
    Client,
    NetworkError,
    ResponseError,
)


BASE = "http://localhost:3111"


def _route(_mock, method: str, path: str, status: int, body, *, base: str = BASE):
    """Register a respx route on the global mock router.

    The ``@respx.mock`` decorator patches the module-level transport, so we
    use ``respx.route`` (not the ``respx.router`` module) to register
    expectations. The first arg is kept for call-site readability.
    """

    return respx.route(method=method, url=f"{base}{path}").mock(
        return_value=httpx.Response(status, json=body)
    )


# --- sync surface ---------------------------------------------------------


@respx.mock
def test_health_returns_livez_body():
    _route(respx.router, "GET", "/agentmemory/livez", 200, {"ok": True})
    with Client(base_url=BASE) as c:
        assert c.health() == {"ok": True}


@respx.mock
def test_remember_strips_none_and_sends_post():
    route = _route(
        respx.router,
        "POST",
        "/agentmemory/remember",
        201,
        {"id": "m1", "created": True},
    )
    with Client(base_url=BASE) as c:
        result = c.remember(
            content="hello",
            project="proj",
            title="note",
            concepts=["a"],
        )
    assert result == {"id": "m1", "created": True}
    sent = route.calls[0].request
    assert sent.headers["content-type"] == "application/json"
    import json as _json

    assert _json.loads(sent.content) == {
        "content": "hello",
        "project": "proj",
        "title": "note",
        "concepts": ["a"],
    }


@respx.mock
def test_smart_search_passes_expand_ids():
    route = _route(
        respx.router,
        "POST",
        "/agentmemory/smart-search",
        200,
        {"hits": []},
    )
    with Client(base_url=BASE) as c:
        c.smart_search(expand_ids=["m1", "m2"], limit=5)
    import json as _json

    body = _json.loads(route.calls[0].request.content)
    assert body == {"expandIds": ["m1", "m2"], "limit": 5}


@respx.mock
def test_memories_latest_query_string():
    route = _route(
        respx.router,
        "GET",
        "/agentmemory/memories",
        200,
        {"memories": []},
    )
    with Client(base_url=BASE) as c:
        c.memories(project="proj", latest=True, limit=10)
    sent = route.calls[0].request
    assert sent.url.params["project"] == "proj"
    assert sent.url.params["latest"] == "true"
    assert sent.url.params["limit"] == "10"


@respx.mock
def test_memory_by_id_path_encoding():
    _route(
        respx.router,
        "GET",
        "/agentmemory/memories/abc-123",
        200,
        {"memory": {"id": "abc-123"}},
    )
    with Client(base_url=BASE) as c:
        result = c.memory("abc-123")
    assert result["memory"]["id"] == "abc-123"


@respx.mock
def test_forget_sends_memory_id():
    route = _route(
        respx.router,
        "POST",
        "/agentmemory/forget",
        200,
        {"forgotten": 1, "ids": ["m1"]},
    )
    with Client(base_url=BASE) as c:
        c.forget(memory_id="m1")
    import json as _json

    assert _json.loads(route.calls[0].request.content) == {"memoryId": "m1"}


@respx.mock
def test_bearer_header_set_when_api_key_provided():
    route = _route(respx.router, "GET", "/agentmemory/livez", 200, {"ok": True})
    with Client(base_url=BASE, api_key="secret123") as c:
        c.health()
    assert route.calls[0].request.headers["authorization"] == "Bearer secret123"


@respx.mock
def test_no_authorization_header_when_no_api_key():
    route = _route(respx.router, "GET", "/agentmemory/livez", 200, {"ok": True})
    with Client(base_url=BASE) as c:
        c.health()
    assert "authorization" not in route.calls[0].request.headers


@respx.mock
def test_non_2xx_raises_response_error_with_body():
    _route(
        respx.router,
        "POST",
        "/agentmemory/remember",
        400,
        {"error": "content is required"},
    )
    with Client(base_url=BASE) as c:
        with pytest.raises(ResponseError) as exc_info:
            c.remember(content="x")
    assert exc_info.value.status_code == 400
    assert exc_info.value.body == {"error": "content is required"}


@respx.mock
def test_401_raises_auth_error():
    _route(respx.router, "GET", "/agentmemory/livez", 401, {"error": "no token"})
    with Client(base_url=BASE, api_key="bad") as c:
        with pytest.raises(AuthError):
            c.health()


def test_network_error_when_connect_refused():
    # Pick a port that's almost certainly closed.
    c = Client(base_url="http://127.0.0.1:1", timeout=0.5)
    with pytest.raises(NetworkError):
        c.health()


@respx.mock
def test_escape_hatch_request_method():
    _route(respx.router, "POST", "/agentmemory/custom", 200, {"ok": 1})
    with Client(base_url=BASE) as c:
        assert c.request("POST", "custom", json={"k": "v"}) == {"ok": 1}


@respx.mock
def test_env_var_resolves_base_url(monkeypatch):
    monkeypatch.setenv("AGENTMEMORY_URL", "http://localhost:9999")
    respx.route(
        method="GET", url="http://localhost:9999/agentmemory/livez"
    ).mock(return_value=httpx.Response(200, json={"ok": True}))
    with Client() as c:
        assert c.base_url == "http://localhost:9999"
        assert c.health() == {"ok": True}


@respx.mock
def test_env_var_resolves_api_key(monkeypatch):
    monkeypatch.setenv("AGENTMEMORY_SECRET", "from-env")
    route = _route(respx.router, "GET", "/agentmemory/livez", 200, {"ok": True})
    with Client(base_url=BASE) as c:
        c.health()
    assert route.calls[0].request.headers["authorization"] == "Bearer from-env"


# --- async surface --------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_async_health():
    _route(respx.router, "GET", "/agentmemory/livez", 200, {"ok": True})
    async with AsyncClient(base_url=BASE) as c:
        assert await c.health() == {"ok": True}


@pytest.mark.asyncio
@respx.mock
async def test_async_remember_and_forget():
    _route(
        respx.router,
        "POST",
        "/agentmemory/remember",
        201,
        {"id": "m1"},
    )
    _route(
        respx.router,
        "POST",
        "/agentmemory/forget",
        200,
        {"forgotten": 1, "ids": ["m1"]},
    )
    async with AsyncClient(base_url=BASE) as c:
        r = await c.remember(content="hello", project="p")
        f = await c.forget(memory_id=r["id"])
    assert r["id"] == "m1"
    assert f["forgotten"] == 1


@pytest.mark.asyncio
@respx.mock
async def test_async_smart_search_with_extra_payload():
    route = _route(
        respx.router,
        "POST",
        "/agentmemory/smart-search",
        200,
        {"hits": []},
    )
    async with AsyncClient(base_url=BASE) as c:
        await c.smart_search(query="q", extra={"futureField": 1})
    import json as _json

    body = _json.loads(route.calls[0].request.content)
    assert body == {"query": "q", "futureField": 1}


# --- optional live test ---------------------------------------------------


@pytest.mark.skipif(
    os.environ.get("AGENTMEMORY_LIVE") != "1",
    reason="set AGENTMEMORY_LIVE=1 to hit a running daemon at :3111",
)
def test_live_health_against_local_daemon():
    c = Client()
    assert c.health() is not None
