"""FastAPI application entrypoint."""

from fastapi import FastAPI

from app.config import get_settings
from app.routers import admin, assets, copilot, events, ledger, market, reports

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="AI rating agency and sandbox exchange for living nature",
)

app.include_router(assets.router)
app.include_router(reports.router)
app.include_router(market.router)
app.include_router(copilot.router)
app.include_router(events.router)
app.include_router(admin.router)
app.include_router(ledger.router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe for local Docker and hosted endpoints."""
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    """Readiness probe (DB checks land in later tasks)."""
    return {"status": "ready"}
