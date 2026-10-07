"""FastAPI application entrypoint."""

import logging

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from app.config import Settings, get_settings, secure_cookies
from app.routers import admin, assets, auth, copilot, events, ledger, market, reports, world

settings = get_settings()


def warn_if_cookies_insecure(settings: Settings) -> None:
    """Say loudly when session cookies go out without `Secure` (local development and tests)."""
    if not secure_cookies(settings):
        logging.getLogger("app").warning(
            "ENVIRONMENT=%s: the nx_session and nx_world cookies are not Secure. "
            "Every deployment must set ENVIRONMENT=production.",
            settings.environment,
        )


warn_if_cookies_insecure(settings)

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="AI rating agency and sandbox exchange for living nature",
)

app.include_router(auth.router)
app.include_router(assets.router)
app.include_router(reports.router)
app.include_router(market.router)
app.include_router(copilot.router)
app.include_router(events.router)
app.include_router(admin.router)
app.include_router(ledger.router)
app.include_router(world.router)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError) -> Response:
    """Auth validation errors never echo the submitted values (passwords included)."""
    if not request.url.path.startswith("/auth/"):
        return await request_validation_exception_handler(request, exc)
    errors = [
        {key: err[key] for key in ("type", "loc", "msg") if key in err} for err in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe for local Docker and hosted endpoints."""
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    """Readiness probe (DB checks land in later tasks)."""
    return {"status": "ready"}
