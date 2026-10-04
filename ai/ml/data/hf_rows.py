"""
ml/data/hf_rows.py — read public Hugging Face datasets over the datasets-server HTTP API.

No `datasets` or `torch` install is needed, so data preparation runs on any laptop. Pages are cached on
disk (ml/data/cache) so a re-run costs nothing. Only public datasets are read; every dataset used is
listed with its licence in ai/THIRD_PARTY_NOTICES.md.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Iterator, Optional

import httpx

API = "https://datasets-server.huggingface.co/rows"
PAGE = 100                       # the API's maximum page size
PAUSE_SECONDS = 1.0              # between uncached requests
CACHE = Path(__file__).parent / "cache"


def _page(dataset: str, config: str, split: str, offset: int, length: int) -> dict:
    key = f"{dataset.replace('/', '__')}__{config}__{split}__{offset}__{length}.json"
    path = CACHE / key
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    params = {"dataset": dataset, "config": config, "split": split, "offset": offset, "length": length}
    for attempt in range(7):
        r = httpx.get(API, params=params, timeout=60)
        if r.status_code == 200:
            CACHE.mkdir(parents=True, exist_ok=True)
            path.write_text(r.text, encoding="utf-8")
            time.sleep(PAUSE_SECONDS)       # stay under the public rate limit
            return r.json()
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(min(60, 5 * 2 ** attempt))
            continue
        r.raise_for_status()
    raise RuntimeError(f"{dataset}/{config}/{split} @ {offset}: gave up after retries")


def iter_rows(dataset: str, config: str, split: str, *, limit: Optional[int] = None,
              start: int = 0) -> Iterator[dict]:
    """Rows in order from `start`, at most `limit` of them."""
    offset, seen = start, 0
    while limit is None or seen < limit:
        length = PAGE if limit is None else min(PAGE, limit - seen)
        data = _page(dataset, config, split, offset, length)
        rows = data["rows"]
        if not rows:
            return
        for r in rows:
            yield r["row"]
        seen += len(rows)
        offset += len(rows)
        if offset >= data["num_rows_total"]:
            return
