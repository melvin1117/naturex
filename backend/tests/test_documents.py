"""Hostile-file inspection for verification documents (T69, ADR-0006 §2 and §5).

Wrong magic, mismatched and oversized files, a decompression-bomb PNG, corrupt images,
encrypted, malformed and over-limit PDFs, active content (in compressed object streams too),
polyglots, sanitised previews, and the worker process with its timeout. The file builders here
are shared with `test_verification.py`.
"""

from __future__ import annotations

import io
import json
import os
import secrets
import struct
import zlib
from collections.abc import Callable
from typing import Any

import pytest
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    NameObject,
    TextStringObject,
)

from app.tools import documents as docs

# ----- files ------------------------------------------------------------------------------------


def png(width: int = 640, height: int = 480, **save: Any) -> bytes:
    """A solid image in a random colour, so two calls never make the same file."""
    colour = tuple(secrets.token_bytes(3))
    out = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(out, "PNG", **save)
    return out.getvalue()


def jpeg(width: int = 640, height: int = 480) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 180, 40)).save(out, "JPEG", quality=80)
    return out.getvalue()


def _written(writer: PdfWriter) -> bytes:
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def pdf(pages: int = 1) -> bytes:
    """Blank pages with a random title, so two calls never make the same file."""
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(612, 792)
    writer.add_metadata({"/Title": secrets.token_hex(8)})
    return _written(writer)


def scanned_pdf() -> bytes:
    """A one-page PDF whose page is an image, like a scanned title."""
    out = io.BytesIO()
    Image.new("RGB", (900, 1200), (240, 240, 230)).save(out, "PDF")
    return out.getvalue()


def encrypted_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(612, 792)
    writer.encrypt("secret")
    return _written(writer)


def javascript_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(612, 792)
    action = DictionaryObject(
        {
            NameObject("/S"): NameObject("/JavaScript"),
            NameObject("/JS"): TextStringObject("app.alert('hi')"),
        }
    )
    writer._root_object[NameObject("/OpenAction")] = writer._add_object(action)
    return _written(writer)


def embedded_file_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(612, 792)
    writer.add_attachment("payload.exe", b"MZ not really")
    return _written(writer)


def launch_annotation_pdf() -> bytes:
    """A link annotation whose action launches a program, nested in the page's /Annots."""
    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    link = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Link"),
            NameObject("/Rect"): ArrayObject([]),
            NameObject("/A"): DictionaryObject(
                {
                    NameObject("/S"): NameObject("/Launch"),
                    NameObject("/F"): TextStringObject("calc.exe"),
                }
            ),
        }
    )
    page[NameObject("/Annots")] = ArrayObject([link])
    return _written(writer)


def png_with_chunk(kind: bytes, payload: bytes) -> bytes:
    """A valid PNG with an extra ancillary chunk (valid CRC) right after IHDR."""
    data = png()
    chunk = struct.pack(">I", len(payload)) + kind + payload
    chunk += struct.pack(">I", zlib.crc32(kind + payload))
    ihdr_end = len(docs._PNG_MAGIC) + 8 + 13 + 4
    return data[:ihdr_end] + chunk + data[ihdr_end:]


def jpeg_with_comment(comment: bytes) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (64, 64), (1, 2, 3)).save(out, "JPEG", comment=comment)
    return out.getvalue()


def remote_goto_pdf() -> bytes:
    """A link that opens another PDF file (`/GoToR`)."""
    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    link = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Link"),
            NameObject("/Rect"): ArrayObject([]),
            NameObject("/A"): DictionaryObject(
                {
                    NameObject("/S"): NameObject("/GoToR"),
                    NameObject("/F"): TextStringObject("\\\\attacker\\share\\x.pdf"),
                }
            ),
        }
    )
    page[NameObject("/Annots")] = ArrayObject([link])
    return _written(writer)


