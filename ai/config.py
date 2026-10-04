"""
config.py — Centralised, validated configuration for the AI service.

Every model name, endpoint, timeout and retrieval knob comes from environment
variables and is validated once, at startup, so a bad deployment fails loudly
instead of at the first user request. Secrets are held in fields that are
excluded from repr() so they cannot leak through logging.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache


class ConfigError(RuntimeError):
    """Raised when the environment is missing or has invalid configuration."""


def _str(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _float(name: str, default: float, *, min_value: float, max_value: float) -> float:
    raw = _str(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from None
    if not (min_value <= value <= max_value):
        raise ConfigError(f"{name} must be between {min_value} and {max_value}, got {value}")
    return value


def _int(name: str, default: int, *, min_value: int, max_value: int) -> int:
    raw = _str(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from None
    if not (min_value <= value <= max_value):
        raise ConfigError(f"{name} must be between {min_value} and {max_value}, got {value}")
    return value


def _bool(name: str, default: bool) -> bool:
    raw = _str(name).lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be true/false, got {raw!r}")


def _choice(name: str, default: str, choices: set[str]) -> str:
    value = _str(name, default).lower()
    if value not in choices:
        raise ConfigError(f"{name} must be one of {sorted(choices)}, got {value!r}")
    return value


def _url(name: str, default: str) -> str:
    value = _str(name, default).rstrip("/")
    if value and not value.startswith(("http://", "https://")):
        raise ConfigError(f"{name} must start with http:// or https://, got {value!r}")
    return value


@dataclass(frozen=True)
class LLMSettings:
    base_url: str
    api_key: str = field(repr=False)
    model_flash: str
    model_pro: str
    timeout_seconds: float
    max_retries: int
    retry_base_delay: float
    fallback_pro_to_flash: bool
    auto_route_research: bool
    flash_thinking: str
    pro_thinking: str
    max_output_tokens: int


@dataclass(frozen=True)
class EmbeddingSettings:
    base_url: str
    api_key: str = field(repr=False)
    model: str
    dimensions: int
    batch_size: int
    timeout_seconds: float
    max_retries: int


@dataclass(frozen=True)
class RetrievalSettings:
    top_k: int
    candidates: int
    min_similarity: float
    fts_rescue_min_similarity: float
    hybrid: bool
    rrf_k: int
    context_max_chars: int
    # Optional cross-encoder rerank of the retrieved candidates (rag/reranker.py). Off by default.
    reranker_enabled: bool = False
    reranker_model: str = ""          # local path or Hugging Face id of the fine-tuned cross-encoder
    reranker_candidates: int = 30     # how many retrieved chunks are scored before cutting to top_k


@dataclass(frozen=True)
class VerifierSettings:
    """Optional claim-level faithfulness check of answers (rag/verifier.py). Off by default."""
    enabled: bool = False
    model: str = ""             # local path or Hugging Face id of the fine-tuned verifier
    threshold: float = 0.5      # P(supported) below this flags a claim; tune on the dev set
    max_claims: int = 12        # claims scored per answer (bounds CPU latency)


@dataclass(frozen=True)
class Settings:
    llm: LLMSettings
    embedding: EmbeddingSettings
    retrieval: RetrievalSettings
    verifier: VerifierSettings = VerifierSettings()

    def validate_for_serving(self) -> list[str]:
        """Return non-fatal problems (missing credentials). The service still
        boots so /health works, but the affected endpoints return 503."""
        problems = []
        if not self.llm.api_key:
            problems.append("DEEPSEEK_API_KEY is not set: chat and study generation will return 503.")
        if not self.embedding.base_url:
            problems.append("EMBEDDING_BASE_URL is not set: document indexing and retrieval will return 503.")
        return problems


def load_settings() -> Settings:
    llm = LLMSettings(
        base_url=_url("LLM_BASE_URL", "https://api.deepseek.com"),
        api_key=_str("DEEPSEEK_API_KEY"),
        model_flash=_str("LLM_MODEL_FLASH", "deepseek-flash"),
        model_pro=_str("LLM_MODEL_PRO", "deepseek-v4-pro"),
        timeout_seconds=_float("LLM_TIMEOUT_SECONDS", 60.0, min_value=1, max_value=600),
        max_retries=_int("LLM_MAX_RETRIES", 2, min_value=0, max_value=6),
        retry_base_delay=_float("LLM_RETRY_BASE_DELAY_SECONDS", 1.0, min_value=0, max_value=30),
        fallback_pro_to_flash=_bool("LLM_FALLBACK_PRO_TO_FLASH", False),
        auto_route_research=_bool("LLM_AUTO_ROUTE_RESEARCH", True),
        flash_thinking=_choice("LLM_FLASH_THINKING", "disabled", {"enabled", "disabled", "default"}),
        pro_thinking=_choice("LLM_PRO_THINKING", "enabled", {"enabled", "disabled", "default"}),
        max_output_tokens=_int("LLM_MAX_OUTPUT_TOKENS", 4096, min_value=64, max_value=384_000),
    )
    if not llm.model_flash or not llm.model_pro:
        raise ConfigError("LLM_MODEL_FLASH and LLM_MODEL_PRO must not be empty")

    embedding = EmbeddingSettings(
        base_url=_url("EMBEDDING_BASE_URL", ""),
        api_key=_str("EMBEDDING_API_KEY"),
        model=_str("EMBEDDING_MODEL", "BAAI/bge-m3"),
        # BGE-M3 dense vectors are 1024-d. This is validated against every
        # response and against the pgvector column, never assumed.
        dimensions=_int("EMBEDDING_DIM", 1024, min_value=8, max_value=4096),
        batch_size=_int("EMBEDDING_BATCH_SIZE", 16, min_value=1, max_value=128),
        timeout_seconds=_float("EMBEDDING_TIMEOUT_SECONDS", 60.0, min_value=1, max_value=600),
        max_retries=_int("EMBEDDING_MAX_RETRIES", 2, min_value=0, max_value=6),
    )

    retrieval = RetrievalSettings(
        top_k=_int("RETRIEVAL_TOP_K", 6, min_value=1, max_value=50),
        candidates=_int("RETRIEVAL_CANDIDATES", 30, min_value=1, max_value=200),
        min_similarity=_float("RETRIEVAL_MIN_SIMILARITY", 0.35, min_value=-1, max_value=1),
        fts_rescue_min_similarity=_float("RETRIEVAL_FTS_RESCUE_MIN_SIMILARITY", 0.25, min_value=-1, max_value=1),
        hybrid=_bool("RETRIEVAL_HYBRID", True),
        rrf_k=_int("RETRIEVAL_RRF_K", 60, min_value=1, max_value=1000),
        context_max_chars=_int("RAG_CONTEXT_MAX_CHARS", 24_000, min_value=1000, max_value=2_000_000),
        reranker_enabled=_bool("RERANKER_ENABLED", False),
        reranker_model=_str("RERANKER_MODEL"),
        reranker_candidates=_int("RERANKER_CANDIDATES", 30, min_value=1, max_value=200),
    )
    if retrieval.reranker_enabled and not retrieval.reranker_model:
        raise ConfigError("RERANKER_ENABLED is true but RERANKER_MODEL is not set")
    if retrieval.fts_rescue_min_similarity > retrieval.min_similarity:
        raise ConfigError("RETRIEVAL_FTS_RESCUE_MIN_SIMILARITY must be <= RETRIEVAL_MIN_SIMILARITY")

    verifier = VerifierSettings(
        enabled=_bool("VERIFIER_ENABLED", False),
        model=_str("VERIFIER_MODEL"),
        threshold=_float("VERIFIER_THRESHOLD", 0.5, min_value=0, max_value=1),
        max_claims=_int("VERIFIER_MAX_CLAIMS", 12, min_value=1, max_value=50),
    )
    if verifier.enabled and not verifier.model:
        raise ConfigError("VERIFIER_ENABLED is true but VERIFIER_MODEL is not set")

    return Settings(llm=llm, embedding=embedding, retrieval=retrieval, verifier=verifier)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()


def reset_settings_cache() -> None:
    """For tests: re-read the environment on the next get_settings()."""
    get_settings.cache_clear()
