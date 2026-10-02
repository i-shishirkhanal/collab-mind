from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class Tier(str, Enum):
    """Routing tier. FLASH handles ordinary chat/study work, PRO handles
    complex research and reasoning."""

    FLASH = "flash"
    PRO = "pro"


class Task(str, Enum):
    CHAT = "chat"
    STUDY = "study"
    RESEARCH = "research"


@dataclass(frozen=True)
class Usage:
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    reasoning_tokens: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "reasoning_tokens": self.reasoning_tokens,
        }


@dataclass
class Route:
    """What actually happened for one call. Always populated, so a fallback is
    never silent."""

    provider: str
    tier: Tier
    model_requested: str
    model_used: str  # the model id the provider reported (may differ from requested)
    attempts: int = 1
    fallback_used: bool = False
    fallback_reason: Optional[str] = None
    latency_ms: int = 0

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "tier": self.tier.value,
            "model_requested": self.model_requested,
            "model_used": self.model_used,
            "attempts": self.attempts,
            "fallback_used": self.fallback_used,
            "fallback_reason": self.fallback_reason,
            "latency_ms": self.latency_ms,
        }


@dataclass
class Completion:
    text: str
    finish_reason: Optional[str]
    usage: Usage
    route: Route


@dataclass
class StreamEvent:
    """kind: 'delta' (text piece) | 'done' (final: usage + route + finish_reason)."""

    kind: str
    text: str = ""
    finish_reason: Optional[str] = None
    usage: Optional[Usage] = None
    route: Optional[Route] = None
    extra: dict = field(default_factory=dict)
