"""
llm/deepseek.py — DeepSeek chat-completions client (OpenAI-compatible wire
format, https://api-docs.deepseek.com).

Provider-specific behaviour is explicit here rather than assumed to be common:
  * `thinking` is a DeepSeek extension: {"type": "enabled" | "disabled"}.
    In thinking mode temperature/penalties are ignored and the reply carries a
    separate `reasoning_content` field, which we never forward to users.
  * JSON mode is `response_format={"type": "json_object"}`; the prompt must
    itself mention JSON.
  * Token usage is read from `usage` (and from the final stream chunk when
    `stream_options.include_usage` is set).
  * HTTP 402 = out of balance, 429 = rate limit, 500/503 = server trouble.
"""

from __future__ import annotations

import json
import time
from typing import AsyncIterator, Optional

import httpx

from config import LLMSettings
from llm import errors
from llm.redaction import register_secret
from llm.types import Completion, Route, StreamEvent, Tier, Usage

PROVIDER = "deepseek"


def _parse_retry_after(response: httpx.Response) -> Optional[float]:
    raw = response.headers.get("retry-after")
    if not raw:
        return None
    try:
        return max(0.0, min(float(raw), 60.0))
    except ValueError:
        return None


def _error_message(response: httpx.Response) -> str:
    try:
        body = response.json()
        msg = body.get("error", {}).get("message") if isinstance(body, dict) else None
        if msg:
            return str(msg)[:300]
    except Exception:
        pass
    return f"HTTP {response.status_code}"


def map_http_error(response: httpx.Response, model: str) -> errors.ProviderError:
    status = response.status_code
    msg = _error_message(response)
    kw = {"provider": PROVIDER, "model": model, "status": status}
    if status == 401:
        err: errors.ProviderError = errors.AuthenticationError("DeepSeek rejected the API key.", **kw)
    elif status == 402:
        err = errors.InsufficientBalanceError("DeepSeek account has insufficient balance.", **kw)
    elif status == 404:
        err = errors.ModelUnavailableError(f"Model '{model}' was not found at the provider.", **kw)
    elif status in (400, 422):
        # A bad model name is reported as 400/422 by some gateways.
        if "model" in msg.lower() and ("not exist" in msg.lower() or "not found" in msg.lower() or "invalid" in msg.lower()):
            err = errors.ModelUnavailableError(f"Model '{model}' is not available: {msg}", **kw)
        else:
            err = errors.InvalidRequestError(f"Provider rejected the request: {msg}", **kw)
    elif status == 429:
        err = errors.RateLimitedError("Provider rate limit reached.", **kw)
        err.retry_after = _parse_retry_after(response)
    elif status in (500, 502, 503, 504):
        err = errors.ProviderOverloadedError(f"Provider unavailable ({status}).", **kw)
        err.retry_after = _parse_retry_after(response)
    else:
        err = errors.ProviderError(f"Unexpected provider response ({status}): {msg}", **kw)
    return err


def _usage_from(obj: Optional[dict]) -> Usage:
    if not isinstance(obj, dict):
        return Usage()
    details = obj.get("completion_tokens_details") or {}
    return Usage(
        prompt_tokens=obj.get("prompt_tokens"),
        completion_tokens=obj.get("completion_tokens"),
        total_tokens=obj.get("total_tokens"),
        reasoning_tokens=details.get("reasoning_tokens") if isinstance(details, dict) else None,
    )


