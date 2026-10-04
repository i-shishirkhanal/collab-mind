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


def iter_parquet(dataset: str, config: str, split: str, *, columns: Optional[list[str]] = None,
                 every: int = 1) -> Iterator[dict]:
    """Rows of a whole split from its auto-converted Parquet files (one download per file, no rate limit).

    Needs `pyarrow` (preinstalled on Kaggle/Colab). `every=k` keeps every k-th row for cheap subsampling."""
    import pyarrow.parquet as pq

    CACHE.mkdir(parents=True, exist_ok=True)
    urls = httpx.get(f"https://huggingface.co/api/datasets/{dataset}/parquet/{config}/{split}", timeout=60,
                     follow_redirects=True).raise_for_status().json()
    n = 0
    for i, url in enumerate(urls):
        path = CACHE / f"{dataset.replace('/', '__')}__{config}__{split}__{i}.parquet"
        if not path.exists():
            tmp = path.with_suffix(".part")
            for attempt in range(4):
                try:
                    with httpx.stream("GET", url, timeout=300, follow_redirects=True) as r, open(tmp, "wb") as f:
                        r.raise_for_status()
                        for chunk in r.iter_bytes(1 << 20):
                            f.write(chunk)
                    break
                except httpx.TransportError:
                    if attempt == 3:
                        raise
                    time.sleep(5 * (attempt + 1))
            tmp.replace(path)
        for batch in pq.ParquetFile(path).iter_batches(batch_size=2048, columns=columns):
            for row in batch.to_pylist():
                if n % every == 0:
                    yield row
                n += 1


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
