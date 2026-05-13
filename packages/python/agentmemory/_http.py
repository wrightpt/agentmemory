"""Transport layer shared by ``Client`` and ``AsyncClient``.

Responsibilities, in order:

1. Resolve the base URL (parameter, then ``AGENTMEMORY_URL`` env, then
   ``http://localhost:3111``).
2. Enforce the plaintext-bearer guard ported from v0.9.12: warn once on
   stderr when a bearer token would cross plaintext HTTP to a non-loopback
   host; raise ``AuthError`` instead if ``AGENTMEMORY_REQUIRE_HTTPS=1``.
3. Build the ``httpx`` request with bearer auth + JSON body + timeout.
4. Translate HTTP errors into the ``AgentMemoryError`` hierarchy.

The sync and async paths are kept in lockstep via two near-identical
``_request_sync`` / ``_request_async`` helpers — duplicating ten lines is
cheaper than the abstraction needed to share them across event loops.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any, Mapping, Optional, Tuple
from urllib.parse import urlparse

import httpx

from ._exceptions import AgentMemoryError, AuthError, NetworkError, ResponseError


DEFAULT_BASE_URL = "http://localhost:3111"
DEFAULT_TIMEOUT = 5.0
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

_plaintext_bearer_warned = False
_plaintext_bearer_lock = threading.Lock()


def _resolve_base_url(base_url: Optional[str]) -> str:
    if base_url:
        return base_url.rstrip("/")
    env = os.environ.get("AGENTMEMORY_URL")
    if env:
        return env.rstrip("/")
    return DEFAULT_BASE_URL


def _resolve_api_key(api_key: Optional[str]) -> Optional[str]:
    if api_key is not None:
        return api_key or None
    env = os.environ.get("AGENTMEMORY_SECRET", "")
    return env or None


def _uses_plaintext_bearer(base_url: str, api_key: Optional[str]) -> bool:
    if not api_key:
        return False
    parsed = urlparse(base_url)
    if parsed.scheme != "http":
        return False
    host = (parsed.hostname or "").lower()
    return host not in LOOPBACK_HOSTS


def _plaintext_bearer_message(base_url: str) -> str:
    return (
        f"agentmemory: bearer token configured for plaintext HTTP to "
        f"{base_url}. Tokens and memory payloads can be observed on the "
        f"network; use HTTPS or an SSH tunnel."
    )


def _check_plaintext_bearer_guard(base_url: str, api_key: Optional[str]) -> None:
    """Warn-once or raise when bearer auth would cross plaintext HTTP.

    Raises ``AuthError`` if ``AGENTMEMORY_REQUIRE_HTTPS=1``. Otherwise emits
    a single stderr warning per process and returns. Subsequent calls with
    the same risky configuration are silent so chatty clients don't spam
    the user's terminal.
    """

    global _plaintext_bearer_warned
    if not _uses_plaintext_bearer(base_url, api_key):
        return
    message = _plaintext_bearer_message(base_url)
    if os.environ.get("AGENTMEMORY_REQUIRE_HTTPS") == "1":
        raise AuthError(message)
    with _plaintext_bearer_lock:
        if _plaintext_bearer_warned:
            return
        _plaintext_bearer_warned = True
    print(message, file=sys.stderr)


def _reset_plaintext_bearer_guard_for_tests() -> None:
    """Test-only helper. Resets the once-per-process warn flag."""

    global _plaintext_bearer_warned
    with _plaintext_bearer_lock:
        _plaintext_bearer_warned = False


def _build_headers(api_key: Optional[str], extra: Optional[Mapping[str, str]]) -> dict:
    headers: dict = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if extra:
        headers.update(extra)
    return headers


def _decode_response(resp: httpx.Response) -> Any:
    """Return the parsed JSON body, or raise ``ResponseError`` on non-2xx.

    Bodies that fail to parse as JSON are returned as a raw string when the
    status is 2xx, and attached to ``ResponseError.body`` as a raw string
    otherwise — so callers can debug 500s from a misconfigured daemon.
    """

    parsed: Any
    try:
        parsed = resp.json()
    except ValueError:
        parsed = resp.text

    if 200 <= resp.status_code < 300:
        return parsed

    if resp.status_code in (401, 403):
        raise AuthError(
            f"agentmemory rejected the request: HTTP {resp.status_code}",
        )
    message = f"agentmemory returned HTTP {resp.status_code}"
    if isinstance(parsed, dict) and "error" in parsed:
        message = f"{message}: {parsed['error']}"
    raise ResponseError(message, status_code=resp.status_code, body=parsed)


class HttpCore:
    """Shared configuration for sync + async paths.

    Stores the resolved base URL, api key, timeout, and a pair of
    ``httpx`` clients (one sync, one async) that share the same transport
    settings. The async client is created lazily — most users only need
    one or the other.
    """

    def __init__(
        self,
        base_url: Optional[str],
        api_key: Optional[str],
        timeout: float,
        user_agent: str,
    ) -> None:
        self.base_url = _resolve_base_url(base_url)
        self.api_key = _resolve_api_key(api_key)
        self.timeout = timeout
        self.user_agent = user_agent
        _check_plaintext_bearer_guard(self.base_url, self.api_key)
        self._sync_client: Optional[httpx.Client] = None
        self._async_client: Optional[httpx.AsyncClient] = None

    def _common_headers(self, extra: Optional[Mapping[str, str]]) -> dict:
        headers = _build_headers(self.api_key, extra)
        headers.setdefault("User-Agent", self.user_agent)
        return headers

    def url(self, path: str) -> str:
        if not path.startswith("/"):
            path = "/" + path
        return f"{self.base_url}{path}"

    def sync_client(self) -> httpx.Client:
        if self._sync_client is None:
            self._sync_client = httpx.Client(timeout=self.timeout)
        return self._sync_client

    def async_client(self) -> httpx.AsyncClient:
        if self._async_client is None:
            self._async_client = httpx.AsyncClient(timeout=self.timeout)
        return self._async_client

    def close(self) -> None:
        if self._sync_client is not None:
            self._sync_client.close()
            self._sync_client = None

    async def aclose(self) -> None:
        if self._async_client is not None:
            await self._async_client.aclose()
            self._async_client = None

    def request_sync(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[Any] = None,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Tuple[int, Any]:
        merged = self._common_headers(headers)
        if json_body is not None:
            merged.setdefault("Content-Type", "application/json")
        try:
            resp = self.sync_client().request(
                method,
                self.url(path),
                json=json_body,
                params=params,
                headers=merged,
            )
        except httpx.HTTPError as exc:
            raise NetworkError(f"agentmemory request failed: {exc}") from exc
        return resp.status_code, _decode_response(resp)

    async def request_async(
        self,
        method: str,
        path: str,
        *,
        json_body: Optional[Any] = None,
        params: Optional[Mapping[str, Any]] = None,
        headers: Optional[Mapping[str, str]] = None,
    ) -> Tuple[int, Any]:
        merged = self._common_headers(headers)
        if json_body is not None:
            merged.setdefault("Content-Type", "application/json")
        try:
            resp = await self.async_client().request(
                method,
                self.url(path),
                json=json_body,
                params=params,
                headers=merged,
            )
        except httpx.HTTPError as exc:
            raise NetworkError(f"agentmemory request failed: {exc}") from exc
        return resp.status_code, _decode_response(resp)


__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_TIMEOUT",
    "HttpCore",
    "AgentMemoryError",
    "AuthError",
    "NetworkError",
    "ResponseError",
    "_reset_plaintext_bearer_guard_for_tests",
]
