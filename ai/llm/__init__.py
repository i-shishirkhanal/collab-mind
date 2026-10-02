"""Model-provider layer: DeepSeek chat models behind a task router."""

from __future__ import annotations

from typing import Optional

from config import get_settings
from llm.deepseek import DeepSeekClient
from llm.router import ModelRouter, classify_task

_router: Optional[ModelRouter] = None


def get_router() -> ModelRouter:
    global _router
    if _router is None:
        s = get_settings().llm
        _router = ModelRouter(DeepSeekClient(s), s)
    return _router


def set_router(router: Optional[ModelRouter]) -> None:
    """Tests inject a router built on a mock transport."""
    global _router
    _router = router


__all__ = ["get_router", "set_router", "ModelRouter", "classify_task"]
