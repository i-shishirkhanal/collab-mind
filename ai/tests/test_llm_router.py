"""Model routing, retries, fallback and error mapping — DeepSeek mocked at the HTTP layer."""

import asyncio
import logging

import httpx
import pytest

from llm import errors
from llm.redaction import install_log_redaction, redact, register_secret
from llm.router import classify_task
from llm.types import Task, Tier
from llm_helpers import FLASH, PRO, Recorder, completion_json, make_router, sse_body

MSG = [{"role": "user", "content": "hi"}]


def run(coro):
    return asyncio.run(coro)


def ok(**kw):
    return httpx.Response(200, json=completion_json(**kw))


# ── routing ───────────────────────────────────────────────────────────────────

def test_chat_and_study_route_to_flash_with_thinking_disabled():
    for task in (Task.CHAT, Task.STUDY):
        rec = Recorder(ok())
        c = run(make_router(rec).complete(task, MSG))
        assert rec.models == [FLASH]
        assert rec.requests[0]["thinking"] == {"type": "disabled"}
        assert rec.requests[0]["temperature"] == 0.2
        assert c.route.tier is Tier.FLASH and c.route.model_requested == FLASH


def test_research_routes_to_pro_with_thinking_enabled_and_no_temperature():
    rec = Recorder(ok(model=PRO))
    c = run(make_router(rec).complete(Task.RESEARCH, MSG))
    assert rec.models == [PRO]
    assert rec.requests[0]["thinking"] == {"type": "enabled"}
    assert "temperature" not in rec.requests[0]  # ignored by the provider in thinking mode
    assert c.route.tier is Tier.PRO and c.route.model_used == PRO


def test_models_come_from_configuration_not_hardcoded():
    rec = Recorder(ok())
    run(make_router(rec, model_flash="my-flash").complete(Task.CHAT, MSG))
    assert rec.models == ["my-flash"]


def test_request_is_authenticated_and_hits_chat_completions():
    seen = {}

    def handler(request):
        seen["url"], seen["auth"] = str(request.url), request.headers["authorization"]
        return ok()

    run(make_router(handler).complete(Task.CHAT, MSG))
    assert seen["url"] == "https://llm.test/chat/completions"
    assert seen["auth"].startswith("Bearer sk-test-")


def test_json_mode_sets_response_format():
    rec = Recorder(ok(text="{}"))
    run(make_router(rec).complete(Task.STUDY, MSG, json_mode=True))
    assert rec.requests[0]["response_format"] == {"type": "json_object"}


@pytest.mark.parametrize("text,expected", [
    ("What is photosynthesis?", Task.CHAT),
    ("Summarise chapter 2", Task.CHAT),
    ("Compare the methodology in paper A with paper B", Task.RESEARCH),
    ("Critically evaluate the trade-offs of this approach", Task.RESEARCH),
    ("Synthesize the findings across all my sources", Task.RESEARCH),
])
def test_auto_classification(text, expected):
    assert classify_task(text, None, auto_research=True) is expected


def test_explicit_task_wins_and_auto_can_be_disabled():
    assert classify_task("Compare A and B", Task.CHAT, auto_research=True) is Task.CHAT
    assert classify_task("hi", Task.RESEARCH, auto_research=False) is Task.RESEARCH
    assert classify_task("Compare A with B", None, auto_research=False) is Task.CHAT


def test_route_records_model_the_provider_actually_reported():
    # e.g. a provider alias/redirect: requested v4-pro, the response says flash.
    rec = Recorder(ok(model="deepseek-flash"))
    c = run(make_router(rec).complete(Task.RESEARCH, MSG))
    assert c.route.model_requested == PRO and c.route.model_used == "deepseek-flash"
    assert c.route.fallback_used is False


def test_token_usage_is_captured():
    c = run(make_router(Recorder(ok())).complete(Task.CHAT, MSG))
    assert (c.usage.prompt_tokens, c.usage.completion_tokens, c.usage.total_tokens) == (120, 30, 150)
    assert c.usage.reasoning_tokens == 7


