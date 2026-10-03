"""Service-to-service authentication for the AI service (no DB, Redis or model needed)."""

import importlib

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import security

TOKEN = "t" * 16 + "unit-test-ai-token-0123456789abcdef"


@pytest.fixture(autouse=True)
def _token(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_TOKEN", TOKEN)


def make_app() -> FastAPI:
    app = FastAPI(dependencies=[Depends(security.require_service_auth)], docs_url=None, openapi_url=None)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.post("/chat")
    async def chat():
        return {"answer": "secret"}

    return app


def test_health_is_public():
    assert TestClient(make_app()).get("/health").json() == {"status": "ok"}


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer"},
        {"Authorization": "Bearer "},
        {"Authorization": "Bearer wrong"},
        {"Authorization": f"Basic {TOKEN}"},
        {"Authorization": TOKEN},
        {"Authorization": f"Bearer {TOKEN}x"},
        {"Authorization": f"Bearer {TOKEN[:-1]}"},
        {"X-Service-Token": TOKEN},
    ],
)
def test_protected_route_rejects_missing_or_wrong_credentials(headers):
    r = TestClient(make_app()).post("/chat", headers=headers)
    assert r.status_code == 401
    assert "secret" not in r.text
    assert r.headers.get("www-authenticate") == "Bearer"


def test_protected_route_accepts_the_service_token():
    r = TestClient(make_app()).post("/chat", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200


def test_unconfigured_service_fails_closed(monkeypatch):
    monkeypatch.delenv("AI_SERVICE_TOKEN")
    r = TestClient(make_app()).post("/chat", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 503  # never "open because no token is set"
    assert TestClient(make_app()).get("/health").status_code == 200


@pytest.mark.parametrize("value", ["", "short", "your_token_here_please_change_this_now", "dummy" * 10, "change_me" * 5])
def test_weak_or_placeholder_tokens_refuse_startup(monkeypatch, value):
    monkeypatch.setenv("AI_SERVICE_TOKEN", value)
    with pytest.raises(RuntimeError):
        security.load_service_token()


def test_real_app_requires_auth_on_every_route_but_health(monkeypatch):
    """Uses the real FastAPI app object: every route (except /health) must carry the dependency."""
    try:
        main = importlib.import_module("main")
    except Exception as exc:  # heavy optional deps unavailable in this environment
        pytest.skip(f"main.py not importable here: {exc!r}")

    assert main.app.openapi_url is None and main.app.docs_url is None, "docs must be off by default"

    unauth = []
    for route in main.app.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/") or path in {"/health"} or not hasattr(route, "dependant"):
            continue
        calls = [d.call for d in route.dependant.dependencies]
        deps_on_app = [d.dependency for d in main.app.router.dependencies]
        if security.require_service_auth not in calls and security.require_service_auth not in deps_on_app:
            unauth.append(path)
    assert unauth == []

    client = TestClient(main.app)  # no lifespan context: no DB/Redis touched
    for method, path in [("post", "/chat"), ("post", "/embed"), ("post", "/sources/summarize"),
                         ("post", "/agents/study-coach"), ("post", "/agents/abc/approve"),
                         ("get", "/agents/abc/status"), ("post", "/studio/quiz"), ("post", "/studio/flashcards")]:
        r = client.request(method.upper(), path)
        assert r.status_code == 401, f"{method} {path} -> {r.status_code}"
    assert client.get("/health").status_code == 200
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
