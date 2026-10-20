"""Hostile-file inspection for listing documents (ADR-0006 §2 and §5; T69).

Every upload is treated as hostile until this module accepts it:

- **Size and type:** at most `MAX_DOCUMENT_BYTES`; PDF, JPEG or PNG by magic bytes, and the
  declared `Content-Type` must match what the bytes are.
- **Images:** the PNG chunk structure is walked (CRCs checked, `IHDR` first, nothing after
  `IEND`); a JPEG must end at its end-of-image marker. Dimensions are read from the header and
  checked against `MAX_IMAGE_PIXELS` / `MAX_IMAGE_SIDE` *before* any pixel is decoded, so a
  small file that inflates to gigabytes (a decompression bomb) is refused unread. The image is
  then fully decoded, which rejects truncated or corrupt files.
- **PDFs:** parsed strictly, with pypdf's decompression and element limits lowered
  (`_PDF_LIMITS`) and its external `jbig2dec` call disabled; encrypted, malformed, or over
  `MAX_PDF_PAGES` pages or `MAX_PDF_OBJECTS` objects is refused, and so is active content
  (JavaScript; launch, remote go-to, import, submit and rich-media actions; embedded files; XFA
  forms), found by walking every object, those inside compressed object streams included.
  Nothing may follow the final `%%EOF`.
- **Appended or embedded payloads** (what is checked of polyglots): nothing may follow an
  image's or a PDF's end marker, and an image may not contain a ZIP (`PK\x03\x04`,
  `PK\x05\x06`) or PDF (`%PDF`) signature anywhere (`embedded_signature`). Compressed image
  data can contain those 4 bytes by chance, about once per 300 MB of images, so a rare genuine
  scan is refused and must be re-saved. A PDF that is also valid as another format is not
  detected; downloads are always attachments and never rendered by the API's origin.
- **Previews are sanitised:** a re-encoded PNG at most `PREVIEW_MAX_SIDE` pixels on its longest
  side, with no metadata. For a PDF it's the largest image drawn directly on page 1 (a scanned
  title), its declared size checked before it's decoded; PDFs aren't rasterised (no
  permissively licensed pure-Python rasteriser exists).

`inspect_in_worker` runs `inspect_document` in a fresh worker process (see "the worker" below).
The worker **contains denial of service**: a pathological file or a parser bug can't hang,
exhaust or crash the API process. It is **not a code-execution sandbox**: a memory-corruption
bug in Pillow's or zlib's C code exploited by a crafted file would run as the API's OS user,
without its environment (no secrets) but with its file access. A real sandbox (seccomp, a
container without network or filesystem) belongs to the deployment (T20).
"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import subprocess
import sys
import threading
import warnings
import zlib
from collections.abc import Iterator
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import IO, Any

MEDIA_PDF = "application/pdf"
MEDIA_JPEG = "image/jpeg"
MEDIA_PNG = "image/png"
ACCEPTED_MEDIA_TYPES = (MEDIA_PDF, MEDIA_JPEG, MEDIA_PNG)

MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
"""Decoded pixels per image (about 8000 × 5000): a 600-dpi scan of a legal page fits."""
MAX_IMAGE_SIDE = 12_000
MAX_PDF_PAGES = 50
MAX_PDF_OBJECTS = 10_000
MAX_PDF_NESTING = 64
PREVIEW_MAX_SIDE = 1_600
PREVIEW_MAX_PDF_IMAGES = 8
INSPECT_TIMEOUT_S = 15.0
WORKER_MEMORY_BYTES = 1024 * 1024 * 1024
WORKER_MAX_FILES = 64
WORKER_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
"""The verdict, a base64 preview included, read from the worker; more is a failure."""
MAX_CONCURRENT_INSPECTIONS = 2
"""Per API process: each worker uses up to WORKER_MEMORY_BYTES and a CPU for INSPECT_TIMEOUT_S."""
_PDF_STREAM_LIMIT = 32 * 1024 * 1024
_PDF_LIMITS: dict[str, Any] = {
    "maximum_declared_stream_length": _PDF_STREAM_LIMIT,
    "array_based_stream_maximum_output_length": _PDF_STREAM_LIMIT,
    "array_maximum_element_count": 20_000,
    "dictionary_maximum_element_count": 20_000,
    "jbig2_maximum_output_length": _PDF_STREAM_LIMIT,
    "lzw_maximum_output_length": _PDF_STREAM_LIMIT,
    "run_length_maximum_output_length": _PDF_STREAM_LIMIT,
    "zlib_maximum_output_length": _PDF_STREAM_LIMIT,
    "zlib_maximum_recovery_input_length": 1_000_000,
    "brotli_maximum_output_length": _PDF_STREAM_LIMIT,
    "image_maximum_buffer_size": 3 * MAX_IMAGE_PIXELS,
    "stream_decoding_work_maximum_length": 100_000_000,
    "outline_maximum_entries": 10_000,
    "page_tree_maximum_entries": 10_000,
    "page_tree_maximum_depth": 32,
    "form_fields_maximum_entries": 10_000,
    "jbig2dec_binary": None,  # never call an external decoder
    "disable_legacy_handling": True,
}
"""pypdf's `Configuration`, tighter than its defaults: a 5 MB file has no business inflating a
stream past 32 MB."""

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC = b"\xff\xd8\xff"
_PDF_MAGIC = b"%PDF-"

# Rejection codes (HTTP 422 `detail` for the upload, except the worker's own failures).
EMPTY_FILE = "empty_file"
FILE_TOO_LARGE = "file_too_large"
UNSUPPORTED_FORMAT = "unsupported_format"
MEDIA_TYPE_MISMATCH = "media_type_mismatch"
IMAGE_TOO_LARGE = "image_too_large"
IMAGE_MALFORMED = "image_malformed"
TRAILING_DATA = "trailing_data"
PDF_ENCRYPTED = "pdf_encrypted"
PDF_MALFORMED = "pdf_malformed"
PDF_TOO_MANY_PAGES = "pdf_too_many_pages"
PDF_TOO_MANY_OBJECTS = "pdf_too_many_objects"
PDF_ACTIVE_CONTENT = "pdf_active_content"
EMBEDDED_SIGNATURE = "embedded_signature"
INSPECTION_TIMEOUT = "inspection_timeout"
INSPECTION_FAILED = "inspection_failed"

# Keys and action types that make a PDF do something when opened or clicked. Plain links
# (`/URI`) are allowed: following one is the reader's choice, and title records often cite a
# registry's web page.
_HAZARD_KEYS = frozenset(
    {"/JS", "/JavaScript", "/Launch", "/EmbeddedFile", "/EmbeddedFiles", "/RichMedia", "/XFA"}
)
_HAZARD_ACTIONS = frozenset(
    {
        "/JavaScript",
        "/Launch",
        "/GoToR",
        "/GoToE",
        "/ImportData",
        "/SubmitForm",
        "/RichMediaExecute",
    }
)
# Another format's signature inside an image: a ZIP (local header, end of central directory)
# or a PDF hidden in an image file.
_EMBEDDED_SIGNATURES = (b"PK\x03\x04", b"PK\x05\x06", b"%PDF")


class DocumentRejected(ValueError):
    """The file is refused; `code` is one of the module's rejection codes."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class InspectionBusy(RuntimeError):
    """Every inspection worker slot stayed busy; the caller should retry later (HTTP 503)."""