def test_missing_usage_is_none_not_invented():
    c = run(make_router(Recorder(ok(usage=False))).complete(Task.CHAT, MSG))
    assert c.usage.total_tokens is None


# ── failures ──────────────────────────────────────────────────────────────────

def test_missing_api_key_fails_clearly_without_any_request():
    rec = Recorder(ok())
    with pytest.raises(errors.NotConfiguredError):
        run(make_router(rec, api_key="").complete(Task.CHAT, MSG))
    assert rec.requests == []


def test_rate_limit_is_retried_honouring_retry_after_then_succeeds():
    rec = Recorder(httpx.Response(429, headers={"retry-after": "3"}, json={"error": {"message": "slow"}}), ok())
    router = make_router(rec)
    c = run(router.complete(Task.CHAT, MSG))
    assert len(rec.requests) == 2 and c.route.attempts == 2
    assert router.sleeps == [3.0]


def test_retries_are_bounded_and_end_in_a_typed_error():
    rec = Recorder(httpx.Response(429, json={}))
    with pytest.raises(errors.RateLimitedError) as exc:
        run(make_router(rec, max_retries=2).complete(Task.CHAT, MSG))
    assert len(rec.requests) == 3 and exc.value.http_status == 429


def test_server_overload_503_is_retried():
    rec = Recorder(httpx.Response(503, json={}), httpx.Response(500, json={}), ok())
    c = run(make_router(rec).complete(Task.CHAT, MSG))
    assert c.route.attempts == 3


def test_timeout_is_retried_then_raises_timeout_error():
    rec = Recorder(httpx.ReadTimeout("slow"))
    with pytest.raises(errors.ProviderTimeoutError) as exc:
        run(make_router(rec, max_retries=1).complete(Task.CHAT, MSG))
    assert len(rec.requests) == 2 and exc.value.http_status == 504


def test_connection_error_maps_to_overloaded():
    with pytest.raises(errors.ProviderOverloadedError):
        run(make_router(Recorder(httpx.ConnectError("down")), max_retries=0).complete(Task.CHAT, MSG))


@pytest.mark.parametrize("status,exc_type", [
    (401, errors.AuthenticationError),
    (402, errors.InsufficientBalanceError),
    (422, errors.InvalidRequestError),
    (404, errors.ModelUnavailableError),
])
def test_permanent_errors_are_not_retried(status, exc_type):
    rec = Recorder(httpx.Response(status, json={"error": {"message": "nope"}}))
    with pytest.raises(exc_type):
        run(make_router(rec).complete(Task.CHAT, MSG))
    assert len(rec.requests) == 1


def test_unknown_model_400_is_reported_as_model_unavailable():
    rec = Recorder(httpx.Response(400, json={"error": {"message": "Model Not Exist"}}))
    with pytest.raises(errors.ModelUnavailableError):
        run(make_router(rec).complete(Task.CHAT, MSG))


@pytest.mark.parametrize("response", [
    httpx.Response(200, text="<html>gateway</html>"),
    httpx.Response(200, json={"choices": []}),
    httpx.Response(200, json=completion_json(text="")),
    httpx.Response(200, json={"choices": [{"message": {"content": None}, "finish_reason": "stop"}]}),
])
def test_malformed_responses_raise_malformed_error_and_are_not_retried(response):
    rec = Recorder(response)
    with pytest.raises(errors.MalformedResponseError):
        run(make_router(rec).complete(Task.CHAT, MSG))
    assert len(rec.requests) == 1


# ── fallback ──────────────────────────────────────────────────────────────────

def test_no_fallback_by_default_pro_failure_surfaces():
    rec = Recorder(httpx.Response(404, json={"error": {"message": "x"}}))
    with pytest.raises(errors.ModelUnavailableError):
        run(make_router(rec).complete(Task.RESEARCH, MSG))
    assert rec.models == [PRO]  # Flash was never silently substituted


