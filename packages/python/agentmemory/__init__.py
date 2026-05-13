"""Thin Python REST client for the agentmemory daemon.

The package wraps the ``:3111`` HTTP surface served by the agentmemory
daemon and exposes a sync ``Client`` and an async ``AsyncClient`` with the
same method set. No embedding logic, no BM25, no vector index — the daemon
owns all of that; this is a transport wrapper with typed responses.

Quickstart:

.. code-block:: python

    from agentmemory import Client

    c = Client(base_url="http://localhost:3111")
    c.remember(content="iii-engine uses three primitives", project="iii")
    hits = c.smart_search(query="three primitives", project="iii", limit=10)
    for h in hits.get("hits", []):
        print(h["memory"]["title"])

See ``README.md`` for the full method list and environment-variable
reference (``AGENTMEMORY_URL``, ``AGENTMEMORY_SECRET``,
``AGENTMEMORY_REQUIRE_HTTPS``).
"""

from __future__ import annotations

from typing import Any, List, Mapping, Optional

from ._exceptions import AgentMemoryError, AuthError, NetworkError, ResponseError
from ._http import DEFAULT_BASE_URL, DEFAULT_TIMEOUT, HttpCore
from ._types import (
    ForgetResult,
    HealthResponse,
    JSONObject,
    LivezResponse,
    Memory,
    MemoriesResponse,
    MemoryRelation,
    MemoryResponse,
    ProceduralListResponse,
    ProceduralMemory,
    RelationsListResponse,
    RememberResult,
    SemanticListResponse,
    SemanticMemory,
    SmartSearchHit,
    SmartSearchResult,
)

__version__ = "0.1.0"
_USER_AGENT = f"agentmemory-py/{__version__}"


def _drop_none(payload: Mapping[str, Any]) -> dict:
    """Strip keys whose value is ``None``.

    The daemon treats missing keys and explicit ``null`` values differently
    for several endpoints; this matches the TypeScript client which only
    sends fields the caller passed.
    """

    return {k: v for k, v in payload.items() if v is not None}


