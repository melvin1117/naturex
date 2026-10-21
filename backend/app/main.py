"""FastAPI application entrypoint."""

import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from sqlmodel import Session

from app.config import (
    Settings,
    document_fingerprint_secret,
    get_settings,
    rate_limit_secret,
    secure_cookies,
    validate_mock_settings,
)
from app.db import engine
from app.middleware import CsrfMiddleware, parse_allowed_origins
from app.routers import (
    admin,
    alerts,
    assets,
    auth,
    communities,
    copilot,
    events,
    evidence,
    ipo,
    ledger,
    listings,
    market,
    media,
    places,
    reports,
    runs,
    verification,
    world,
)
from app.sandbox import ensure_live_world
from app.services.document_check import shutdown_default_checker
from app.services.field_evidence import fail_lost_analyses, shutdown_default_analyzer

settings = get_settings()


def warn_if_cookies_insecure(settings: Settings) -> None:
    """Say loudly when session cookies go out without `Secure` (local development and tests)."""
    if not secure_cookies(settings):
        logging.getLogger("app").warning(
            "ENVIRONMENT=%s: the nx_session cookie is not Secure. "
            "Every deployment must set ENVIRONMENT=production.",
            settings.environment,
        )


warn_if_cookies_insecure(settings)


def validate_auth_settings(settings: Settings) -> frozenset[str]:
    """Fail at startup, not on the first login, when the auth settings are unusable."""
    rate_limit_secret(settings)
    deployed = secure_cookies(settings)  # ENVIRONMENT is not explicitly development or test
    if deployed and "allowed_origins" not in settings.model_fields_set:
        raise RuntimeError("ALLOWED_ORIGINS must be set (ENVIRONMENT is not development or test)")
    origins = parse_allowed_origins(settings.allowed_origins)
    log = logging.getLogger("app")
    if not origins:
        log.warning("ALLOWED_ORIGINS is empty: every state-changing request will be rejected.")
    if deployed and settings.trusted_proxy_hops == 0:
        log.warning(
            "TRUSTED_PROXY_HOPS=0: every request counts as coming from the API's direct peer "
            "(the Next.js server or a load balancer), so all visitors share one rate-limit "
            "bucket. Set it to the number of trusted proxies that append to X-Forwarded-For; "
            "the Next.js /api rewrite does not."
        )
    return origins


def prepare_live_world(open_session: Callable[[], Session] = lambda: Session(engine)) -> bool:
    """Create the live world if it's missing, so no request has to (T73). Never fails startup:
    until it exists (e.g. the template isn't seeded yet), reads get 503 `world_unavailable`."""
    try:
        with open_session() as session:
            ensure_live_world(session)
        return True
    except Exception:
        logging.getLogger("app").exception(
            "could not create the live world at startup; run `make seed`"
        )
        return False


def recover_field_evidence(
    open_session: Callable[[], Session] = lambda: Session(engine),
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> int | None:
    """Store `failed` on field photos whose analysis a restart lost (T40), so none stays
    `pending`. Never fails startup; None when it couldn't run."""
    try:
        with open_session() as session:
            lost = fail_lost_analyses(session, now())
            session.commit()
            return lost
    except Exception:
        logging.getLogger("app").exception("could not recover lost field photo analyses")
        return None


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # At startup rather than import, so tools that only import the app (the OpenAPI export for
    # the API client) don't need production secrets. uvicorn runs this before serving.
    validate_auth_settings(settings)
    document_fingerprint_secret(settings)  # T69: fails closed outside development and test
    if settings.live_world_on_startup:
        prepare_live_world()
    validate_mock_settings(settings)
    recover_field_evidence()
    yield
    shutdown_default_checker()  # T71: queued AI document checks are dropped, not waited for
    shutdown_default_analyzer()  # T40: queued photo analyses too (they read `failed` later)
    admin.shutdown_time_machine()  # #201: queued quarter jobs too (the next poll resumes them)


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="AI rating agency and sandbox exchange for living nature",
    lifespan=lifespan,
)
app.add_middleware(
    CsrfMiddleware,
    allowed_origins=[item.strip() for item in settings.allowed_origins.split(",") if item.strip()],
)

app.include_router(auth.router)
app.include_router(communities.router)
app.include_router(assets.router)
app.include_router(listings.router)
app.include_router(ipo.router)
app.include_router(verification.router)
app.include_router(evidence.router)
app.include_router(reports.router)
app.include_router(market.router)
app.include_router(copilot.router)
app.include_router(events.router)
app.include_router(alerts.router)
app.include_router(admin.router)
app.include_router(ledger.router)
app.include_router(world.router)
app.include_router(media.router)
app.include_router(places.router)
app.include_router(runs.router)


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