def test_configured_fallback_serves_flash_and_says_so():
    rec = Recorder(httpx.Response(404, json={"error": {"message": "x"}}), ok(model=FLASH))
    c = run(make_router(rec, fallback_pro_to_flash=True).complete(Task.RESEARCH, MSG))
    assert rec.models == [PRO, FLASH]
    assert c.route.fallback_used is True and c.route.tier is Tier.FLASH
    assert c.route.model_requested == FLASH and c.route.model_used == FLASH
    assert "model_unavailable" in c.route.fallback_reason


def test_fallback_after_pro_retries_exhausted():
    rec = Recorder(httpx.Response(503, json={}), httpx.Response(503, json={}), ok())
    c = run(make_router(rec, fallback_pro_to_flash=True, max_retries=1).complete(Task.RESEARCH, MSG))
    assert rec.models == [PRO, PRO, FLASH] and c.route.fallback_used


def test_fallback_never_applies_to_auth_errors_or_flash_requests():
    rec = Recorder(httpx.Response(401, json={}))
    with pytest.raises(errors.AuthenticationError):
        run(make_router(rec, fallback_pro_to_flash=True).complete(Task.RESEARCH, MSG))
    assert rec.models == [PRO]
    rec = Recorder(httpx.Response(503, json={}))
    with pytest.raises(errors.ProviderOverloadedError):
        run(make_router(rec, fallback_pro_to_flash=True, max_retries=0).complete(Task.CHAT, MSG))
    assert rec.models == [FLASH]


# ── streaming ─────────────────────────────────────────────────────────────────

async def _collect(agen):
    return [ev async for ev in agen]


def test_stream_yields_deltas_then_done_with_usage_and_route():
    rec = Recorder(httpx.Response(200, content=sse_body(["Hel", "lo [1]."]),
                                  headers={"content-type": "text/event-stream"}))
    events = run(_collect(make_router(rec).stream(Task.CHAT, MSG)))
    assert [e.text for e in events if e.kind == "delta"] == ["Hel", "lo [1]."]
    done = events[-1]
    assert done.kind == "done" and done.usage.total_tokens == 14
    assert done.route.model_used == FLASH and rec.requests[0]["stream"] is True
    assert rec.requests[0]["stream_options"] == {"include_usage": True}


def test_stream_retries_before_first_byte():
    rec = Recorder(httpx.Response(429, json={}), httpx.Response(200, content=sse_body(["ok"])))
    events = run(_collect(make_router(rec).stream(Task.CHAT, MSG)))
    assert len(rec.requests) == 2 and events[-1].route.attempts == 2


def test_stream_pro_fallback_is_reported():
    rec = Recorder(httpx.Response(404, json={}), httpx.Response(200, content=sse_body(["ok"])))
    events = run(_collect(make_router(rec, fallback_pro_to_flash=True).stream(Task.RESEARCH, MSG)))
    assert rec.models == [PRO, FLASH]
    assert events[-1].route.fallback_used and events[-1].route.tier is Tier.FLASH


def test_stream_with_no_text_is_malformed():
    rec = Recorder(httpx.Response(200, content=sse_body([])))
    with pytest.raises(errors.MalformedResponseError):
        run(_collect(make_router(rec).stream(Task.CHAT, MSG)))


# ── secrets ───────────────────────────────────────────────────────────────────

def test_redaction_removes_known_secrets_and_bearer_tokens():
    register_secret("sk-test-secret-key-1234567890")
    assert "sk-test" not in redact("failed with key sk-test-secret-key-1234567890")
    assert "abcdefghijklmnop" not in redact("Authorization: Bearer abcdefghijklmnop")


def test_provider_errors_and_logs_never_contain_the_api_key(caplog):
    install_log_redaction()
    rec = Recorder(httpx.Response(401, json={"error": {"message": "bad key sk-test-secret-key-1234567890"}}))
    router = make_router(rec)
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(errors.AuthenticationError) as exc:
            run(router.complete(Task.CHAT, MSG))
    assert "sk-test-secret" not in str(exc.value)
    assert "sk-test-secret" not in caplog.text
