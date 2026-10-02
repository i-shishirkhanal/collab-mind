"""
rag/extractor.py — Turns any supported source (file bytes or a web URL) into
location-aware text blocks, using Microsoft's MarkItDown for the format
conversion (https://github.com/microsoft/markitdown, MIT).

Why a wrapper instead of calling MarkItDown directly:
  * MarkItDown only produces one markdown string per file. Citations need to
    point at a real location, so each format's markers (PDF page breaks,
    PPTX slide comments, XLSX sheet headings, DOCX/HTML headings) are split
    into separate Blocks that carry that location.
  * MarkItDown can fetch URLs on its own, but without any SSRF protection.
    We never hand it a URL to fetch: web pages are downloaded here through a
    guarded fetcher and passed in as bytes.
"""

import io
import ipaddress
import re
import socket
from dataclasses import dataclass
from typing import Callable, Optional
from urllib.parse import urljoin, urlparse

import httpx
from markitdown import MarkItDown, StreamInfo

MAX_URL_BYTES = 10 * 1024 * 1024
MAX_REDIRECTS = 5
URL_TIMEOUT_SECONDS = 15.0

SUPPORTED_EXTENSIONS = {
    ".pdf", ".docx", ".pptx", ".xlsx", ".xls",
    ".txt", ".md", ".csv", ".html", ".htm", ".json",
}

_EXTENSION_BY_CONTENT_TYPE = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/html": ".html",
    "application/xhtml+xml": ".html",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/json": ".json",
}

_ZIP = b"PK\x03\x04"
_BINARY_SIGNATURES = {
    ".pdf": b"%PDF-",
    ".docx": _ZIP,
    ".pptx": _ZIP,
    ".xlsx": _ZIP,
    ".xls": b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",
}
_UNCONVERTED_PREFIXES = ("%PDF-", "PK\x03\x04", "PK", "�")

_SLIDE_MARKER = re.compile(r"<!--\s*Slide number:\s*(\d+)\s*-->")
_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)

_markitdown = MarkItDown(enable_plugins=False)


class ExtractionError(Exception):
    """The source could not be turned into usable text. The message is safe to
    show to the end user (no stack traces, paths or secrets)."""


@dataclass
class Block:
    """One unit of extracted content plus where it came from.

    page_number is only set for real PDF pages. location_label is the
    human-readable location for every format ("Page 3", "Slide 2",
    "Sheet: Yield", "Section: Methods"); it is None when the source has no
    meaningful location (e.g. a plain text file).
    """
    text: str
    page_number: Optional[int] = None
    location_label: Optional[str] = None


def _clean(text: str) -> str:
    text = text.replace("\x00", "")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _split_pdf(markdown: str) -> list[Block]:
    # MarkItDown joins PDF pages with a form feed, so the Nth segment is page N
    # (blank pages keep their number; they simply produce no block).
    blocks = []
    for number, page in enumerate(markdown.split("\x0c"), start=1):
        text = _clean(page)
        if text:
            blocks.append(Block(text, page_number=number, location_label=f"Page {number}"))
    return blocks


def _split_pptx(markdown: str) -> list[Block]:
    parts = _SLIDE_MARKER.split(markdown)
    blocks = []
    # split() yields [preamble, num1, text1, num2, text2, ...]
    for i in range(1, len(parts) - 1, 2):
        text = _clean(parts[i + 1])
        if text:
            blocks.append(Block(text, location_label=f"Slide {int(parts[i])}"))
    return blocks


def _split_by_headings(markdown: str, heading_level: int, label_prefix: str) -> list[Block]:
    """Split on headings of exactly `heading_level` (sheets) or on any heading
    (documents), labelling each part with the most recent heading text."""
    matches = [m for m in _HEADING.finditer(markdown)
               if heading_level == 0 or len(m.group(1)) == heading_level]
    if not matches:
        text = _clean(markdown)
        return [Block(text)] if text else []

    blocks = []
    preamble = _clean(markdown[: matches[0].start()])
    if preamble:
        blocks.append(Block(preamble))
    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        body = _clean(markdown[match.start():end])
        # A heading with no body of its own adds nothing searchable.
        if len(body) > len(match.group(0).strip()):
            blocks.append(Block(body, location_label=f"{label_prefix}: {match.group(2)}"))
    return blocks


def _blocks_from_markdown(markdown: str, extension: str) -> list[Block]:
    if extension == ".pdf":
        return _split_pdf(markdown)
    if extension == ".pptx":
        return _split_pptx(markdown)
    if extension in (".xlsx", ".xls"):
        return _split_by_headings(markdown, heading_level=2, label_prefix="Sheet")
    if extension in (".docx", ".html", ".htm", ".md"):
        return _split_by_headings(markdown, heading_level=0, label_prefix="Section")
    text = _clean(markdown)
    return [Block(text)] if text else []


