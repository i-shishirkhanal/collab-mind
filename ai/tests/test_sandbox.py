"""The extraction sandbox: the real child process is exercised (spawned interpreter)."""

import pytest

from rag import sandbox
from rag.extractor import ExtractionError


def test_child_returns_blocks_for_a_valid_file(tmp_path, monkeypatch):
    # The spawned child inherits UPLOADS_DIR from the environment, so parent and child agree
    # on a writable directory (the /app/uploads default only exists in the container image).
    import rag.embedder as embedder

    uploads = tmp_path.resolve()
    monkeypatch.setenv("UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(embedder, "UPLOADS_DIR", uploads)

    f = uploads / "sandbox-ok.txt"
    f.write_text("hello sandbox world", encoding="utf-8")
    blocks = sandbox.run_isolated(f"local://{f}", timeout=120)
    assert "hello sandbox world" in "".join(b.text for b in blocks)


def test_user_facing_error_crosses_the_boundary():
    with pytest.raises(ExtractionError) as exc:
        sandbox.run_isolated("local:///definitely/not/inside/uploads.txt", timeout=120)
    assert "Traceback" not in str(exc.value)


def test_deadline_kills_the_child():
    # A zero deadline expires before the freshly spawned interpreter can answer.
    with pytest.raises(ExtractionError, match="too long"):
        sandbox.run_isolated("local:///x.txt", timeout=0)
