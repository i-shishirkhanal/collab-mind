import httpx
import pytest

from rag.chunker import CHUNK_SIZE, chunk_blocks
from rag.extractor import (
    Block,
    ExtractionError,
    _is_public_host,
    extract_blocks,
    extract_url,
)


# ── PDF: real page numbers ────────────────────────────────────────────────────

def test_pdf_blocks_carry_real_one_based_page_numbers(pdf_bytes):
    data = pdf_bytes(["Photosynthesis converts light.", "Chlorophyll absorbs red light.", "The Calvin cycle fixes carbon."])
    blocks = extract_blocks(data, "paper.pdf")
    assert [b.page_number for b in blocks] == [1, 2, 3]
    assert [b.location_label for b in blocks] == ["Page 1", "Page 2", "Page 3"]
    assert "Chlorophyll" in blocks[1].text and "Chlorophyll" not in blocks[0].text


def test_blank_pdf_page_is_skipped_but_numbering_stays_correct(pdf_bytes):
    data = pdf_bytes(["First page text.", "", "Third page text."])
    blocks = extract_blocks(data, "paper.pdf")
    assert [b.page_number for b in blocks] == [1, 3]


def test_pdf_without_text_layer_is_rejected_with_a_helpful_message(pdf_bytes):
    with pytest.raises(ExtractionError, match="scanned"):
        extract_blocks(pdf_bytes(["", ""]), "scan.pdf")


@pytest.mark.parametrize("data", [
    b"%PDF-1.4 header present but the body is garbage",   # converter fails -> MarkItDown text fallback
    b"this is not a pdf at all",                           # wrong signature
])
def test_corrupt_pdf_raises_safe_error_instead_of_indexing_raw_bytes(data):
    with pytest.raises(ExtractionError) as exc:
        extract_blocks(data, "bad.pdf")
    message = str(exc.value)
    assert "Traceback" not in message and "pdfminer" not in message


@pytest.mark.parametrize("ext", [".docx", ".pptx", ".xlsx", ".xls"])
def test_binary_office_formats_reject_files_without_their_signature(ext):
    with pytest.raises(ExtractionError, match="valid"):
        extract_blocks(b"plain text pretending to be an office file", f"fake{ext}")


def test_zip_signature_with_corrupt_body_is_rejected_not_indexed():
    with pytest.raises(ExtractionError):
        extract_blocks(b"PK\x03\x04 not really a zip archive", "broken.docx")


# ── Other formats: location model ─────────────────────────────────────────────

def test_docx_sections_are_labelled_by_heading_and_tables_survive(docx_bytes):
    blocks = extract_blocks(docx_bytes, "notes.docx")
    labels = [b.location_label for b in blocks]
    assert "Section: Research Notes" in labels and "Section: Results" in labels
    assert all(b.page_number is None for b in blocks)  # DOCX has no fixed pages
    assert any("| Control | 4.2 |" in b.text for b in blocks)


def test_pptx_slides_are_labelled_with_slide_number_not_page(pptx_bytes):
    blocks = extract_blocks(pptx_bytes, "deck.pptx")
    assert [b.location_label for b in blocks] == ["Slide 1", "Slide 2"]
    assert all(b.page_number is None for b in blocks)
    assert "Light intensity" in blocks[1].text


def test_xlsx_sheets_are_labelled_by_sheet_name(xlsx_bytes):
    blocks = extract_blocks(xlsx_bytes, "data.xlsx")
    assert [b.location_label for b in blocks] == ["Sheet: Yield", "Sheet: Notes"]
    assert "Treated" in blocks[0].text


def test_plain_text_has_no_invented_location():
    blocks = extract_blocks(b"Just some notes.\nSecond line.", "notes.txt")
    assert len(blocks) == 1
    assert blocks[0].page_number is None and blocks[0].location_label is None


def test_csv_is_extracted():
    blocks = extract_blocks(b"a,b\n1,2\n", "t.csv")
    assert "| 1 | 2 |" in blocks[0].text


