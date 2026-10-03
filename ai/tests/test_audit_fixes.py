"""Regression tests for the 2026-10-03 audit fixes."""

import io
import zipfile

import pytest
from pydantic import ValidationError

import schemas


def test_studio_requests_are_bounded():
    schemas.QuizRequest(workspace_id="w", topic="photosynthesis", count=30)
    for bad in (
        dict(workspace_id="w", topic="t", count=31),
        dict(workspace_id="w", topic="t", count=0),
        dict(workspace_id="w", topic="t", difficulty="impossible"),
        dict(workspace_id="w", topic="x" * 501),
    ):
        with pytest.raises(ValidationError):
            schemas.QuizRequest(**bad)
    with pytest.raises(ValidationError):
        schemas.FlashcardRequest(workspace_id="w", count=51)
    with pytest.raises(ValidationError):
        schemas.ReportRequest(workspace_id="w", title="t", outline_points=["p"] * 31)


def test_chat_request_is_bounded():
    schemas.ChatRequest(workspace_id="w", message="hi")
    with pytest.raises(ValidationError):
        schemas.ChatRequest(workspace_id="w", message="x" * 8001)
    with pytest.raises(ValidationError):
        schemas.ChatRequest(workspace_id="w", message="hi", conversation_history=[{"role": "system", "content": "x"}])
    with pytest.raises(ValidationError):
        schemas.ChatRequest(workspace_id="w", message="hi", source_ids=["s"] * 51)


def _zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


def test_zip_bomb_is_rejected_before_parsing():
    extractor = pytest.importorskip("rag.extractor")
    bomb = _zip({"word/document.xml": b"0" * (60 * 1024 * 1024)})  # ~60 MB declared, a few KB stored
    assert len(bomb) < 200 * 1024
    with pytest.raises(extractor.ExtractionError, match="unreasonable size"):
        extractor._reject_zip_bomb(bomb)

    normal = _zip({"word/document.xml": b"<w:document>hello world</w:document>" * 20})
    extractor._reject_zip_bomb(normal)  # does not raise
    extractor._reject_zip_bomb(b"PK\x03\x04 not really a zip")  # left to the normal conversion path
