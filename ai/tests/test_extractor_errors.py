"""Clear, honest failures for files that can't be turned into text."""

import io

import pytest
from reportlab.pdfgen import canvas

from rag.extractor import ExtractionError, extract_blocks


def _encrypted_pdf() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, encrypt="secret-password")
    c.drawString(72, 720, "Confidential text")
    c.showPage()
    c.save()
    return buf.getvalue()


def test_password_protected_pdf_says_so():
    with pytest.raises(ExtractionError, match="password-protected"):
        extract_blocks(_encrypted_pdf(), "locked.pdf")


def test_corrupt_unencrypted_pdf_gets_the_generic_message():
    with pytest.raises(ExtractionError) as exc:
        extract_blocks(b"%PDF-1.4 garbage", "bad.pdf")
    assert "corrupt" in str(exc.value)
    assert "Remove the password" not in str(exc.value)


@pytest.mark.parametrize("data", [b"", b"   \n\t  ", b"\x00\x00\x00"])
def test_empty_or_blank_text_files_are_rejected(data):
    with pytest.raises(ExtractionError):
        extract_blocks(data, "blank.txt")


def test_utf8_text_with_bom_and_non_ascii_is_preserved():
    text = "Résumé: naïve café — 研究".encode("utf-8-sig")
    blocks = extract_blocks(text, "notes.txt")
    assert "Résumé" in blocks[0].text and "研究" in blocks[0].text
