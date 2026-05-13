"""Exception hierarchy for the agentmemory client.

All errors raised by ``Client``/``AsyncClient`` derive from ``AgentMemoryError``
so callers can catch a single base type if they don't care about the cause.
"""

from __future__ import annotations

from typing import Any, Optional


class AgentMemoryError(Exception):
    """Base class for every error raised by the agentmemory client."""


class AuthError(AgentMemoryError):
    """Bearer-token configuration prevents the request from being sent.

    Raised when ``AGENTMEMORY_REQUIRE_HTTPS=1`` is set and the configured
    ``base_url`` would leak a bearer token over plaintext HTTP to a
    non-loopback host. Also raised for ``401``/``403`` responses from the
    daemon.
    """


class NetworkError(AgentMemoryError):
    """The HTTP request failed before a response was received.

    Covers connection refused, DNS failure, TLS handshake errors, and
    timeouts. Inspect ``__cause__`` for the underlying ``httpx`` exception.
    """


class ResponseError(AgentMemoryError):
    """The daemon responded with a non-2xx status code.

    ``status_code`` is the HTTP status. ``body`` is the parsed JSON body
    (a ``dict``) if the response was valid JSON, otherwise the raw text.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        body: Optional[Any] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body
