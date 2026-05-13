"""Typed response envelopes for the agentmemory daemon.

These are ``TypedDict`` mirrors of the JSON shapes returned by the REST
endpoints at ``:3111``. Fields not always present are flagged ``NotRequired``
so callers can be permissive in older daemon versions and strict in new ones
without a runtime dependency on ``pydantic`` or ``msgspec``.

The daemon is the source of truth: if a field is missing from a real
response, the typed dict will simply not contain it. Use ``dict.get`` on
optional fields.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal

try:
    from typing import NotRequired, TypedDict
except ImportError:
    from typing_extensions import NotRequired, TypedDict


MemoryType = Literal["pattern", "preference", "architecture", "bug", "workflow", "fact"]


class Memory(TypedDict, total=False):
    """A consolidated memory record."""

    id: str
    createdAt: str
    updatedAt: str
    type: MemoryType
    title: str
    content: str
    concepts: List[str]
    files: List[str]
    sessionIds: List[str]
    strength: float
    version: int
    parentId: NotRequired[str]
    supersedes: NotRequired[List[str]]
    relatedIds: NotRequired[List[str]]
    sourceObservationIds: NotRequired[List[str]]
    isLatest: bool
    forgetAfter: NotRequired[str]
    imageRef: NotRequired[str]


class SemanticMemory(TypedDict, total=False):
    id: str
    createdAt: str
    project: str
    concept: str
    facts: List[str]


class ProceduralMemory(TypedDict, total=False):
    id: str
    createdAt: str
    project: str
    title: str
    steps: List[str]


class MemoryRelation(TypedDict, total=False):
    id: str
    fromId: str
    toId: str
    type: str
    createdAt: str


class MemoriesResponse(TypedDict):
    memories: List[Memory]


class MemoryResponse(TypedDict):
    memory: Memory


class SemanticListResponse(TypedDict):
    semantic: List[SemanticMemory]


class ProceduralListResponse(TypedDict):
    procedural: List[ProceduralMemory]


class RelationsListResponse(TypedDict):
    relations: List[MemoryRelation]


class SmartSearchHit(TypedDict, total=False):
    id: str
    score: float
    memory: Memory


class SmartSearchResult(TypedDict, total=False):
    hits: List[SmartSearchHit]
    query: str
    expanded: NotRequired[List[str]]


class RememberResult(TypedDict, total=False):
    id: str
    memory: Memory
    created: bool


class ForgetResult(TypedDict, total=False):
    forgotten: int
    ids: List[str]


class HealthResponse(TypedDict, total=False):
    status: Literal["healthy", "degraded", "critical"]
    uptimeSeconds: float
    alerts: List[str]


class LivezResponse(TypedDict, total=False):
    ok: bool


# Catch-all for endpoints whose response shape we don't model strictly.
JSONObject = Dict[str, Any]
