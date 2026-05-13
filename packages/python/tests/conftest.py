"""Shared pytest fixtures.

Each test resets the once-per-process plaintext-bearer warn flag so the
``test_bearer_guard`` cases stay independent of test order. We also pop
the three env vars the client reads so a developer's local shell
configuration can't leak into the suite.
"""

from __future__ import annotations

import os
import sys

import pytest

# Make the in-tree package importable without `pip install -e .` so tests
# run unmodified in CI from a fresh checkout.
HERE = os.path.dirname(os.path.abspath(__file__))
PKG_ROOT = os.path.dirname(HERE)
if PKG_ROOT not in sys.path:
    sys.path.insert(0, PKG_ROOT)


from agentmemory._http import _reset_plaintext_bearer_guard_for_tests


@pytest.fixture(autouse=True)
def _isolate_environment(monkeypatch):
    monkeypatch.delenv("AGENTMEMORY_URL", raising=False)
    monkeypatch.delenv("AGENTMEMORY_SECRET", raising=False)
    monkeypatch.delenv("AGENTMEMORY_REQUIRE_HTTPS", raising=False)
    _reset_plaintext_bearer_guard_for_tests()
    yield
    _reset_plaintext_bearer_guard_for_tests()
