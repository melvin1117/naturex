"""FastAPI application entrypoint."""

from fastapi import FastAPI

from app.config import get_settings

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="AI rating agency and sandbox exchange for living nature",
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe for local Docker and hosted endpoints."""
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    """Readiness probe (DB checks land in later tasks)."""
    return {"status": "ready"}