def test_unsupported_extension_is_rejected():
    with pytest.raises(ExtractionError, match="Unsupported"):
        extract_blocks(b"MZ...", "tool.exe")


def test_empty_file_is_rejected():
    with pytest.raises(ExtractionError, match="No readable text"):
        extract_blocks(b"   \n  ", "empty.txt")


# ── Chunking never crosses a page and never invents metadata ─────────────────

def test_chunks_never_span_pages_and_inherit_their_page():
    blocks = [Block("alpha " * 40, page_number=1, location_label="Page 1"),
              Block("beta " * 40, page_number=2, location_label="Page 2")]
    chunks = chunk_blocks(blocks)
    assert [c.page_number for c in chunks] == [1, 2]
    assert "beta" not in chunks[0].text and "alpha" not in chunks[1].text


def test_long_page_splits_into_multiple_chunks_with_the_same_page():
    # Distinct words, so identical chunk text can only mean a real duplicate.
    long_page = " ".join(f"term{i}" for i in range(CHUNK_SIZE * 2))
    chunks = chunk_blocks([Block(long_page, page_number=7, location_label="Page 7")])
    assert len(chunks) > 1
    assert {c.page_number for c in chunks} == {7}
    assert len({c.text for c in chunks}) == len(chunks)  # no duplicate chunks


def test_chunking_drops_empty_blocks_and_keeps_none_locations_as_none():
    chunks = chunk_blocks([Block("   "), Block("real text")])
    assert len(chunks) == 1
    assert chunks[0].page_number is None and chunks[0].location_label is None


# ── URL fetching: SSRF protection ─────────────────────────────────────────────

@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.10",
                                  "169.254.169.254", "0.0.0.0", "::1"])
def test_private_and_loopback_hosts_are_not_public(host):
    assert _is_public_host(host) is False


def _html_transport(handler):
    return httpx.MockTransport(handler)


def test_public_html_page_is_converted_to_sectioned_text():
    html = b"<html><body><h1>Chlorophyll</h1><p>A green pigment.</p><h2>Role</h2><p>Absorbs light.</p></body></html>"
    transport = _html_transport(lambda req: httpx.Response(200, content=html, headers={"content-type": "text/html; charset=utf-8"}))
    blocks = extract_url("https://example.org/page", host_check=lambda h: True, transport=transport)
    assert "Section: Role" in [b.location_label for b in blocks]
    assert any("Absorbs light" in b.text for b in blocks)


def test_redirect_to_private_host_is_blocked_on_every_hop():
    def handler(req: httpx.Request):
        if req.url.host == "public.example":
            return httpx.Response(302, headers={"location": "http://internal.corp/admin"})
        pytest.fail("the private redirect target must never be requested")

    with pytest.raises(ExtractionError, match="blocked"):
        extract_url("https://public.example/start",
                    host_check=lambda h: h == "public.example",
                    transport=_html_transport(handler))


@pytest.mark.parametrize("url", ["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc"])
def test_malformed_youtube_links_are_rejected_instead_of_indexing_page_html(url):
    with pytest.raises(ExtractionError, match="YouTube"):
        extract_url(url, host_check=lambda h: True)


def test_non_http_scheme_is_rejected():
    with pytest.raises(ExtractionError, match="http"):
        extract_url("file:///etc/passwd", host_check=lambda h: True)


def test_oversized_download_is_rejected():
    big = b"x" * (10 * 1024 * 1024 + 1)
    transport = _html_transport(lambda req: httpx.Response(200, content=big, headers={"content-type": "text/plain"}))
    with pytest.raises(ExtractionError, match="too large"):
        extract_url("https://example.org/big.txt", host_check=lambda h: True, transport=transport)


def test_redirect_loop_is_cut_off():
    transport = _html_transport(lambda req: httpx.Response(302, headers={"location": "https://example.org/again"}))
    with pytest.raises(ExtractionError, match="too many"):
        extract_url("https://example.org/start", host_check=lambda h: True, transport=transport)
