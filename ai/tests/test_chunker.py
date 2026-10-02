import pytest

from rag.chunker import DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, chunk_blocks, chunk_config
from rag.extractor import Block


def _words(n):
    return " ".join(f"term{i}" for i in range(n))


def test_defaults_and_env_override(monkeypatch):
    monkeypatch.delenv("CHUNK_SIZE_TOKENS", raising=False)
    monkeypatch.delenv("CHUNK_OVERLAP_TOKENS", raising=False)
    assert chunk_config() == (DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP)
    monkeypatch.setenv("CHUNK_SIZE_TOKENS", "128")
    monkeypatch.setenv("CHUNK_OVERLAP_TOKENS", "16")
    assert chunk_config() == (128, 16)


@pytest.mark.parametrize("size,overlap", [(10, 0), (100, 100), (100, -1), (100, 150)])
def test_invalid_config_is_rejected(size, overlap):
    with pytest.raises(ValueError):
        chunk_config(size, overlap)


def test_non_integer_env_is_rejected(monkeypatch):
    monkeypatch.setenv("CHUNK_SIZE_TOKENS", "big")
    with pytest.raises(ValueError, match="CHUNK_SIZE_TOKENS"):
        chunk_config()


def test_consecutive_chunks_overlap_and_cover_the_whole_text():
    text = _words(600)
    chunks = chunk_blocks([Block(text)], size=100, overlap=20)
    assert len(chunks) > 3
    # Overlap: words at the tail of one chunk reappear in the next chunk.
    for a, b in zip(chunks, chunks[1:]):
        tail = a.text.split()[-3:]
        assert all(w in b.text for w in tail)
    # Coverage: first and last terms present, and sampled terms in between.
    joined = " ".join(c.text for c in chunks)
    assert "term0" in chunks[0].text and "term599" in chunks[-1].text
    assert all(f"term{i}" in joined for i in range(0, 600, 37))


def test_chunking_is_deterministic_so_reprocessing_yields_identical_chunks():
    blocks = [Block(_words(400), page_number=2, location_label="Page 2")]
    assert chunk_blocks(blocks, size=100, overlap=10) == chunk_blocks(blocks, size=100, overlap=10)


def test_zero_overlap_produces_no_repeated_text():
    chunks = chunk_blocks([Block(_words(300))], size=64, overlap=0)
    texts = [c.text for c in chunks]
    assert len(set(texts)) == len(texts)


def test_multibyte_text_never_leaves_replacement_characters_at_boundaries():
    text = "データ処理🙂研究ノート " * 300
    chunks = chunk_blocks([Block(text)], size=64, overlap=8)
    assert len(chunks) > 5
    assert not any(c.text.startswith("�") or c.text.endswith("�") for c in chunks)


def test_chunk_order_matches_block_order_and_metadata_is_preserved():
    blocks = [Block(_words(150), page_number=1, location_label="Page 1"),
              Block(_words(150), page_number=2, location_label="Page 2")]
    chunks = chunk_blocks(blocks, size=64, overlap=8)
    pages = [c.page_number for c in chunks]
    assert pages == sorted(pages) and set(pages) == {1, 2}
