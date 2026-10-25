"""The sandbox channel: no-sign-up demo sandboxes live under `/sandbox/*`.

The real app and a visitor's private sandbox are two channels of the same API. The browser
reaches its sandbox through `/sandbox/<route>` (the frontend proxies `/api/sandbox/*` here);
this pure-ASGI middleware strips the prefix and marks the request, so every route serves both
channels unchanged. The session cookie depends on the channel:

- the real app: `nx_session`, any session kind (password sessions in practice);
- the sandbox: `nx_demo`, demo sessions only.

A browser can hold both, so trying the sandbox never signs a real account out, and the real
app's pages never turn into a sandbox. Pure ASGI, not `BaseHTTPMiddleware`, so streaming
responses (SSE) are never buffered.
"""

from __future__ import annotations

from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from app.auth import SESSION_COOKIE

SANDBOX_PREFIX = "/sandbox"
DEMO_COOKIE = "nx_demo"
SANDBOX_PATH_ONLY = "sandbox_path_only"
NOT_IN_SANDBOX = "not_in_sandbox"
_SCOPE_KEY = "wildworth.sandbox"
_RAW_PREFIX = SANDBOX_PREFIX.encode()


class SandboxChannelMiddleware:
    """`/sandbox` and `/sandbox/...` → the same route without the prefix, marked as sandbox."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            path: str = scope["path"]
            if path == SANDBOX_PREFIX or path.startswith(SANDBOX_PREFIX + "/"):
                scope = {**scope, "path": path[len(SANDBOX_PREFIX) :] or "/", _SCOPE_KEY: True}
                raw = scope.get("raw_path")
                if isinstance(raw, bytes) and raw.startswith(_RAW_PREFIX):
                    scope["raw_path"] = raw[len(_RAW_PREFIX) :] or b"/"
        await self.app(scope, receive, send)


def in_sandbox(connection: HTTPConnection) -> bool:
    """Whether the request came through `/sandbox`."""
    return bool(connection.scope.get(_SCOPE_KEY, False))


def session_cookie(connection: HTTPConnection) -> str:
    """The session cookie this request's channel reads and writes."""
    return DEMO_COOKIE if in_sandbox(connection) else SESSION_COOKIE