def image_flate_bomb_pdf(declared: tuple[int, int], inflated: int) -> bytes:
    """A page drawing one grey image XObject whose Flate stream inflates to `inflated` bytes."""
    width, height = declared
    packed = zlib.compress(b"\x00" * inflated, 9)
    image = (
        f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
        f"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode "
        f"/Length {len(packed)} >>\nstream\n".encode()
        + packed
        + b"\nendstream"
    )
    content = b"q 612 0 0 792 0 0 cm /Im0 Do Q"
    return raw_pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
            image,
            f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream",
        ]
    )


def object_stream_flate_bomb_pdf(inflated: int) -> bytes:
    """PDF 1.5 whose only object stream inflates to `inflated` bytes of whitespace."""
    plain = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    }
    header = b"4 0 "
    packed = zlib.compress(header + b"<< /Bomb true >>" + b" " * inflated, 9)
    out = bytearray(b"%PDF-1.5\n")
    offsets: dict[int, int] = {}
    for number, content in plain.items():
        offsets[number] = len(out)
        out += f"{number} 0 obj\n".encode() + content + b"\nendobj\n"
    offsets[5] = len(out)
    out += (
        f"5 0 obj\n<< /Type /ObjStm /N 1 /First {len(header)} /Filter /FlateDecode "
        f"/Length {len(packed)} >>\nstream\n".encode()
        + packed
        + b"\nendstream\nendobj\n"
    )
    offsets[6] = len(out)
    rows = [struct.pack(">BIH", 0, 0, 65535)]
    rows += [struct.pack(">BIH", 1, offsets[n], 0) for n in (1, 2, 3)]
    rows += [struct.pack(">BIH", 2, 5, 0)]
    rows += [struct.pack(">BIH", 1, offsets[n], 0) for n in (5, 6)]
    table = b"".join(rows)
    out += (
        f"6 0 obj\n<< /Type /XRef /Size 7 /W [1 4 2] /Root 1 0 R /Length {len(table)} >>"
        "\nstream\n".encode()
        + table
        + b"\nendstream\nendobj\n"
    )
    out += f"startxref\n{offsets[6]}\n%%EOF\n".encode()
    return bytes(out)


def raw_pdf(objects: list[bytes]) -> bytes:
    """A minimal, valid PDF from object bodies (object 1 must be the catalog)."""
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, content in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + content + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n".encode()
    out += f"startxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def object_stream_javascript_pdf() -> bytes:
    """PDF 1.5: the JavaScript action lives in a Flate-compressed object stream, indexed by a
    cross-reference stream, so a scan of the raw bytes can't see it."""
    plain = {
        1: b"<< /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    }
    hidden = b"<< /S /JavaScript /JS (app.alert(1)) >>"
    header = b"4 0 "
    packed = zlib.compress(header + hidden)
    out = bytearray(b"%PDF-1.5\n")
    offsets: dict[int, int] = {}
    for number, content in plain.items():
        offsets[number] = len(out)
        out += f"{number} 0 obj\n".encode() + content + b"\nendobj\n"
    offsets[5] = len(out)
    out += (
        f"5 0 obj\n<< /Type /ObjStm /N 1 /First {len(header)} /Filter /FlateDecode "
        f"/Length {len(packed)} >>\nstream\n".encode()
        + packed
        + b"\nendstream\nendobj\n"
    )
    offsets[6] = len(out)
    rows = [struct.pack(">BIH", 0, 0, 65535)]
    rows += [struct.pack(">BIH", 1, offsets[n], 0) for n in (1, 2, 3)]
    rows += [struct.pack(">BIH", 2, 5, 0)]  # object 4: in object stream 5, index 0
    rows += [struct.pack(">BIH", 1, offsets[n], 0) for n in (5, 6)]
    table = b"".join(rows)
    out += (
        f"6 0 obj\n<< /Type /XRef /Size 7 /W [1 4 2] /Root 1 0 R /Length {len(table)} >>"
        "\nstream\n".encode()
        + table
        + b"\nendstream\nendobj\n"
    )
    out += f"startxref\n{offsets[6]}\n%%EOF\n".encode()
    assert b"JavaScript" not in out
    return bytes(out)


def many_objects_pdf(extra: int) -> bytes:
    base = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    ]
    return raw_pdf(base + [b"null"] * extra)


