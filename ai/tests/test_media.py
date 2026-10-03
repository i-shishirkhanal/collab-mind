"""YouTube transcript grouping / id parsing and image handling (no network, no OCR binary needed)."""

import pytest

from rag import media
from rag.extractor import ExtractionError, extract_blocks, extract_url


@pytest.mark.parametrize("url,expected", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://youtu.be/dQw4w9WgXcQ?t=10", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://www.youtube.com/watch?v=short", None),
    ("https://www.youtube.com/", None),
    ("https://evil.example/watch?v=dQw4w9WgXcQ", None),
])
def test_video_id_parsing(url, expected):
    assert media.youtube_video_id(url) == expected


def test_segments_group_into_labelled_minutes():
    segs = [{"text": f"line {i}", "start": i * 10.0, "duration": 10.0} for i in range(13)]
    blocks = media.segments_to_blocks(segs)
    assert [b.location_label for b in blocks] == ["0:00–1:00", "1:00–2:00", "2:00–2:10"]
    assert blocks[0].text.startswith("line 0 line 1")
    assert blocks[2].text == "line 12"


def test_segments_unescape_html_and_skip_blank_lines():
    blocks = media.segments_to_blocks([
        {"text": "Tom &amp; Jerry", "start": 0, "duration": 2},
        {"text": "   ", "start": 2, "duration": 1},
    ])
    assert len(blocks) == 1 and blocks[0].text == "Tom & Jerry"


def test_hour_long_timestamps_include_hours():
    blocks = media.segments_to_blocks([{"text": "late", "start": 3725, "duration": 5}])
    assert blocks[0].location_label == "1:02:05–1:02:10"


def test_extract_url_routes_youtube_to_the_transcript_reader(monkeypatch):
    monkeypatch.setattr(media, "extract_youtube", lambda url: [media.Block("spoken words", location_label="0:00–0:05")])
    blocks = extract_url("https://youtu.be/dQw4w9WgXcQ", host_check=lambda h: True)
    assert blocks[0].text == "spoken words"


def test_transcript_errors_become_friendly_messages(monkeypatch):
    class TranscriptsDisabled(Exception):
        pass

    def boom(_video_id):
        raise TranscriptsDisabled()

    monkeypatch.setattr(media, "_fetch_segments", boom)
    with pytest.raises(ExtractionError, match="captions turned off"):
        media.extract_youtube("https://youtu.be/dQw4w9WgXcQ")


def test_image_with_wrong_signature_is_rejected():
    with pytest.raises(ExtractionError, match="valid .png"):
        extract_blocks(b"not really a png", "scan.png")


def test_images_are_a_supported_extension():
    from rag.extractor import SUPPORTED_EXTENSIONS
    assert {".png", ".jpg", ".jpeg", ".webp"} <= SUPPORTED_EXTENSIONS
