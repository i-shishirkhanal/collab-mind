"""
rag/chunker.py — Splits location-aware Blocks into embedding-sized chunks.

A chunk never spans two blocks, so it always inherits exactly one block's
page number / location label. Chunks are sliding windows of CHUNK_SIZE tokens
that overlap by CHUNK_OVERLAP tokens.

Sizing: tokens are counted with tiktoken's cl100k_base as a stable, fast proxy.
BGE-M3 (XLM-RoBERTa tokenizer, 8192-token context) counts differently, but a
512 cl100k-token window stays far inside its context for any language, so the
exact tokenizer doesn't change correctness. Override the defaults with the
CHUNK_SIZE_TOKENS / CHUNK_OVERLAP_TOKENS environment variables.
"""

import os

import tiktoken

from rag.extractor import Block

DEFAULT_CHUNK_SIZE = 512
DEFAULT_CHUNK_OVERLAP = 50
MIN_CHUNK_SIZE = 32

_tokenizer = tiktoken.get_encoding("cl100k_base")

# U+FFFD appears when a window boundary cuts through a multi-byte character.
_BOUNDARY_JUNK = "�"


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer, got {raw!r}")


def chunk_config(size: int | None = None, overlap: int | None = None) -> tuple[int, int]:
    """Resolve and validate (size, overlap): explicit args win, then env, then defaults."""
    size = size if size is not None else _env_int("CHUNK_SIZE_TOKENS", DEFAULT_CHUNK_SIZE)
    overlap = overlap if overlap is not None else _env_int("CHUNK_OVERLAP_TOKENS", DEFAULT_CHUNK_OVERLAP)
    if size < MIN_CHUNK_SIZE:
        raise ValueError(f"Chunk size must be at least {MIN_CHUNK_SIZE} tokens (got {size}).")
    if not 0 <= overlap < size:
        raise ValueError(f"Chunk overlap must be between 0 and size-1 (got {overlap} for size {size}).")
    return size, overlap


# Defaults, kept for callers/tests that reference them.
CHUNK_SIZE = DEFAULT_CHUNK_SIZE
CHUNK_OVERLAP = DEFAULT_CHUNK_OVERLAP


def chunk_blocks(blocks: list[Block], size: int | None = None, overlap: int | None = None) -> list[Block]:
    size, overlap = chunk_config(size, overlap)
    step = size - overlap
    chunks: list[Block] = []

    for block in blocks:
        text = block.text.strip()
        if not text:
            continue
        token_ids = _tokenizer.encode(text)

        for start in range(0, len(token_ids), step):
            end = start + size
            piece = _tokenizer.decode(token_ids[start:end]).strip(_BOUNDARY_JUNK + " \n\t\r")
            if piece:
                chunks.append(Block(piece, page_number=block.page_number,
                                    location_label=block.location_label))
            if end >= len(token_ids):
                break

    return chunks
