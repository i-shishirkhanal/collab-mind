"""Typed provider failures. `retryable` drives the router's retry loop and
`http_status` is what the API layer returns to callers."""


class ProviderError(Exception):
    retryable = False
    http_status = 502
    code = "provider_error"

    def __init__(self, message: str, *, provider: str = "", model: str = "", status: int | None = None):
        super().__init__(message)
        self.provider = provider
        self.model = model
        self.upstream_status = status
        self.retry_after: float | None = None


class NotConfiguredError(ProviderError):
    http_status = 503
    code = "not_configured"


class AuthenticationError(ProviderError):
    http_status = 502  # our credentials are wrong; not the caller's fault
    code = "provider_auth_failed"


class InsufficientBalanceError(ProviderError):
    http_status = 502
    code = "provider_insufficient_balance"


class InvalidRequestError(ProviderError):
    http_status = 502
    code = "provider_invalid_request"


class ModelUnavailableError(ProviderError):
    http_status = 503
    code = "model_unavailable"


class RateLimitedError(ProviderError):
    retryable = True
    http_status = 429
    code = "provider_rate_limited"


class ProviderOverloadedError(ProviderError):
    retryable = True
    http_status = 503
    code = "provider_overloaded"


class ProviderTimeoutError(ProviderError):
    retryable = True
    http_status = 504
    code = "provider_timeout"


class MalformedResponseError(ProviderError):
    http_status = 502
    code = "malformed_response"


class EmbeddingUnavailableError(ProviderError):
    """Embedding could not be produced. Nothing may be stored or searched with
    a substitute vector."""

    http_status = 503
    code = "embedding_unavailable"