@dataclass(frozen=True, slots=True)
class Inspection:
    """An accepted file: what it is, how big it decodes, and its sanitised preview."""

    media_type: str
    page_count: int | None = None
    width: int | None = None
    height: int | None = None
    preview_png: bytes | None = None


def sniff(data: bytes) -> str | None:
    """The media type the bytes start with, or None for anything not accepted."""
    if data.startswith(_PDF_MAGIC):
        return MEDIA_PDF
    if data.startswith(_PNG_MAGIC):
        return MEDIA_PNG
    if data.startswith(_JPEG_MAGIC):
        return MEDIA_JPEG
    return None


def inspect_document(data: bytes, declared: str) -> Inspection:
    """Accept or refuse `data` uploaded as `declared` (raises DocumentRejected). Pure and
    in-process: call it through `inspect_in_worker` for untrusted input."""
    if not data:
        raise DocumentRejected(EMPTY_FILE)
    if len(data) > MAX_DOCUMENT_BYTES:
        raise DocumentRejected(FILE_TOO_LARGE)
    media_type = sniff(data)
    if media_type is None:
        raise DocumentRejected(UNSUPPORTED_FORMAT)
    if declared.split(";", 1)[0].strip().lower() != media_type:
        raise DocumentRejected(MEDIA_TYPE_MISMATCH)
    if media_type == MEDIA_PDF:
        return _inspect_pdf(data)
    if media_type == MEDIA_PNG:
        _png_structure(data)
    else:
        _jpeg_structure(data)
    if any(signature in data for signature in _EMBEDDED_SIGNATURES):
        raise DocumentRejected(EMBEDDED_SIGNATURE)
    width, height, preview = _decode_image(data, media_type)
    return Inspection(media_type, width=width, height=height, preview_png=preview)