def bomb_png(side: int = 10_000) -> bytes:
    """A 1-bit PNG of `side` × `side` pixels (100 M for the default): a few KB on disk."""
    row = b"\x00" + b"\x00" * ((side + 7) // 8)
    idat = zlib.compress(row * side, 9)

    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data)
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", side, side, 1, 0, 0, 0, 0)
    return docs._PNG_MAGIC + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


# ----- hostile files (pure) ---------------------------------------------------------------------


def _rejected(data: bytes, declared: str) -> str:
    with pytest.raises(docs.DocumentRejected) as caught:
        docs.inspect_document(data, declared)
    return caught.value.code


def test_accepted_files_are_measured_and_previewed() -> None:
    image = docs.inspect_document(png(800, 600), "image/png")
    photo = docs.inspect_document(jpeg(), "image/jpeg")
    scan = docs.inspect_document(scanned_pdf(), "application/pdf")
    text_only = docs.inspect_document(pdf(3), "application/pdf; charset=binary")

    assert (image.width, image.height, image.page_count) == (800, 600, None)
    assert (photo.media_type, photo.width) == ("image/jpeg", 640)
    assert (scan.page_count, text_only.page_count) == (1, 3)
    assert text_only.preview_png is None, "PDFs aren't rasterised; only a scanned image is"
    for found in (image, photo, scan):
        assert found.preview_png is not None
        with Image.open(io.BytesIO(found.preview_png)) as preview:
            assert preview.format == "PNG"
            assert max(preview.size) <= docs.PREVIEW_MAX_SIDE


def test_a_preview_is_re_encoded_without_metadata() -> None:
    from PIL import PngImagePlugin

    info = PngImagePlugin.PngInfo()
    info.add_text("Author", "Ada Lovelace, parcel 42")
    big = png(3_000, 2_000, pnginfo=info)

    preview = docs.inspect_document(big, "image/png").preview_png

    assert preview is not None and b"Ada Lovelace" not in preview
    with Image.open(io.BytesIO(preview)) as image:
        assert image.size == (1_600, 1_067) and "Author" not in image.info


@pytest.mark.parametrize(
    ("data", "declared", "code"),
    [
        (b"", "application/pdf", docs.EMPTY_FILE),
        (b"<html><script>alert(1)</script></html>", "application/pdf", docs.UNSUPPORTED_FORMAT),
        (b"PK\x03\x04 a zip file", "image/png", docs.UNSUPPORTED_FORMAT),
        (b"GIF89a....", "image/png", docs.UNSUPPORTED_FORMAT),
        (pdf(), "image/png", docs.MEDIA_TYPE_MISMATCH),
        (png(), "image/jpeg", docs.MEDIA_TYPE_MISMATCH),
        (b"%PDF-" + b"0" * docs.MAX_DOCUMENT_BYTES, "application/pdf", docs.FILE_TOO_LARGE),
    ],
    ids=["empty", "html", "zip", "gif", "pdf-as-png", "png-as-jpeg", "oversized"],
)
def test_wrong_magic_mismatches_and_oversized_files_are_refused(
    data: bytes, declared: str, code: str
) -> None:
    assert _rejected(data, declared) == code


def test_a_decompression_bomb_png_is_refused_before_decoding() -> None:
    bomb = bomb_png()
    assert len(bomb) < 50_000, "small on disk"

    assert _rejected(bomb, "image/png") == docs.IMAGE_TOO_LARGE
    assert docs.inspect_document(bomb_png(1), "image/png").width == 1, "the same PNG, 1 × 1"


def test_an_image_wider_than_the_side_limit_is_refused() -> None:
    assert _rejected(png(docs.MAX_IMAGE_SIDE + 1, 10), "image/png") == docs.IMAGE_TOO_LARGE


