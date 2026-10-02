"""Keeps credentials out of logs and error messages."""

import logging
import re

_PATTERNS = [
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)((?:api[_-]?key|token|secret|authorization)[\"'\s:=]+)[A-Za-z0-9._\-]{8,}"),
]
_known_secrets: set[str] = set()


def register_secret(value: str) -> None:
    if value and len(value) >= 6:
        _known_secrets.add(value)


def redact(text: str) -> str:
    for secret in _known_secrets:
        text = text.replace(secret, "[REDACTED]")
    for pattern in _PATTERNS:
        text = pattern.sub(lambda m: (m.group(1) if m.groups() else "") + "[REDACTED]", text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = redact(record.getMessage())
            record.args = ()
        except Exception:
            pass
        return True


def install_log_redaction() -> None:
    root = logging.getLogger()
    if not any(isinstance(f, RedactingFilter) for f in root.filters):
        root.addFilter(RedactingFilter())
    for handler in root.handlers:
        if not any(isinstance(f, RedactingFilter) for f in handler.filters):
            handler.addFilter(RedactingFilter())
