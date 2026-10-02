"""Environment validation."""

import pytest

import config

ENV_KEYS = ["DEEPSEEK_API_KEY", "LLM_BASE_URL", "LLM_MODEL_FLASH", "LLM_MODEL_PRO", "LLM_MAX_RETRIES",
            "LLM_FALLBACK_PRO_TO_FLASH", "LLM_FLASH_THINKING", "EMBEDDING_BASE_URL", "EMBEDDING_DIM",
            "RETRIEVAL_MIN_SIMILARITY", "RETRIEVAL_FTS_RESCUE_MIN_SIMILARITY", "LLM_TIMEOUT_SECONDS"]


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for k in ENV_KEYS:
        monkeypatch.delenv(k, raising=False)


def test_defaults_match_the_required_model_assignments():
    s = config.load_settings()
    assert s.llm.model_flash == "deepseek-flash"        # DeepSeek V4.1 Flash
    assert s.llm.model_pro == "deepseek-v4-pro"         # DeepSeek V4 Pro
    assert s.embedding.model == "BAAI/bge-m3" and s.embedding.dimensions == 1024
    assert s.llm.fallback_pro_to_flash is False


def test_missing_credentials_are_reported_not_fatal():
    problems = config.load_settings().validate_for_serving()
    assert any("DEEPSEEK_API_KEY" in p for p in problems) and any("EMBEDDING_BASE_URL" in p for p in problems)


def test_overrides(monkeypatch):
    monkeypatch.setenv("LLM_MODEL_PRO", "other-pro")
    monkeypatch.setenv("LLM_FALLBACK_PRO_TO_FLASH", "true")
    s = config.load_settings()
    assert s.llm.model_pro == "other-pro" and s.llm.fallback_pro_to_flash is True


@pytest.mark.parametrize("key,value", [
    ("LLM_MAX_RETRIES", "-1"), ("LLM_MAX_RETRIES", "x"), ("LLM_TIMEOUT_SECONDS", "0"),
    ("LLM_FALLBACK_PRO_TO_FLASH", "maybe"), ("LLM_FLASH_THINKING", "sometimes"),
    ("LLM_BASE_URL", "api.deepseek.com"), ("EMBEDDING_DIM", "2"), ("RETRIEVAL_MIN_SIMILARITY", "5"),
])
def test_invalid_values_fail_fast(monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(config.ConfigError):
        config.load_settings()


def test_rescue_floor_cannot_exceed_main_floor(monkeypatch):
    monkeypatch.setenv("RETRIEVAL_MIN_SIMILARITY", "0.3")
    monkeypatch.setenv("RETRIEVAL_FTS_RESCUE_MIN_SIMILARITY", "0.5")
    with pytest.raises(config.ConfigError):
        config.load_settings()


def test_secrets_are_not_in_repr(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-super-secret-value")
    assert "sk-super-secret-value" not in repr(config.load_settings())
