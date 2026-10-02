"""
llm/router.py — Task → model routing, retry policy and optional fallback.

Routing table (the only place it is defined):
    Task.CHAT      -> Tier.FLASH   (DeepSeek V4.1 Flash, default)
    Task.STUDY     -> Tier.FLASH
    Task.RESEARCH  -> Tier.PRO     (DeepSeek V4 Pro)

Retries: transient failures (429, 500/502/503/504, timeouts, connection
errors) are retried up to LLM_MAX_RETRIES with exponential backoff, honouring
Retry-After. Auth, balance, invalid-request and malformed-response errors are
never retried.

Fallback: only Pro -> Flash, only when LLM_FALLBACK_PRO_TO_FLASH=true, and
only after the Pro retries are exhausted. A fallback is always reported in
`Route` (fallback_used / fallback_reason / model_used) — never silent.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import AsyncIterator, Awaitable, Callable, Optional

from config import LLMSettings
from llm import errors
from llm.deepseek import DeepSeekClient
from llm.types import Completion, StreamEvent, Task, Tier

log = logging.getLogger("collabmind.llm")

TASK_TIER = {Task.CHAT: Tier.FLASH, Task.STUDY: Tier.FLASH, Task.RESEARCH: Tier.PRO}

# Deliberately conservative: only clearly analytical, multi-step requests are
# escalated to Pro automatically. Anything else stays on Flash. Callers can
# always force a task explicitly.
_RESEARCH_PATTERNS = [
    r"\bcompare\b.*\b(and|with|versus|vs\.?)\b",
    r"\b(contrast|critique|critically|evaluate|synthesi[sz]e|reconcile|trade-?offs?)\b",
    r"\b(literature review|research question|hypothes[ie]s|methodolog(y|ies))\b",
    r"\b(analy[sz]e|analysis)\b.*\b(across|between|multiple|all)\b",
    r"\bwhy (does|do|did|is|are)\b.*\b(and how|implications?)\b",
    r"\b(pros and cons|strengths and weaknesses|step[- ]by[- ]step reasoning)\b",
]
_RESEARCH_RE = [re.compile(p, re.IGNORECASE | re.DOTALL) for p in _RESEARCH_PATTERNS]


def classify_task(message: str, explicit: Optional[Task], *, auto_research: bool) -> Task:
    if explicit is not None:
        return explicit
    if auto_research and any(rx.search(message) for rx in _RESEARCH_RE):
        return Task.RESEARCH
    return Task.CHAT


UsageSink = Callable[[dict], Awaitable[None]]


class ModelRouter:
    def __init__(self, client: DeepSeekClient, settings: LLMSettings,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep):
        self._client = client
        self._s = settings
        self._sleep = sleep

    def tier_for(self, task: Task) -> Tier:
        return TASK_TIER[task]

    def _delay(self, attempt: int, err: errors.ProviderError) -> float:
        backoff = self._s.retry_base_delay * (2 ** attempt)
        if err.retry_after is not None:
            backoff = max(backoff, err.retry_after)
        return min(backoff, 30.0)

    def _can_fall_back(self, tier: Tier, err: errors.ProviderError) -> bool:
        return (
            tier is Tier.PRO
            and self._s.fallback_pro_to_flash
            and (err.retryable or isinstance(err, errors.ModelUnavailableError))
        )

    async def _attempt_loop(self, tier: Tier, call: Callable[[Tier], Awaitable]):
        """Run `call(tier)` with retries. Returns (result, attempts)."""
        attempts = 0
        while True:
            attempts += 1
            try:
                return await call(tier), attempts
            except errors.ProviderError as err:
                if err.retryable and attempts <= self._s.max_retries:
                    delay = self._delay(attempts - 1, err)
                    log.warning("LLM %s attempt %d failed (%s); retrying in %.1fs",
                                err.model, attempts, err.code, delay)
                    await self._sleep(delay)
                    continue
                err.attempts = attempts  # type: ignore[attr-defined]
                raise

    async def complete(self, task: Task, messages: list[dict], *, json_mode: bool = False,
                       temperature: float = 0.2, max_tokens: Optional[int] = None) -> Completion:
        tier = self.tier_for(task)

        async def call(t: Tier) -> Completion:
            return await self._client.complete(t, messages, json_mode=json_mode,
                                               temperature=temperature, max_tokens=max_tokens)

        try:
            result, attempts = await self._attempt_loop(tier, call)
            result.route.attempts = attempts
            return result
        except errors.ProviderError as err:
            if not self._can_fall_back(tier, err):
                raise
            reason = f"{err.code} on {err.model}"
            log.warning("Falling back %s -> flash: %s", tier.value, reason)
            result, attempts = await self._attempt_loop(Tier.FLASH, call)
            result.route.attempts = attempts + getattr(err, "attempts", 1)
            result.route.fallback_used = True
            result.route.fallback_reason = reason
            result.route.tier = Tier.FLASH
            return result

    async def stream(self, task: Task, messages: list[dict], *, temperature: float = 0.2,
                     max_tokens: Optional[int] = None) -> AsyncIterator[StreamEvent]:
        """Streams deltas then a final 'done' event. Retries/fallback only
        happen before the first delta is emitted."""
        tier = self.tier_for(task)
        fallback_reason: Optional[str] = None
        prior_attempts = 0
        while True:
            attempts = 0
            emitted = False
            try:
                while True:
                    attempts += 1
                    try:
                        async for ev in self._client.stream(tier, messages, temperature=temperature,
                                                            max_tokens=max_tokens):
                            if ev.kind == "delta":
                                emitted = True
                            elif ev.kind == "done" and ev.route:
                                ev.route.attempts = attempts + prior_attempts
                                if fallback_reason:
                                    ev.route.fallback_used = True
                                    ev.route.fallback_reason = fallback_reason
                                    ev.route.tier = tier
                            yield ev
                        return
                    except errors.ProviderError as err:
                        if emitted:
                            raise  # partial output already delivered; never retry/switch
                        if err.retryable and attempts <= self._s.max_retries:
                            await self._sleep(self._delay(attempts - 1, err))
                            continue
                        raise
            except errors.ProviderError as err:
                if emitted or not self._can_fall_back(tier, err):
                    raise
                fallback_reason = f"{err.code} on {err.model}"
                log.warning("Falling back %s -> flash: %s", tier.value, fallback_reason)
                prior_attempts = attempts
                tier = Tier.FLASH
