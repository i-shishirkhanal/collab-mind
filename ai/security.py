"""
security.py — service-to-service authentication for the AI service.

Only the Express backend may call this service. It presents the shared secret
AI_SERVICE_TOKEN as `Authorization: Bearer <token>`. Every route except
/health requires it; the comparison is constant-time. A missing or weak token
stops the service from starting rather than silently disabling protection.
"""

import hmac
import os

from fastapi import HTTPException, Request

MIN_TOKEN_LENGTH = 32
PUBLIC_PATHS = frozenset({"/health"})
_PLACEHOLDER_MARKERS = ("your_", "dummy", "changeme", "change_me", "secret_key")


def load_service_token() -> str:
    """Return the configured token or raise RuntimeError (used at startup)."""
    token = os.environ.get("AI_SERVICE_TOKEN", "")
    if not token:
        raise RuntimeError("AI_SERVICE_TOKEN is required")
    if len(token) < MIN_TOKEN_LENGTH:
        raise RuntimeError(f"AI_SERVICE_TOKEN must be at least {MIN_TOKEN_LENGTH} characters")
    if any(marker in token.lower() for marker in _PLACEHOLDER_MARKERS):
        raise RuntimeError("AI_SERVICE_TOKEN looks like a placeholder; generate a random secret")
    return token


async def require_service_auth(request: Request) -> None:
    """App-level dependency: 401 unless the caller presents the service token."""
    if request.url.path in PUBLIC_PATHS:
        return

    try:
        expected = load_service_token()
    except RuntimeError:
        # Misconfigured: fail closed without revealing why to the caller.
        raise HTTPException(status_code=503, detail="Service unavailable")

    scheme, _, supplied = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not supplied or not hmac.compare_digest(
        supplied.strip().encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(
            status_code=401, detail="Unauthorized", headers={"WWW-Authenticate": "Bearer"}
        )