def extract_blocks(
    data: bytes,
    filename: str,
    *,
    extension: Optional[str] = None,
    mimetype: Optional[str] = None,
    url: Optional[str] = None,
) -> list[Block]:
    """Convert raw bytes to Blocks. Raises ExtractionError if nothing usable
    comes out (corrupt file, unsupported type, or e.g. a scanned PDF)."""
    ext = (extension or _extension_of(filename)).lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise ExtractionError(
            f"Unsupported file type '{ext or 'unknown'}'. "
            f"Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}."
        )

    # MarkItDown silently falls back to plain-text decoding when a binary
    # converter fails, which would index the raw file bytes as "content". Reject
    # files that aren't the format their extension claims, and outputs that are
    # just the unconverted file.
    signature = _BINARY_SIGNATURES.get(ext)
    if signature and not _has_signature(data, ext, signature):
        raise ExtractionError(f"This doesn't look like a valid {ext} file.")

    unreadable = _unreadable_message(data, ext)
    try:
        result = _markitdown.convert_stream(
            io.BytesIO(data),
            stream_info=StreamInfo(extension=ext, mimetype=mimetype, url=url, filename=filename),
        )
        if signature and result.markdown.lstrip().startswith(_UNCONVERTED_PREFIXES):
            raise ExtractionError(unreadable)
        blocks = _blocks_from_markdown(result.markdown, ext)
    except ExtractionError:
        raise
    except Exception as exc:
        # Keep the real cause in server logs only; callers see a safe message.
        print(f"[Extractor] {ext} conversion failed for {filename!r}: {exc!r}")
        raise ExtractionError(unreadable)

    if not blocks:
        if ext == ".pdf" and _pdf_is_encrypted(data):
            raise ExtractionError(unreadable)
        hint = " It may be a scanned document (no text layer); OCR is not supported yet." if ext == ".pdf" else ""
        raise ExtractionError(f"No readable text was found in this file.{hint}")
    return blocks


def _pdf_is_encrypted(data: bytes) -> bool:
    # /Encrypt lives in the (uncompressed) trailer or xref-stream dictionary.
    # Only consulted after extraction has already failed, so a stray match
    # can't turn a readable PDF into an error.
    return b"/Encrypt" in data


def _unreadable_message(data: bytes, ext: str) -> str:
    if ext == ".pdf" and _pdf_is_encrypted(data):
        return "This PDF is password-protected. Remove the password and upload it again."
    return f"Could not read this {ext} file. It may be corrupt or password-protected."


def _has_signature(data: bytes, ext: str, signature: bytes) -> bool:
    # PDF readers tolerate junk before the header, so accept it anywhere in the
    # first KB; the other formats must start with their magic bytes.
    return signature in data[:1024] if ext == ".pdf" else data.startswith(signature)


def _extension_of(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:] if dot != -1 else ""


# ── URL fetching with SSRF protection ─────────────────────────────────────────

def _is_public_host(hostname: str) -> bool:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def fetch_url_bytes(
    url: str,
    *,
    host_check: Callable[[str], bool] = _is_public_host,
    transport: Optional[httpx.BaseTransport] = None,
) -> tuple[bytes, str, str]:
    """Download a web page/document. Every hop of a redirect chain is checked
    against the public-host rule, not just the first URL. Returns
    (body, content_type, final_url)."""
    current = url
    headers = {"User-Agent": "CollabMindBot/1.0 (+source ingestion)"}

    with httpx.Client(follow_redirects=False, timeout=URL_TIMEOUT_SECONDS,
                      headers=headers, transport=transport) as client:
        for _ in range(MAX_REDIRECTS + 1):
            parsed = urlparse(current)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ExtractionError("Only http(s) links are supported.")
            if not host_check(parsed.hostname):
                raise ExtractionError("This link points to a private or unreachable address and was blocked.")

            try:
                with client.stream("GET", current) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise ExtractionError("The link redirected without a destination.")
                        current = urljoin(current, location)
                        continue
                    response.raise_for_status()
                    body = b""
                    for part in response.iter_bytes():
                        body += part
                        if len(body) > MAX_URL_BYTES:
                            raise ExtractionError("That page is too large to import (limit 10 MB).")
                    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                    return body, content_type, current
            except ExtractionError:
                raise
            except httpx.HTTPStatusError as exc:
                raise ExtractionError(f"The link returned an error ({exc.response.status_code}).")
            except httpx.HTTPError as exc:
                print(f"[Extractor] fetch failed for {current}: {exc!r}")
                raise ExtractionError("The link could not be reached.")

    raise ExtractionError("The link redirected too many times.")


_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}


def extract_url(url: str, **fetch_kwargs) -> list[Block]:
    if (urlparse(url).hostname or "").lower() in _YOUTUBE_HOSTS:
        # Fetching the watch page would index page chrome, not the transcript.
        raise ExtractionError("YouTube links aren't supported yet. Paste a web page or document link instead.")

    body, content_type, final_url = fetch_url_bytes(url, **fetch_kwargs)
    extension = _EXTENSION_BY_CONTENT_TYPE.get(content_type)
    if extension is None:
        extension = _extension_of(urlparse(final_url).path).lower() or ".html"
    if extension not in SUPPORTED_EXTENSIONS:
        extension = ".html"
    return extract_blocks(body, urlparse(final_url).path or "page", extension=extension,
                          mimetype=content_type or None, url=final_url)
