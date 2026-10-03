"""The extraction sandbox: the real child process is exercised (spawned interpreter)."""

import pytest

from rag import sandbox
from rag.extractor import ExtractionError


def test_child_returns_blocks_for_a_valid_file():
    # The spawned child reads the same default uploads directory as the parent.
    import rag.embedder as embedder

    f = embedder.UPLOADS_DIR / "sandbox-ok.txt"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("hello sandbox world", encoding="utf-8")
    try:
        blocks = sandbox.run_isolated(f"local://{f}", timeout=120)
    finally:
        f.unlink(missing_ok=True)
    assert "hello sandbox world" in "".join(b.text for b in blocks)


def test_user_facing_error_crosses_the_boundary():
    with pytest.raises(ExtractionError) as exc:
        sandbox.run_isolated("local:///definitely/not/inside/uploads.txt", timeout=120)
    assert "Traceback" not in str(exc.value)


def test_deadline_kills_the_child():
    # A zero deadline expires before the freshly spawned interpreter can answer.
    with pytest.raises(ExtractionError, match="too long"):
        sandbox.run_isolated("local:///x.txt", timeout=0)
