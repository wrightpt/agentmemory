"""Plaintext-bearer guard parity with v0.9.12.

The guard fires when a bearer token would be sent over plaintext HTTP to a
non-loopback host. Default behavior is one stderr warning per process.
Setting ``AGENTMEMORY_REQUIRE_HTTPS=1`` upgrades the warning to a raised
``AuthError`` before any request leaves the host.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from agentmemory import AsyncClient, AuthError, Client
from agentmemory._http import (
    _check_plaintext_bearer_guard,
    _reset_plaintext_bearer_guard_for_tests,
    _uses_plaintext_bearer,
)


def test_no_warn_when_no_api_key(capsys):
    Client(base_url="http://example.com:3111")
    out = capsys.readouterr()
    assert out.err == ""


def test_no_warn_for_loopback_127_0_0_1(capsys):
    Client(base_url="http://127.0.0.1:3111", api_key="secret")
    out = capsys.readouterr()
    assert out.err == ""


def test_no_warn_for_loopback_localhost(capsys):
    Client(base_url="http://localhost:3111", api_key="secret")
    out = capsys.readouterr()
    assert out.err == ""


def test_no_warn_for_loopback_ipv6(capsys):
    Client(base_url="http://[::1]:3111", api_key="secret")
    out = capsys.readouterr()
    assert out.err == ""


def test_no_warn_for_https_non_loopback(capsys):
    Client(base_url="https://memory.example.com", api_key="secret")
    out = capsys.readouterr()
    assert out.err == ""


def test_warns_for_plaintext_http_non_loopback(capsys):
    Client(base_url="http://memory.example.com", api_key="secret")
    out = capsys.readouterr()
    assert "plaintext HTTP" in out.err
    assert "memory.example.com" in out.err


def test_warns_only_once_per_process(capsys):
    Client(base_url="http://memory.example.com", api_key="secret")
    capsys.readouterr()  # drain
    Client(base_url="http://other.example.com", api_key="secret")
    out = capsys.readouterr()
    assert out.err == ""


def test_require_https_raises_auth_error(monkeypatch):
    monkeypatch.setenv("AGENTMEMORY_REQUIRE_HTTPS", "1")
    with pytest.raises(AuthError):
        Client(base_url="http://memory.example.com", api_key="secret")


def test_require_https_off_does_not_raise_for_loopback(monkeypatch):
    monkeypatch.setenv("AGENTMEMORY_REQUIRE_HTTPS", "1")
    Client(base_url="http://localhost:3111", api_key="secret")


def test_require_https_allows_https_targets(monkeypatch):
    monkeypatch.setenv("AGENTMEMORY_REQUIRE_HTTPS", "1")
    Client(base_url="https://memory.example.com", api_key="secret")


def test_async_client_applies_same_guard(monkeypatch):
    monkeypatch.setenv("AGENTMEMORY_REQUIRE_HTTPS", "1")
    with pytest.raises(AuthError):
        AsyncClient(base_url="http://memory.example.com", api_key="secret")


def test_internal_helpers_classify_correctly():
    assert _uses_plaintext_bearer("http://example.com", "x") is True
    assert _uses_plaintext_bearer("https://example.com", "x") is False
    assert _uses_plaintext_bearer("http://localhost", "x") is False
    assert _uses_plaintext_bearer("http://127.0.0.1", "x") is False
    assert _uses_plaintext_bearer("http://[::1]", "x") is False
    assert _uses_plaintext_bearer("http://example.com", None) is False


def test_check_helper_raises_under_require_https(monkeypatch):
    monkeypatch.setenv("AGENTMEMORY_REQUIRE_HTTPS", "1")
    with pytest.raises(AuthError):
        _check_plaintext_bearer_guard("http://example.com", "secret")


@respx.mock
def test_bearer_header_still_sent_after_warning(capsys):
    # Plaintext non-loopback + bearer = warn-and-send (not refuse).
    route = respx.route(
        method="GET", url="http://memory.example.com/agentmemory/livez"
    ).mock(return_value=httpx.Response(200, json={"ok": True}))
    c = Client(base_url="http://memory.example.com", api_key="secret")
    c.health()
    _reset_plaintext_bearer_guard_for_tests()
    capsys.readouterr()
    assert route.calls[0].request.headers["authorization"] == "Bearer secret"