# ----- images -----------------------------------------------------------------------------------


def _check_dimensions(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise DocumentRejected(IMAGE_MALFORMED)
    if width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE or width * height > MAX_IMAGE_PIXELS:
        raise DocumentRejected(IMAGE_TOO_LARGE)


def _png_structure(data: bytes) -> None:
    """Walk the chunks: `IHDR` first with sane dimensions, valid CRCs, and the file ends
    exactly at `IEND`."""
    pos = len(_PNG_MAGIC)
    first = True
    while pos + 12 <= len(data):
        length = int.from_bytes(data[pos : pos + 4], "big")
        kind = data[pos + 4 : pos + 8]
        end = pos + 12 + length
        if length > 0x7FFFFFFF or end > len(data):
            raise DocumentRejected(IMAGE_MALFORMED)
        crc = int.from_bytes(data[end - 4 : end], "big")
        if zlib.crc32(data[pos + 4 : end - 4]) != crc:
            raise DocumentRejected(IMAGE_MALFORMED)
        if first:
            if kind != b"IHDR" or length != 13:
                raise DocumentRejected(IMAGE_MALFORMED)
            _check_dimensions(
                int.from_bytes(data[pos + 8 : pos + 12], "big"),
                int.from_bytes(data[pos + 12 : pos + 16], "big"),
            )
            first = False
        if kind == b"IEND":
            if end != len(data):
                raise DocumentRejected(TRAILING_DATA)
            return
        pos = end
    raise DocumentRejected(IMAGE_MALFORMED)


def _jpeg_structure(data: bytes) -> None:
    """A JPEG ends at its end-of-image marker (only zero padding may follow)."""
    if not data.rstrip(b"\x00").endswith(b"\xff\xd9"):
        raise DocumentRejected(TRAILING_DATA)


@contextlib.contextmanager
def _pillow_limits() -> Iterator[None]:
    """Pillow's own decompression-bomb guard at our limit, as an error, for this call only."""
    from PIL import Image

    saved = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            yield
    finally:
        Image.MAX_IMAGE_PIXELS = saved


def _decode_image(data: bytes, media_type: str) -> tuple[int, int, bytes]:
    """Check the header, decode every pixel, and return the size and a sanitised preview."""
    from PIL import Image, UnidentifiedImageError

    expected = "PNG" if media_type == MEDIA_PNG else "JPEG"
    with _pillow_limits():
        try:
            with Image.open(io.BytesIO(data), formats=[expected]) as image:
                width, height = image.size
                _check_dimensions(width, height)  # before any pixel is decoded
                image.load()
                return width, height, _preview(image)
        except DocumentRejected:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise DocumentRejected(IMAGE_TOO_LARGE) from None
        except (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError):
            raise DocumentRejected(IMAGE_MALFORMED) from None


def _preview(image: Any) -> bytes:
    """A re-encoded PNG: oriented, at most PREVIEW_MAX_SIDE, RGB(A), no metadata."""
    from PIL import Image, ImageOps

    oriented = ImageOps.exif_transpose(image)
    mode = "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
    clean = oriented.convert(mode)
    clean.thumbnail((PREVIEW_MAX_SIDE, PREVIEW_MAX_SIDE), Image.Resampling.LANCZOS)
    stripped = Image.new(mode, clean.size)
    stripped.paste(clean)
    out = io.BytesIO()
    stripped.save(out, format="PNG", optimize=False)
    return out.getvalue()


# ----- PDFs -------------------------------------------------------------------------------------


def _inspect_pdf(data: bytes) -> Inspection:
    if not data.rstrip().endswith(b"%%EOF"):
        raise DocumentRejected(TRAILING_DATA)
    # Before parsing: the trailer (or xref stream) dictionary is never compressed.
    if b"/Encrypt" in data:
        raise DocumentRejected(PDF_ENCRYPTED)
    with _pdf_limits():
        return _parse_pdf(data)


@contextlib.contextmanager
def _pdf_limits() -> Iterator[None]:
    from pypdf import apply_configuration

    with apply_configuration(**_PDF_LIMITS):
        yield


def _parse_pdf(data: bytes) -> Inspection:
    from pypdf import PdfReader
    from pypdf.errors import DependencyError, FileNotDecryptedError

    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise DocumentRejected(PDF_ENCRYPTED)
        objects = sum(len(ids) for ids in reader.xref.values()) + len(reader.xref_objStm)
        if objects > MAX_PDF_OBJECTS:
            raise DocumentRejected(PDF_TOO_MANY_OBJECTS)
        pages = len(reader.pages)
        if pages == 0:
            raise DocumentRejected(PDF_MALFORMED)
        if pages > MAX_PDF_PAGES:
            raise DocumentRejected(PDF_TOO_MANY_PAGES)
        _check_active_content(reader)
    except DocumentRejected:
        raise
    except (DependencyError, FileNotDecryptedError):
        raise DocumentRejected(PDF_ENCRYPTED) from None
    except Exception:
        raise DocumentRejected(PDF_MALFORMED) from None
    return Inspection(MEDIA_PDF, page_count=pages, preview_png=_pdf_preview(reader))


def _object_ids(reader: Any) -> Iterator[tuple[int, int]]:
    for generation, ids in reader.xref.items():
        for idnum in ids:
            yield idnum, generation
    for idnum in reader.xref_objStm:
        yield idnum, 0


def _check_active_content(reader: Any) -> None:
    """Every indirect object (compressed ones included), and the direct dictionaries and arrays
    inside it, is checked for keys and action types that execute something."""
    from pypdf.generic import IndirectObject

    for idnum, generation in _object_ids(reader):
        obj = reader.get_object(IndirectObject(idnum, generation, reader))
        _check_node(obj, 0)


def _check_node(node: Any, depth: int) -> None:
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject

    if depth > MAX_PDF_NESTING:
        raise DocumentRejected(PDF_MALFORMED)
    if isinstance(node, DictionaryObject):
        keys = {str(key) for key in node}
        action = node.get("/S")
        kind = node.get("/Type")
        if (
            keys & _HAZARD_KEYS
            or (isinstance(action, NameObject) and str(action) in _HAZARD_ACTIONS)
            or (isinstance(kind, NameObject) and str(kind) == "/EmbeddedFile")
        ):
            raise DocumentRejected(PDF_ACTIVE_CONTENT)
        for key in node:
            _check_node(node.raw_get(key), depth + 1)
    elif isinstance(node, ArrayObject):
        for item in node:
            _check_node(item, depth + 1)


def _declared_images(page: Any) -> list[tuple[int, str]]:
    """`(pixels, name)` of the image XObjects drawn directly on the page whose declared size is
    within the limits, read from their dictionaries: nothing is decoded."""
    from pypdf.generic import DictionaryObject

    resources = page.get("/Resources")
    resources = resources.get_object() if resources is not None else None
    xobjects = resources.get("/XObject") if isinstance(resources, DictionaryObject) else None
    xobjects = xobjects.get_object() if xobjects is not None else None
    if not isinstance(xobjects, DictionaryObject):
        return []
    found = []
    for index, name in enumerate(xobjects):
        if index >= PREVIEW_MAX_PDF_IMAGES:
            break
        xobject = xobjects[name].get_object()
        if not isinstance(xobject, DictionaryObject) or xobject.get("/Subtype") != "/Image":
            continue
        width, height = xobject.get("/Width"), xobject.get("/Height")
        if not isinstance(width, int) or not isinstance(height, int):
            continue
        try:
            _check_dimensions(width, height)
        except DocumentRejected:
            continue
        found.append((width * height, str(name)))
    return found


def _pdf_preview(reader: Any) -> bytes | None:
    """The largest image drawn on page 1 (a scanned document), re-encoded; None if there is
    none or it can't be decoded within the limits. Sizes are checked from the image
    dictionaries before the one chosen is decoded. A preview is best effort: the file itself
    was already accepted."""
    try:
        with _pdf_limits(), _pillow_limits():
            page = reader.pages[0]
            candidates = _declared_images(page)
            if not candidates:
                return None
            _, name = max(candidates)
            image = page.images[name].image
            if image is None:
                return None
            _check_dimensions(*image.size)
            return _preview(image)
    except Exception:
        return None


# ----- the worker -------------------------------------------------------------------------------
#
# A separate interpreter, not `multiprocessing`: nothing of the API process is re-imported or
# inherited. It runs isolated (`python -I -B`: no environment variables, user site, current
# directory on the path or bytecode writes) with an empty environment, so no secret reaches it,
# from `/`, not the backend directory (where `.env` lives), and with limits on CPU time, address
# space (Linux), open files, file writes and core dumps. The file goes in on stdin; the verdict
# comes back as JSON (never pickle, which a compromised worker could use to run code in the API
# process), at most WORKER_MAX_OUTPUT_BYTES of it.
#
# Slots are per API process: `try_slot` never waits, so a busy process answers 503 at once
# instead of tying up request threads behind the workers.

_slots = threading.BoundedSemaphore(MAX_CONCURRENT_INSPECTIONS)
_PACKAGE_ROOT = str(Path(__file__).resolve().parents[2])
_WORKER_CODE = (
    "import sys; sys.path.insert(0, sys.argv[1]); "
    "from app.tools.documents import _worker_main; raise SystemExit(_worker_main(sys.argv[1:]))"
)


def try_acquire_slot() -> bool:
    """Take one of this process's worker slots if one is free now; never waits."""
    return _slots.acquire(blocking=False)


def release_slot() -> None:
    _slots.release()


@contextlib.contextmanager
def inspection_slot() -> Iterator[None]:
    """Hold one of this process's worker slots, or raise InspectionBusy right away."""
    if not try_acquire_slot():
        raise InspectionBusy("every document inspection worker is busy")
    try:
        yield
    finally:
        release_slot()


def _limit_resources(timeout_s: float) -> None:
    """CPU time, address space (Linux), open files, file writes and core dumps; best effort
    where the OS refuses one."""
    try:
        import resource
    except ImportError:  # pragma: no cover - not on POSIX
        return
    limits = (
        (resource.RLIMIT_CPU, int(timeout_s) + 1),
        (resource.RLIMIT_AS, WORKER_MEMORY_BYTES),
        (resource.RLIMIT_NOFILE, WORKER_MAX_FILES),
        (resource.RLIMIT_FSIZE, 0),
        (resource.RLIMIT_CORE, 0),
    )
    for limit, value in limits:
        with contextlib.suppress(ValueError, OSError):
            resource.setrlimit(limit, (value, value))


def _verdict(data: bytes, declared: str) -> dict[str, Any]:
    try:
        found = inspect_document(data, declared)
    except DocumentRejected as exc:
        return {"rejected": exc.code}
    except Exception:
        return {"rejected": INSPECTION_FAILED}
    fields = asdict(found)
    preview = fields.pop("preview_png")
    fields["preview_png"] = None if preview is None else base64.b64encode(preview).decode()
    return {"accepted": fields}


def _worker_main(argv: list[str]) -> int:
    """`argv`: the package root (already on the path), the declared type, the timeout."""
    declared = argv[1] if len(argv) > 1 else ""
    timeout_s = float(argv[2]) if len(argv) > 2 else INSPECT_TIMEOUT_S
    _limit_resources(timeout_s)
    data = sys.stdin.buffer.read(MAX_DOCUMENT_BYTES + 1)
    sys.stdout.write(json.dumps(_verdict(data, declared)))
    sys.stdout.flush()
    return 0


def _parse_verdict(raw: bytes) -> Inspection:
    try:
        verdict = json.loads(raw)
        if "rejected" in verdict:
            code = verdict["rejected"]
            raise DocumentRejected(code if isinstance(code, str) else INSPECTION_FAILED)
        fields = dict(verdict["accepted"])
        preview = fields.pop("preview_png")
        found = Inspection(
            media_type=str(fields["media_type"]),
            page_count=_optional_int(fields.get("page_count")),
            width=_optional_int(fields.get("width")),
            height=_optional_int(fields.get("height")),
            preview_png=None if preview is None else base64.b64decode(preview, validate=True),
        )
    except DocumentRejected:
        raise
    except (ValueError, KeyError, TypeError):
        raise DocumentRejected(INSPECTION_FAILED) from None
    if found.media_type not in ACCEPTED_MEDIA_TYPES:
        raise DocumentRejected(INSPECTION_FAILED)
    return found


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(value)
    return value


def _feed(pipe: IO[bytes], data: bytes | memoryview) -> None:
    with contextlib.suppress(OSError):  # the worker exited or was killed
        pipe.write(data)
    with contextlib.suppress(OSError):
        pipe.close()


def _drain(process: subprocess.Popen[bytes], out: bytearray) -> None:
    """Read the worker's output, killing it once it exceeds WORKER_MAX_OUTPUT_BYTES."""
    assert process.stdout is not None
    while chunk := process.stdout.read(64 * 1024):
        out.extend(chunk)
        if len(out) > WORKER_MAX_OUTPUT_BYTES:
            process.kill()
            return


def run_worker(
    data: bytes | memoryview, declared: str, *, timeout_s: float = INSPECT_TIMEOUT_S
) -> Inspection:
    """`inspect_document` in a fresh worker process, killed after `timeout_s`. The caller holds
    an `inspection_slot`. Raises DocumentRejected: the file's fault, or `inspection_timeout` /
    `inspection_failed` when the worker ran out of time or memory, crashed or said too much."""
    if len(data) == 0:
        raise DocumentRejected(EMPTY_FILE)
    if len(data) > MAX_DOCUMENT_BYTES:  # don't ship an oversized body to a worker
        raise DocumentRejected(FILE_TOO_LARGE)
    command = [sys.executable, "-I", "-B", "-c", _WORKER_CODE, _PACKAGE_ROOT]
    try:
        process = subprocess.Popen(  # noqa: S603 - a fixed command; the file goes in on stdin
            [*command, declared, str(timeout_s)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=os.sep,
            env={},
        )
    except OSError:
        raise DocumentRejected(INSPECTION_FAILED) from None
    assert process.stdin is not None and process.stdout is not None
    out = bytearray()
    threads = [
        threading.Thread(target=_feed, args=(process.stdin, data), daemon=True),
        threading.Thread(target=_drain, args=(process, out), daemon=True),
    ]
    for thread in threads:
        thread.start()
    try:
        process.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise DocumentRejected(INSPECTION_TIMEOUT) from None
    finally:
        for thread in threads:
            thread.join(timeout=5)
        process.stdout.close()
    if process.returncode != 0 or len(out) > WORKER_MAX_OUTPUT_BYTES:
        raise DocumentRejected(INSPECTION_FAILED)
    return _parse_verdict(bytes(out))


def inspect_in_worker(
    data: bytes | memoryview, declared: str, *, timeout_s: float = INSPECT_TIMEOUT_S
) -> Inspection:
    """`run_worker` in a slot of its own: raises InspectionBusy if none is free right now."""
    with inspection_slot():
        return run_worker(data, declared, timeout_s=timeout_s)
