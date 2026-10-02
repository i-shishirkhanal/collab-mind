"""
Re-index sources whose chunks were removed by the BGE-M3 migration.

    cd ai && python -m scripts.reindex            # sources flagged needs_reindex
    python -m scripts.reindex --all               # every source (e.g. after changing models)

Uses the same embed_source() path as uploads, so it needs the embedding
service configured (EMBEDDING_BASE_URL). Sources whose files are gone end up
'failed' with a reason, as in a normal upload.
"""

import argparse
import asyncio

from dotenv import load_dotenv

load_dotenv()

from db import close_pool, ensure_schema, get_pool  # noqa: E402
from rag.embedder import embed_source  # noqa: E402


async def main(reindex_all: bool) -> None:
    pool = await get_pool()
    await ensure_schema(pool)
    condition = "TRUE" if reindex_all else "(metadata->>'needs_reindex')::boolean IS TRUE"
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT id::text, workspace_id::text, url FROM sources WHERE url IS NOT NULL AND {condition}"
        )
    done = failed = 0
    for row in rows:
        stored = await embed_source(pool, row["workspace_id"], row["id"], row["url"])
        print(f"{row['id']}: {'ok, ' + str(stored) + ' chunks' if stored else 'FAILED (see sources.metadata.error)'}")
        done, failed = done + (1 if stored else 0), failed + (0 if stored else 1)
    print(f"re-indexed {done}, failed {failed}, of {len(rows)}")
    await close_pool()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    asyncio.run(main(ap.parse_args().all))
