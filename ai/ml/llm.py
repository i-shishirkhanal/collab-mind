"""
ml/llm.py — a tiny, budget-capped OpenRouter client for the ML pipeline (question drafting, answer
generation, the "LLM judges its own answer" baseline).

Deliberately minimal and cheap:
  * one cheap model (DeepSeek flash), short outputs;
  * every response is cached on disk, so re-running a script costs nothing;
  * a hard cap on live (uncached) calls per process, so a bug cannot run up a bill.
The key is read from OPENROUTER_API_KEY or ml/.env.ml (git-ignored). It is never logged or committed.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import httpx

MODEL = os.environ.get("ML_LLM_MODEL", "deepseek/deepseek-v4-flash")
URL = "https://openrouter.ai/api/v1/chat/completions"
CACHE = Path(__file__).parent / "data" / "cache" / "llm"
MAX_LIVE_CALLS = int(os.environ.get("ML_LLM_MAX_CALLS", "300"))

_live_calls = 0


class BudgetExceeded(RuntimeError):
    pass


def _key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "")
    env = Path(__file__).parent / ".env.ml"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("OPENROUTER_API_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is not set (env var or ml/.env.ml)")
    return key


def chat(prompt: str, *, system: str = "", max_tokens: int = 400, temperature: float = 0.2) -> str:
    """One completion. Cached by (model, system, prompt, max_tokens, temperature)."""
    global _live_calls
    body = {"model": MODEL, "max_tokens": max_tokens, "temperature": temperature,
            "messages": ([{"role": "system", "content": system}] if system else [])
                        + [{"role": "user", "content": prompt}]}
    cache_file = CACHE / (hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest() + ".txt")
    if cache_file.exists():
        return cache_file.read_text(encoding="utf-8")
    if _live_calls >= MAX_LIVE_CALLS:
        raise BudgetExceeded(f"live call cap of {MAX_LIVE_CALLS} reached (ML_LLM_MAX_CALLS)")
    _live_calls += 1
    r = httpx.post(URL, json=body, headers={"Authorization": f"Bearer {_key()}"}, timeout=90)
    r.raise_for_status()
    text = r.json()["choices"][0]["message"]["content"] or ""
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(text, encoding="utf-8")
    return text