@pytest.mark.parametrize(
    ("data", "declared", "code"),
    [
        (png() + pdf(), "image/png", docs.TRAILING_DATA),
        (png() + b"PK\x05\x06" + b"\x00" * 18, "image/png", docs.TRAILING_DATA),
        (jpeg() + b"<html><script>alert(1)</script>", "image/jpeg", docs.TRAILING_DATA),
        (pdf() + b"PK\x03\x04" + b"\x00" * 26, "application/pdf", docs.TRAILING_DATA),
    ],
    ids=["png+pdf", "png+zip", "jpeg+html", "pdf+zip"],
)
def test_polyglots_are_refused(data: bytes, declared: str, code: str) -> None:
    assert _rejected(data, declared) == code


@pytest.mark.parametrize(
    ("data", "declared"),
    [
        (png_with_chunk(b"zzZz", b"%PDF-1.7 hidden document"), "image/png"),
        (png_with_chunk(b"tEXt", b"Comment\x00PK\x03\x04 zip entry"), "image/png"),
        (jpeg_with_comment(b"PK\x05\x06" + b"\x00" * 18), "image/jpeg"),
        (jpeg_with_comment(b"%PDF-1.4"), "image/jpeg"),
    ],
    ids=["pdf-in-png-chunk", "zip-in-png-text", "zip-end-in-jpeg-comment", "pdf-in-jpeg-comment"],
)
def test_images_with_embedded_zip_or_pdf_signatures_are_refused(data: bytes, declared: str) -> None:
    assert _rejected(data, declared) == docs.EMBEDDED_SIGNATURE


def test_corrupt_images_are_refused() -> None:
    good = png()
    bad_crc = bytearray(good)
    bad_crc[30] ^= 0xFF  # inside IHDR's data: its CRC no longer matches
    truncated_jpeg = jpeg()[:600] + b"\xff\xd9"

    assert _rejected(bytes(bad_crc), "image/png") == docs.IMAGE_MALFORMED
    assert _rejected(good[:-12], "image/png") == docs.IMAGE_MALFORMED  # no IEND
    assert _rejected(truncated_jpeg, "image/jpeg") == docs.IMAGE_MALFORMED


@pytest.mark.parametrize(
    ("make", "code"),
    [
        (encrypted_pdf, docs.PDF_ENCRYPTED),
        (javascript_pdf, docs.PDF_ACTIVE_CONTENT),
        (object_stream_javascript_pdf, docs.PDF_ACTIVE_CONTENT),
        (embedded_file_pdf, docs.PDF_ACTIVE_CONTENT),
        (launch_annotation_pdf, docs.PDF_ACTIVE_CONTENT),
        (remote_goto_pdf, docs.PDF_ACTIVE_CONTENT),
        (lambda: object_stream_flate_bomb_pdf(40 * 1024 * 1024), docs.PDF_MALFORMED),
        (lambda: pdf(docs.MAX_PDF_PAGES + 1), docs.PDF_TOO_MANY_PAGES),
        (lambda: many_objects_pdf(docs.MAX_PDF_OBJECTS), docs.PDF_TOO_MANY_OBJECTS),
        (lambda: b"%PDF-1.7\nthis is not a pdf at all\n%%EOF\n", docs.PDF_MALFORMED),
        (lambda: raw_pdf([b"<< /Type /Catalog /Pages 2 0 R >>"]), docs.PDF_MALFORMED),
    ],
    ids=[
        "encrypted",
        "javascript",
        "javascript-in-object-stream",
        "embedded-file",
        "launch-annotation",
        "remote-goto",
        "object-stream-flate-bomb",
        "too-many-pages",
        "too-many-objects",
        "garbage",
        "no-pages",
    ],
)
def test_hostile_pdfs_are_refused(make: Callable[[], bytes], code: str) -> None:
    assert _rejected(make(), "application/pdf") == code


def test_the_limits_themselves_are_accepted() -> None:
    assert docs.inspect_document(pdf(docs.MAX_PDF_PAGES), "application/pdf").page_count == 50
    small = many_objects_pdf(100)
    assert docs.inspect_document(small, "application/pdf").page_count == 1