class DeepSeekClient:
    def __init__(self, settings: LLMSettings, transport: Optional[httpx.AsyncBaseTransport] = None):
        self._s = settings
        self._transport = transport
        register_secret(settings.api_key)

    def model_for(self, tier: Tier) -> str:
        return self._s.model_pro if tier is Tier.PRO else self._s.model_flash

    def _thinking_for(self, tier: Tier) -> str:
        return self._s.pro_thinking if tier is Tier.PRO else self._s.flash_thinking

    def _require_key(self, model: str) -> None:
        if not self._s.api_key:
            raise errors.NotConfiguredError(
                "DEEPSEEK_API_KEY is not configured.", provider=PROVIDER, model=model
            )

    def _payload(self, model: str, tier: Tier, messages: list[dict], *, json_mode: bool,
                 temperature: float, max_tokens: Optional[int], stream: bool) -> dict:
        body: dict = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens or self._s.max_output_tokens,
            "stream": stream,
        }
        thinking = self._thinking_for(tier)
        if thinking in ("enabled", "disabled"):
            body["thinking"] = {"type": thinking}
        if thinking != "enabled":
            body["temperature"] = temperature  # ignored by the provider in thinking mode
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if stream:
            body["stream_options"] = {"include_usage": True}
        return body

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._s.base_url,
            timeout=httpx.Timeout(self._s.timeout_seconds, connect=10.0),
            headers={"Authorization": f"Bearer {self._s.api_key}", "Content-Type": "application/json"},
            transport=self._transport,
        )

    async def complete(self, tier: Tier, messages: list[dict], *, json_mode: bool = False,
                       temperature: float = 0.2, max_tokens: Optional[int] = None) -> Completion:
        """One attempt, no retries (the router owns retry/fallback policy)."""
        model = self.model_for(tier)
        self._require_key(model)
        body = self._payload(model, tier, messages, json_mode=json_mode,
                             temperature=temperature, max_tokens=max_tokens, stream=False)
        started = time.monotonic()
        try:
            async with self._client() as client:
                response = await client.post("/chat/completions", json=body)
        except httpx.TimeoutException:
            raise errors.ProviderTimeoutError("Provider request timed out.", provider=PROVIDER, model=model) from None
        except httpx.TransportError as exc:
            raise errors.ProviderOverloadedError(
                f"Could not reach the provider ({type(exc).__name__}).", provider=PROVIDER, model=model
            ) from None

        if response.status_code != 200:
            raise map_http_error(response, model)

        try:
            data = response.json()
            choice = data["choices"][0]
            text = choice["message"].get("content")
            finish = choice.get("finish_reason")
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise errors.MalformedResponseError("Provider returned an unreadable response.",
                                                provider=PROVIDER, model=model) from None
        if not isinstance(text, str) or not text.strip():
            raise errors.MalformedResponseError(
                f"Provider returned no answer text (finish_reason={finish}).", provider=PROVIDER, model=model
            )
        if finish == "insufficient_system_resource":
            raise errors.ProviderOverloadedError("Provider interrupted generation (insufficient resource).",
                                                 provider=PROVIDER, model=model)
        route = Route(
            provider=PROVIDER, tier=tier, model_requested=model,
            model_used=str(data.get("model") or model),
            latency_ms=int((time.monotonic() - started) * 1000),
        )
        return Completion(text=text, finish_reason=finish, usage=_usage_from(data.get("usage")), route=route)

    async def stream(self, tier: Tier, messages: list[dict], *, temperature: float = 0.2,
                     max_tokens: Optional[int] = None) -> AsyncIterator[StreamEvent]:
        """One attempt. Errors before the first byte raise ProviderError so the
        router can retry; once text has been emitted a failure is raised as-is
        and must not be retried (the client already saw partial output)."""
        model = self.model_for(tier)
        self._require_key(model)
        body = self._payload(model, tier, messages, json_mode=False,
                             temperature=temperature, max_tokens=max_tokens, stream=True)
        started = time.monotonic()
        model_used = model
        usage = Usage()
        finish: Optional[str] = None
        emitted = False
        try:
            async with self._client() as client:
                async with client.stream("POST", "/chat/completions", json=body) as response:
                    if response.status_code != 200:
                        await response.aread()
                        raise map_http_error(response, model)
                    async for line in response.aiter_lines():
                        if not line or line.startswith(":"):  # keep-alive comments
                            continue
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                        except ValueError:
                            raise errors.MalformedResponseError(
                                "Provider sent an unreadable stream chunk.", provider=PROVIDER, model=model
                            ) from None
                        model_used = str(chunk.get("model") or model_used)
                        if chunk.get("usage"):
                            usage = _usage_from(chunk["usage"])
                        for choice in chunk.get("choices") or []:
                            delta = (choice.get("delta") or {}).get("content")
                            if delta:
                                emitted = True
                                yield StreamEvent(kind="delta", text=delta)
                            if choice.get("finish_reason"):
                                finish = choice["finish_reason"]
        except httpx.TimeoutException:
            raise errors.ProviderTimeoutError("Provider stream timed out.", provider=PROVIDER, model=model) from None
        except httpx.TransportError as exc:
            raise errors.ProviderOverloadedError(
                f"Provider stream failed ({type(exc).__name__}).", provider=PROVIDER, model=model
            ) from None

        if not emitted:
            raise errors.MalformedResponseError(
                f"Provider stream contained no answer text (finish_reason={finish}).",
                provider=PROVIDER, model=model,
            )
        route = Route(provider=PROVIDER, tier=tier, model_requested=model, model_used=model_used,
                      latency_ms=int((time.monotonic() - started) * 1000))
        yield StreamEvent(kind="done", finish_reason=finish, usage=usage, route=route)
