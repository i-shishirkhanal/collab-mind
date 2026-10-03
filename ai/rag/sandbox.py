"""
rag/sandbox.py — run document extraction in a throw-away child process.

Parsing untrusted PDF / Office files can use unbounded memory or CPU (zip bombs, pathological
PDFs). In a thread, a timeout cannot stop the work and an out-of-memory kill takes the whole
service (and everyone's chat) with it. In a child process the parent can kill it on a deadline,
and on Linux the child is additionally capped with RLIMIT_AS / RLIMIT_CPU, so the worst case is
one failed upload.

The child is started with the `spawn` method (fresh interpreter, no inherited sockets or DB pool).
"""

import multiprocessing
import os
from typing import Optional

from rag.extractor import Block, ExtractionError

DEFAULT_MEMORY_MB = 1536
CRASH_MESSAGE = "This file could not be processed. It may be corrupt, password-protected or too complex."
TIMEOUT_MESSAGE = "Processing took too long and was stopped."


def _apply_limits(memory_mb: int, cpu_seconds: int) -> None:
    try:
        import resource  # POSIX only
    except ImportError:
        return
    limit = memory_mb * 1024 * 1024
    for name, value in (("RLIMIT_AS", limit), ("RLIMIT_CPU", cpu_seconds)):
        try:
            resource.setrlimit(getattr(resource, name), (value, value))
        except (ValueError, OSError):
            pass


def _child_main(conn, storage_url: str, memory_mb: int, cpu_seconds: int) -> None:
    _apply_limits(memory_mb, cpu_seconds)
    try:
        from rag.embedder import load_blocks

        blocks = load_blocks(storage_url)
        conn.send(("ok", [(b.text, b.page_number, b.location_label) for b in blocks]))
    except ExtractionError as exc:
        conn.send(("extraction_error", str(exc)))
    except MemoryError:
        conn.send(("crashed", None))
    except BaseException:  # never let a traceback (paths, content) cross the process boundary
        conn.send(("crashed", None))
    finally:
        conn.close()


def run_isolated(
    storage_url: str,
    timeout: float,
    memory_mb: Optional[int] = None,
) -> list[Block]:
    """Blocking. Same contract as load_blocks(): returns blocks or raises ExtractionError with a
    message that is safe to show to the user."""
    memory_mb = memory_mb or int(os.environ.get("EXTRACTION_MEMORY_MB", DEFAULT_MEMORY_MB))
    ctx = multiprocessing.get_context("spawn")
    receiver, sender = ctx.Pipe(duplex=False)
    proc = ctx.Process(
        target=_child_main,
        args=(sender, storage_url, memory_mb, int(timeout) + 5),
        daemon=True,
    )
    proc.start()
    sender.close()
    try:
        if not receiver.poll(timeout):
            raise ExtractionError(TIMEOUT_MESSAGE)
        try:
            kind, payload = receiver.recv()
        except (EOFError, OSError):  # killed by the kernel (OOM / RLIMIT) before it could answer
            raise ExtractionError(CRASH_MESSAGE)
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join(5)
        receiver.close()

    if kind == "ok":
        return [Block(text=t, page_number=p, location_label=l) for t, p, l in payload]
    if kind == "extraction_error":
        raise ExtractionError(payload)
    raise ExtractionError(CRASH_MESSAGE)
