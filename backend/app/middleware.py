"""CSRF protection for state-changing requests (ADR-0005 §1, T66).

Cookies are `SameSite=Lax`; on top of that every method except GET, HEAD, OPTIONS and TRACE
(POST, PUT, PATCH, DELETE and anything unusual) must come from an allowed origin. `Origin` is
checked first; only when it is absent does `Referer` count. A value
that is `null`, malformed, duplicated or not exactly in `ALLOWED_ORIGINS` (scheme, host and port)
is rejected, and so is a request with neither header. A request body must be JSON, or multipart
for uploads, so a cross-site HTML form can't be used even where a header check is bypassed.

Pure ASGI, not `BaseHTTPMiddleware`, so streaming responses (SSE) are never buffered.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
DEFAULT_PORTS = {"http": 80, "https": 443}
CSRF_FAILED = "csrf_origin"
UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type"


def canonical_origin(value: str, *, allow_path: bool) -> str | None:
    """`scheme://host:port` for a well-formed http(s) origin or URL, else None.

    An `Origin` header carries no path (`allow_path=False`); a `Referer` does, and only its
    origin part is used. Anything with credentials, a backslash, whitespace or control
    characters is malformed: browsers never send those, so a client that does is not a browser.
    """
    if not value or value != value.strip() or any(ord(ch) <= 32 or ord(ch) == 127 for ch in value):
        return None
    if "\\" in value:
        return None
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").lower()
    if scheme not in DEFAULT_PORTS or not host or "@" in parts.netloc:
        return None
    if not allow_path and (parts.path not in ("", "/") or parts.query or parts.fragment):
        return None
    shown = f"[{host}]" if ":" in host else host
    return f"{scheme}://{shown}:{port if port is not None else DEFAULT_PORTS[scheme]}"


def parse_allowed_origins(raw: str) -> frozenset[str]:
    """The `ALLOWED_ORIGINS` list (comma separated). Fails fast on a wildcard or a bad entry."""
    allowed: set[str] = set()
    for item in raw.split(","):
        entry = item.strip()
        if not entry:
            continue
        origin = canonical_origin(entry, allow_path=False)
        if origin is None:
            raise ValueError(f"ALLOWED_ORIGINS entry {entry!r} is not an http(s) origin")
        allowed.add(origin)
    return frozenset(allowed)


def origin_allowed(origins: Sequence[str], referers: Sequence[str], allowed: Iterable[str]) -> bool:
    """Origin decides when present (even `null`); Referer only when Origin is absent."""
    allowed_set = {canonical_origin(item, allow_path=False) for item in allowed} - {None}
    if len(origins) > 1 or len(referers) > 1:
        return False
    if origins:
        return canonical_origin(origins[0], allow_path=False) in allowed_set
    if referers:
        return canonical_origin(referers[0], allow_path=True) in allowed_set
    return False


def media_type_ok(content_type: str | None) -> bool:
    media = (content_type or "").split(";", 1)[0].strip().lower()
    return (
        media == "application/json"
        or (media.startswith("application/") and media.endswith("+json"))
        or media == "multipart/form-data"
    )


def has_body(headers: Headers) -> bool:
    length = headers.get("content-length")
    return "transfer-encoding" in headers or (
        length is not None and length.strip() not in ("", "0")
    )


class CsrfMiddleware:
    def __init__(self, app: ASGIApp, *, allowed_origins: Iterable[str]) -> None:
        self.app = app
        cleaned = (canonical_origin(item, allow_path=False) for item in allowed_origins)
        self.allowed = frozenset(origin for origin in cleaned if origin is not None)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in SAFE_METHODS:
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if not origin_allowed(headers.getlist("origin"), headers.getlist("referer"), self.allowed):
            await self._reject(403, CSRF_FAILED, scope, receive, send)
        elif has_body(headers) and not media_type_ok(headers.get("content-type")):
            await self._reject(415, UNSUPPORTED_MEDIA_TYPE, scope, receive, send)
        else:
            await self.app(scope, receive, send)

    @staticmethod
    async def _reject(status: int, detail: str, scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            {"detail": detail}, status_code=status, headers={"Cache-Control": "no-store"}
        )
        await response(scope, receive, send)