class Client:
    """Synchronous REST client for the agentmemory daemon.

    All methods are thin wrappers around ``POST``/``GET`` of the
    corresponding endpoint under ``/agentmemory/*``. Construction does not
    open a network connection — the first method call does. Use as a
    context manager to close the underlying ``httpx.Client`` deterministically.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._core = HttpCore(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            user_agent=_USER_AGENT,
        )

    @property
    def base_url(self) -> str:
        return self._core.base_url

    def close(self) -> None:
        self._core.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def health(self) -> LivezResponse:
        """Return the daemon's ``/livez`` snapshot.

        Calls ``GET /agentmemory/livez``. Returns the parsed JSON; raises
        ``NetworkError`` if the daemon is unreachable.
        """

        _, body = self._core.request_sync("GET", "/agentmemory/livez")
        return body  # type: ignore[no-any-return]

    def remember(
        self,
        *,
        content: str,
        project: Optional[str] = None,
        title: Optional[str] = None,
        concepts: Optional[List[str]] = None,
        type: Optional[str] = None,
        files: Optional[List[str]] = None,
        session_id: Optional[str] = None,
        extra: Optional[Mapping[str, Any]] = None,
    ) -> RememberResult:
        """Persist a memory. Maps to ``POST /agentmemory/remember``.

        ``content`` is the only required field. Other fields mirror the
        daemon's ``mem::remember`` payload; pass ``extra`` for forward-
        compatibility with daemon versions newer than this client.
        """

        payload = _drop_none(
            {
                "content": content,
                "project": project,
                "title": title,
                "concepts": concepts,
                "type": type,
                "files": files,
                "sessionId": session_id,
            }
        )
        if extra:
            payload.update(extra)
        _, body = self._core.request_sync(
            "POST", "/agentmemory/remember", json_body=payload
        )
        return body  # type: ignore[no-any-return]

    def smart_search(
        self,
        *,
        query: Optional[str] = None,
        project: Optional[str] = None,
        limit: Optional[int] = None,
        expand_ids: Optional[List[str]] = None,
        extra: Optional[Mapping[str, Any]] = None,
    ) -> SmartSearchResult:
        """Hybrid BM25 + vector search. Maps to ``POST /agentmemory/smart-search``.

        At least one of ``query`` or ``expand_ids`` must be provided —
        otherwise the daemon returns ``400``.
        """

        payload = _drop_none(
            {
                "query": query,
                "project": project,
                "limit": limit,
                "expandIds": expand_ids,
            }
        )
        if extra:
            payload.update(extra)
        _, body = self._core.request_sync(
            "POST", "/agentmemory/smart-search", json_body=payload
        )
        return body  # type: ignore[no-any-return]

    def memories(
        self,
        *,
        project: Optional[str] = None,
        latest: bool = False,
        limit: Optional[int] = None,
    ) -> MemoriesResponse:
        """List memories. Maps to ``GET /agentmemory/memories``.

        ``latest=True`` filters to records with ``isLatest=true`` (the
        post-consolidation head of each chain).
        """

        params: dict = {}
        if project is not None:
            params["project"] = project
        if latest:
            params["latest"] = "true"
        if limit is not None:
            params["limit"] = str(limit)
        _, body = self._core.request_sync(
            "GET",
            "/agentmemory/memories",
            params=params or None,
        )
        return body  # type: ignore[no-any-return]

    def memory(self, memory_id: str) -> MemoryResponse:
        """Fetch one memory by id. Maps to ``GET /agentmemory/memories/{id}``."""

        _, body = self._core.request_sync(
            "GET", f"/agentmemory/memories/{memory_id}"
        )
        return body  # type: ignore[no-any-return]

    def forget(
        self,
        *,
        memory_id: Optional[str] = None,
        session_id: Optional[str] = None,
        observation_ids: Optional[List[str]] = None,
    ) -> ForgetResult:
        """Forget a memory or session. Maps to ``POST /agentmemory/forget``.

        Either ``memory_id`` or ``session_id`` must be set — the daemon
        returns ``400`` otherwise.
        """

        payload = _drop_none(
            {
                "memoryId": memory_id,
                "sessionId": session_id,
                "observationIds": observation_ids,
            }
        )
        _, body = self._core.request_sync(
            "POST", "/agentmemory/forget", json_body=payload
        )
        return body  # type: ignore[no-any-return]

    def semantic(self) -> SemanticListResponse:
        """List semantic memories. Maps to ``GET /agentmemory/semantic``."""

        _, body = self._core.request_sync("GET", "/agentmemory/semantic")
        return body  # type: ignore[no-any-return]

    def procedural(self) -> ProceduralListResponse:
        """List procedural memories. Maps to ``GET /agentmemory/procedural``."""

        _, body = self._core.request_sync("GET", "/agentmemory/procedural")
        return body  # type: ignore[no-any-return]

    def relations(self) -> RelationsListResponse:
        """List memory relations. Maps to ``GET /agentmemory/relations``."""

        _, body = self._core.request_sync("GET", "/agentmemory/relations")
        return body  # type: ignore[no-any-return]

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Any] = None,
        params: Optional[Mapping[str, Any]] = None,
    ) -> JSONObject:
        """Escape hatch for endpoints not yet wrapped.

        ``path`` may be absolute (``/agentmemory/foo``) or relative
        (``foo``). Useful for new daemon endpoints before the client is
        updated to expose them as typed methods.
        """

        if not path.startswith("/"):
            path = f"/agentmemory/{path}"
        _, body = self._core.request_sync(method, path, json_body=json, params=params)
        return body  # type: ignore[no-any-return]


class AsyncClient:
    """Async sibling of ``Client``. Same surface, ``await`` on every call.

    Use as an async context manager (``async with``) so the underlying
    ``httpx.AsyncClient`` is closed without relying on garbage collection.
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        *,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._core = HttpCore(
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            user_agent=_USER_AGENT,
        )

    @property
    def base_url(self) -> str:
        return self._core.base_url

    async def aclose(self) -> None:
        await self._core.aclose()

    async def __aenter__(self) -> "AsyncClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()

    async def health(self) -> LivezResponse:
        _, body = await self._core.request_async("GET", "/agentmemory/livez")
        return body  # type: ignore[no-any-return]

    async def remember(
        self,
        *,
        content: str,
        project: Optional[str] = None,
        title: Optional[str] = None,
        concepts: Optional[List[str]] = None,
        type: Optional[str] = None,
        files: Optional[List[str]] = None,
        session_id: Optional[str] = None,
        extra: Optional[Mapping[str, Any]] = None,
    ) -> RememberResult:
        payload = _drop_none(
            {
                "content": content,
                "project": project,
                "title": title,
                "concepts": concepts,
                "type": type,
                "files": files,
                "sessionId": session_id,
            }
        )
        if extra:
            payload.update(extra)
        _, body = await self._core.request_async(
            "POST", "/agentmemory/remember", json_body=payload
        )
        return body  # type: ignore[no-any-return]

    async def smart_search(
        self,
        *,
        query: Optional[str] = None,
        project: Optional[str] = None,
        limit: Optional[int] = None,
        expand_ids: Optional[List[str]] = None,
        extra: Optional[Mapping[str, Any]] = None,
    ) -> SmartSearchResult:
        payload = _drop_none(
            {
                "query": query,
                "project": project,
                "limit": limit,
                "expandIds": expand_ids,
            }
        )
        if extra:
            payload.update(extra)
        _, body = await self._core.request_async(
            "POST", "/agentmemory/smart-search", json_body=payload
        )
        return body  # type: ignore[no-any-return]

    async def memories(
        self,
        *,
        project: Optional[str] = None,
        latest: bool = False,
        limit: Optional[int] = None,
    ) -> MemoriesResponse:
        params: dict = {}
        if project is not None:
            params["project"] = project
        if latest:
            params["latest"] = "true"
        if limit is not None:
            params["limit"] = str(limit)
        _, body = await self._core.request_async(
            "GET",
            "/agentmemory/memories",
            params=params or None,
        )
        return body  # type: ignore[no-any-return]

    async def memory(self, memory_id: str) -> MemoryResponse:
        _, body = await self._core.request_async(
            "GET", f"/agentmemory/memories/{memory_id}"
        )
        return body  # type: ignore[no-any-return]

    async def forget(
        self,
        *,
        memory_id: Optional[str] = None,
        session_id: Optional[str] = None,
        observation_ids: Optional[List[str]] = None,
    ) -> ForgetResult:
        payload = _drop_none(
            {
                "memoryId": memory_id,
                "sessionId": session_id,
                "observationIds": observation_ids,
            }
        )
        _, body = await self._core.request_async(
            "POST", "/agentmemory/forget", json_body=payload
        )
        return body  # type: ignore[no-any-return]

    async def semantic(self) -> SemanticListResponse:
        _, body = await self._core.request_async("GET", "/agentmemory/semantic")
        return body  # type: ignore[no-any-return]

    async def procedural(self) -> ProceduralListResponse:
        _, body = await self._core.request_async("GET", "/agentmemory/procedural")
        return body  # type: ignore[no-any-return]

    async def relations(self) -> RelationsListResponse:
        _, body = await self._core.request_async("GET", "/agentmemory/relations")
        return body  # type: ignore[no-any-return]

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Any] = None,
        params: Optional[Mapping[str, Any]] = None,
    ) -> JSONObject:
        if not path.startswith("/"):
            path = f"/agentmemory/{path}"
        _, body = await self._core.request_async(
            method, path, json_body=json, params=params
        )
        return body  # type: ignore[no-any-return]


__all__ = [
    "__version__",
    "Client",
    "AsyncClient",
    "AgentMemoryError",
    "AuthError",
    "NetworkError",
    "ResponseError",
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT",
    "ForgetResult",
    "HealthResponse",
    "JSONObject",
    "LivezResponse",
    "Memory",
    "MemoriesResponse",
    "MemoryRelation",
    "MemoryResponse",
    "ProceduralListResponse",
    "ProceduralMemory",
    "RelationsListResponse",
    "RememberResult",
    "SemanticListResponse",
    "SemanticMemory",
    "SmartSearchHit",
    "SmartSearchResult",
]
