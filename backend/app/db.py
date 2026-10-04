"""Database engine and session helpers."""

from collections.abc import Generator

from sqlmodel import Session, create_engine

from app.config import get_settings

_settings = get_settings()
engine = create_engine(
    _settings.database_url,
    echo=False,
    pool_pre_ping=True,
)


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session
