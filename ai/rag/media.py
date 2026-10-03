"""
rag/media.py — Sources that are not documents: images (OCR) and YouTube videos (transcripts).

Both produce the same location-aware Blocks as every other source, so chunking, embedding,
retrieval and citations need no special cases. Images cite as "Image"; videos cite a time range
("12:30–13:28") so a citation points at the moment in the video.

Neither path fetches arbitrary URLs: the YouTube host is fixed and the video id is validated
against a strict pattern before anything is requested.
"""

from __future__ import annotations

import html
import io
import re
from typing import Optional
from urllib.parse import parse_qs, urlparse

from rag.extractor import Block, ExtractionError

# ── Images ────────────────────────────────────────────────────────────────────

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
MAX_IMAGE_PIXELS = 40_000_000  # decompression-bomb guard
OCR_TIMEOUT_SECONDS = 60

_IMAGE_SIGNATURES = {
    ".png": (b"\x89PNG\r\n\x1a\n",),
    ".jpg": (b"\xff\xd8\xff",),
    ".jpeg": (b"\xff\xd8\xff",),
    ".bmp": (b"BM",),
    ".tif": (b"II*\x00", b"MM\x00*"),
    ".tiff": (b"II*\x00", b"MM\x00*"),
}


def _looks_like_image(data: bytes, ext: str) -> bool:
    if ext == ".webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return any(data.startswith(sig) for sig in _IMAGE_SIGNATURES.get(ext, ()))


def extract_image(data: bytes, filename: str, ext: str) -> list[Block]:
    """OCR an image into one block. Handwriting, photos without text and very low-resolution scans
    produce little or nothing; that is reported plainly instead of indexing noise."""
    if not _looks_like_image(data, ext):
        raise ExtractionError(f"This doesn't look like a valid {ext} image.")
    try:
        from PIL import Image, ImageOps
        import pytesseract
    except ImportError:
        raise ExtractionError("Image text recognition is not available on this server.")

    try:
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        with Image.open(io.BytesIO(data)) as img:
            img = ImageOps.exif_transpose(img).convert("L")  # upright, greyscale helps OCR
            text = pytesseract.image_to_string(img, timeout=OCR_TIMEOUT_SECONDS)
    except pytesseract.TesseractNotFoundError:
        raise ExtractionError("Image text recognition is not available on this server.")
    except (Image.DecompressionBombError, Image.UnidentifiedImageError, OSError):
        raise ExtractionError("This image could not be read, or it is too large.")
    except RuntimeError:  # pytesseract raises RuntimeError on timeout
        raise ExtractionError("Reading this image took too long and was stopped.")

    text = re.sub(r"\n{3,}", "\n\n", text.replace("\x00", "")).strip()
    if len(text) < 10:
        raise ExtractionError("No readable text was found in this image.")
    return [Block(text, location_label="Image")]


# ── YouTube ───────────────────────────────────────────────────────────────────

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
SEGMENT_SECONDS = 60
PREFERRED_LANGUAGES = ["en", "en-US", "en-GB"]


def youtube_video_id(url: str) -> Optional[str]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host not in YOUTUBE_HOSTS:
        return None
    candidate: Optional[str] = None
    if host == "youtu.be":
        candidate = parsed.path.lstrip("/").split("/")[0]
    else:
        parts = [p for p in parsed.path.split("/") if p]
        if parts[:1] == ["watch"]:
            candidate = (parse_qs(parsed.query).get("v") or [None])[0]
        elif parts[:1] and parts[0] in ("shorts", "embed", "live", "v") and len(parts) > 1:
            candidate = parts[1]
    return candidate if candidate and _VIDEO_ID.match(candidate) else None


def _clock(seconds: float) -> str:
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def segments_to_blocks(segments: list[dict]) -> list[Block]:
    """Group caption lines (dicts with text/start/duration) into ~one-minute blocks labelled with
    the time range they cover."""
    blocks: list[Block] = []
    buf: list[str] = []
    start = end = 0.0

    def flush() -> None:
        text = re.sub(r"\s+", " ", " ".join(buf)).strip()
        if text:
            blocks.append(Block(text, location_label=f"{_clock(start)}–{_clock(end)}"))

    for seg in segments:
        text = html.unescape(str(seg.get("text", ""))).replace("\n", " ").strip()
        if not text:
            continue
        seg_start = float(seg.get("start", 0.0))
        seg_end = seg_start + float(seg.get("duration", 0.0))
        if buf and seg_start - start >= SEGMENT_SECONDS:
            flush()
            buf = []
        if not buf:
            start = seg_start
        buf.append(text)
        end = max(end if buf[:-1] else seg_end, seg_end)
    flush()
    return blocks


_FRIENDLY_ERRORS = {
    "TranscriptsDisabled": "This video has captions turned off, so there is no transcript to read.",
    "NoTranscriptFound": "No transcript was found for this video.",
    "VideoUnavailable": "This video is unavailable.",
    "VideoUnplayable": "This video can't be played, so its transcript can't be read.",
    "AgeRestricted": "This video is age-restricted, so its transcript can't be read.",
    "IpBlocked": "YouTube is blocking transcript requests from this server right now. Try again later.",
    "RequestBlocked": "YouTube is blocking transcript requests from this server right now. Try again later.",
}


def _fetch_segments(video_id: str) -> list[dict]:
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    try:
        fetched = api.fetch(video_id, languages=PREFERRED_LANGUAGES)
    except Exception as exc:  # noqa: BLE001
        if type(exc).__name__ != "NoTranscriptFound":
            raise
        # No English captions: take whichever transcript the video has.
        transcripts = list(api.list(video_id))
        if not transcripts:
            raise
        fetched = transcripts[0].fetch()
    return [{"text": s.text, "start": s.start, "duration": s.duration} for s in fetched]


def extract_youtube(url: str) -> list[Block]:
    video_id = youtube_video_id(url)
    if not video_id:
        raise ExtractionError("That doesn't look like a link to a YouTube video.")
    try:
        segments = _fetch_segments(video_id)
    except ImportError:
        raise ExtractionError("YouTube import is not available on this server.")
    except Exception as exc:  # noqa: BLE001
        print(f"[Extractor] youtube transcript failed for {video_id}: {exc!r}")
        raise ExtractionError(_FRIENDLY_ERRORS.get(
            type(exc).__name__, "The transcript for this video could not be retrieved."))
    blocks = segments_to_blocks(segments)
    if not blocks:
        raise ExtractionError("This video's transcript is empty.")
    return blocks