def test_the_worker_inspects_in_another_process_and_returns_the_same_verdict() -> None:
    found = docs.inspect_in_worker(scanned_pdf(), "application/pdf")
    assert found.page_count == 1 and found.preview_png is not None
    with pytest.raises(docs.DocumentRejected) as caught:
        docs.inspect_in_worker(bomb_png(), "image/png")
    assert caught.value.code == docs.IMAGE_TOO_LARGE


def test_a_worker_that_runs_out_of_time_is_killed() -> None:
    with pytest.raises(docs.DocumentRejected) as caught:
        docs.inspect_in_worker(png(), "image/png", timeout_s=0.001)
    assert caught.value.code == docs.INSPECTION_TIMEOUT


def test_a_worker_verdict_is_parsed_strictly() -> None:
    for raw in (b"", b"not json", b'{"accepted": {"media_type": "text/html"}}', b"[]"):
        with pytest.raises(docs.DocumentRejected) as caught:
            docs._parse_verdict(raw)
        assert caught.value.code == docs.INSPECTION_FAILED


def test_a_pdf_image_flate_bomb_gets_no_preview_and_isnt_decoded() -> None:
    """A huge declared image is skipped unread; a small declared one that inflates past
    pypdf's lowered limit fails to decode. Either way the PDF is accepted without a preview."""
    huge = image_flate_bomb_pdf((50_000, 50_000), 1_000)
    lying = image_flate_bomb_pdf((1_000, 1_000), 64 * 1024 * 1024)
    assert len(lying) < 200_000

    for data in (huge, lying):
        found = docs.inspect_document(data, "application/pdf")
        assert (found.page_count, found.preview_png) == (1, None)


def test_a_small_scan_image_in_a_pdf_still_previews() -> None:
    found = docs.inspect_document(image_flate_bomb_pdf((300, 400), 300 * 400), "application/pdf")
    assert found.preview_png is not None


def test_the_worker_runs_isolated(monkeypatch: pytest.MonkeyPatch) -> None:
    """From `/`, with no environment (no secrets), no core dumps, no file writes and few files."""
    report = (
        "import sys, os, json, resource; sys.path.insert(0, sys.argv[1]); "
        "from app.tools.documents import _limit_resources; _limit_resources(5); "
        "limits = [resource.getrlimit(r)[0] for r in "
        "(resource.RLIMIT_CORE, resource.RLIMIT_FSIZE, resource.RLIMIT_NOFILE)]; "
        "print(json.dumps({'rejected': json.dumps([os.getcwd(), sorted(os.environ), limits, "
        "sys.flags.isolated])}))"
    )
    monkeypatch.setattr(docs, "_WORKER_CODE", report)
    monkeypatch.setenv("DOCUMENT_FINGERPRINT_SECRET", "must-not-leak")

    with pytest.raises(docs.DocumentRejected) as caught:
        docs.inspect_in_worker(png(), "image/png")

    cwd, environment, limits, isolated = json.loads(caught.value.code)
    assert cwd == os.sep
    assert not [name for name in environment if "SECRET" in name or "DATABASE" in name]
    assert limits == [0, 0, docs.WORKER_MAX_FILES]
    assert isolated == 1


def test_a_worker_that_says_too_much_is_cut_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(docs, "WORKER_MAX_OUTPUT_BYTES", 1_000)

    with pytest.raises(docs.DocumentRejected) as caught:
        docs.inspect_in_worker(png(800, 800), "image/png")  # its preview alone is bigger

    assert caught.value.code == docs.INSPECTION_FAILED


def test_slots_never_wait() -> None:
    held = [docs.try_acquire_slot() for _ in range(docs.MAX_CONCURRENT_INSPECTIONS)]
    try:
        assert all(held)
        with pytest.raises(docs.InspectionBusy):
            docs.inspect_in_worker(png(), "image/png")
    finally:
        for _ in held:
            docs.release_slot()
    assert docs.inspect_in_worker(png(), "image/png").media_type == "image/png"
