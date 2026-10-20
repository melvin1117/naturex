"""Runs and stores the AI document check (T71, ADR-0006 §2 and §5); the agent itself is
`app.agents.document_check`.

- **When:** after a steward submits a run, in a background worker (`DocumentChecker.schedule`),
  never inside a request or a database transaction: the documents are loaded, the session is
  closed, the models are called, then the result is inserted once.
- **Where it runs** (`enabled`): every sandbox world; the live world only with
  `VERIFICATION_AI_LIVE=true` (off until Token Factory's data terms are confirmed).
- **What is sent** (`not_sent_reason`): only a document's sanitised preview, never its bytes. A
  sandbox sends only sample documents (`is_sample`, T76), so no real person's data leaves; with
  `USE_MOCKS=true` the fake model runs in-process and every previewed document is "read".
- **What it can change:** nothing but its own row in `verification_ai_suggestions`. The run's
  checklist, fingerprint and level are never read for writing.
- **Errors:** no model answer, a spent budget or a missing key store a `failed` row; neither
  prompts, answers nor error messages (which can quote an answer) are logged.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterable
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from uuid import UUID

import httpx
from pydantic import ValidationError
from sqlalchemy.dialects.postgresql import insert
from sqlmodel import Session, col, select

from app.agents.document_check import (
    METHOD_VERSION,
    DocumentInput,
    ListingInput,
    MockDocumentLLM,
    NotSent,
    PlaceSource,
    StructuredLLM,
    check_documents,
)
from app.agents.news_scout import Geocoder, NominatimGeocoder
from app.config import Settings
from app.llm import LLMError
from app.models import (
    Asset,
    Community,
    ListingDocument,
    ListingDocumentBlob,
    VerificationAiSuggestion,
    VerificationLevel,
    VerificationRun,
)
from app.schemas import AiSuggestionOut, AiSuggestionResult
from app.worlds import LIVE_WORLD_ID

log = logging.getLogger(__name__)

COMPLETED = "completed"
FAILED = "failed"
FAILED_REASON = "No model answered (or the AI budget is spent); review the documents yourself."


def enabled(settings: Settings, world_id: UUID) -> bool:
    """Sandboxes always; the live world only with VERIFICATION_AI_LIVE=true."""
    return world_id != LIVE_WORLD_ID or settings.verification_ai_live


def not_sent_reason(
    settings: Settings, world_id: UUID, *, has_preview: bool, is_sample: bool
) -> NotSent | None:
    """Why a document's preview may not go to the model, or None if it may."""
    if not has_preview:
        return "no_preview"
    if not settings.use_mocks and world_id != LIVE_WORLD_ID and not is_sample:
        return "not_sample"
    return None


@dataclass(frozen=True, slots=True)
class _Prepared:
    community_name: str | None
    area: Decimal
    centroid: tuple[float, float] | None
    country: str | None
    documents: list[DocumentInput]


def _prepare(
    session: Session, settings: Settings, world_id: UUID, asset_id: UUID, run_id: UUID
) -> _Prepared | None:
    """The run's own documents and listing facts, or None when there's nothing to check: the
    run is gone, superseded or decided, or already has a suggestion. Loaded by
    `(world_id, asset_id, run_id)` only, so nothing of another listing or world is read."""
    run = session.exec(
        select(VerificationRun).where(
            VerificationRun.world_id == world_id,
            VerificationRun.asset_id == asset_id,
            VerificationRun.id == run_id,
        )
    ).one_or_none()
    if (
        run is None
        or not run.is_current
        or run.level is not VerificationLevel.DOCUMENTS_SUBMITTED
        or session.get(VerificationAiSuggestion, run_id) is not None
    ):
        return None
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).one()
    community_name = None
    if asset.community_id is not None:
        community_name = session.exec(
            select(Community.name).where(
                Community.world_id == world_id, Community.id == asset.community_id
            )
        ).one_or_none()
    documents = session.exec(
        select(ListingDocument)
        .where(
            ListingDocument.world_id == world_id,
            ListingDocument.asset_id == asset_id,
            ListingDocument.run_id == run_id,
        )
        .order_by(col(ListingDocument.created_at), col(ListingDocument.id))
    ).all()
    inputs: list[DocumentInput] = []
    for document in documents:
        reason = not_sent_reason(
            settings, world_id, has_preview=document.has_preview, is_sample=document.is_sample
        )
        preview = None
        if reason is None:
            preview = session.exec(
                select(ListingDocumentBlob.preview_png).where(
                    ListingDocumentBlob.document_id == document.id,
                    ListingDocumentBlob.world_id == world_id,
                    ListingDocumentBlob.asset_id == asset_id,
                )
            ).one_or_none()
            reason = None if preview else "no_preview"
        inputs.append(
            DocumentInput(document.id, document.doc_type, preview, document.is_sample, reason)
        )
    centroid = None
    if asset.centroid_lat is not None and asset.centroid_lon is not None:
        centroid = (asset.centroid_lat, asset.centroid_lon)
    return _Prepared(community_name, asset.area_ha, centroid, asset.country, inputs)


def _place(prepared: _Prepared, geocoder: Geocoder | None) -> tuple[tuple[str, ...], PlaceSource]:
    """The listing's place names: the reverse geocode of its centroid (Nominatim, as News Scout
    does), else its stored country (a gap the result flags)."""
    if geocoder is not None and prepared.centroid is not None:
        try:
            place = geocoder.reverse(*prepared.centroid)
        except (httpx.HTTPError, ValidationError, ValueError, LookupError):
            pass
        else:
            names = place.place_names or (place.label,)
            return tuple(name for name in names if name), "reverse_geocode"
    if prepared.country:
        return (prepared.country,), "stored_country"
    return (), "none"


def _failed() -> dict[str, Any]:
    return {
        "reasons": [FAILED_REASON],
        "comparisons": [],
        "documents": [],
        "flags": [],
        "models": [],
    }


def store(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    run_id: UUID,
    result: AiSuggestionResult | None,
) -> None:
    """Insert the run's suggestion once (a second insert is ignored). The caller commits."""
    payload = (
        _failed()
        if result is None
        else result.model_dump(mode="json", exclude={"suggestion", "method_version"})
    )
    session.execute(
        insert(VerificationAiSuggestion)
        .values(
            run_id=run_id,
            world_id=world_id,
            asset_id=asset_id,
            status=FAILED if result is None else COMPLETED,
            suggestion=None if result is None else result.suggestion,
            result=payload,
            method_version=METHOD_VERSION if result is None else result.method_version,
        )
        .on_conflict_do_nothing(index_elements=["run_id"])
    )


def suggestions_for(
    session: Session, world_id: UUID, run_ids: Iterable[UUID]
) -> dict[UUID, AiSuggestionOut]:
    """The stored suggestions of these runs in this world, by run."""
    wanted = list(run_ids)
    if not wanted:
        return {}
    rows = session.exec(
        select(VerificationAiSuggestion).where(
            VerificationAiSuggestion.world_id == world_id,
            col(VerificationAiSuggestion.run_id).in_(wanted),
        )
    ).all()
    return {
        row.run_id: AiSuggestionOut.model_validate(
            {
                **row.result,
                "run_id": row.run_id,
                "status": row.status,
                "suggestion": row.suggestion,
                "method_version": row.method_version,
                "created_at": row.created_at,
            }
        )
        for row in rows
    }


LlmFactory = Callable[[], StructuredLLM]


@dataclass
class DocumentChecker:
    """Schedules and runs the AI document check of a submitted run."""

    session_factory: Callable[[], Session]
    settings: Settings
    executor: Executor
    llm_factory: LlmFactory
    geocoder: Geocoder | None = None

    def schedule(self, world_id: UUID, asset_id: UUID, run_id: UUID) -> bool:
        """Queue the check (after the run is committed); False where it doesn't run."""
        if not enabled(self.settings, world_id):
            return False
        try:
            self.executor.submit(self.run, world_id, asset_id, run_id)
        except RuntimeError:  # the worker is shutting down: the run stands without a suggestion
            log.warning("document check of run %s not queued: worker unavailable", run_id)
            return False
        return True

    def run(self, world_id: UUID, asset_id: UUID, run_id: UUID) -> None:
        try:
            self._run(world_id, asset_id, run_id)
        except Exception as exc:  # a worker thread: report the kind only, never the message
            log.error("document check of run %s failed: %s", run_id, type(exc).__name__)

    def _run(self, world_id: UUID, asset_id: UUID, run_id: UUID) -> None:
        if not enabled(self.settings, world_id):
            return
        with self.session_factory() as session:
            prepared = _prepare(session, self.settings, world_id, asset_id, run_id)
        if prepared is None:
            return
        place_names, source = _place(prepared, self.geocoder)
        listing = ListingInput(
            world_id=world_id,
            asset_id=asset_id,
            community_name=prepared.community_name,
            area_ha=prepared.area,
            place_names=place_names,
            place_source=source,
        )
        result: AiSuggestionResult | None
        try:
            result = check_documents(listing, prepared.documents, self.llm_factory())
        except LLMError as exc:
            log.warning(
                "document check of run %s: no model answer (%s)", run_id, type(exc).__name__
            )
            result = None
        with self.session_factory() as session:
            store(session, world_id=world_id, asset_id=asset_id, run_id=run_id, result=result)
            session.commit()


# ----- the process-wide checker -----------------------------------------------------------------

_default_checker: DocumentChecker | None = None
_default_lock = threading.Lock()


def _production_llm(settings: Settings, session_factory: Callable[[], Session]) -> LlmFactory:
    def factory() -> StructuredLLM:
        if settings.use_mocks:
            return MockDocumentLLM()
        from app.llm import get_llm_client

        return get_llm_client(settings, session_factory)  # ModelNotConfigured without a key

    return factory


def default_checker() -> DocumentChecker:
    """The API's checker: one worker thread, sessions on the app engine, settings from env."""
    global _default_checker
    with _default_lock:
        if _default_checker is None:
            from app.config import get_settings
            from app.db import engine

            settings = get_settings()

            def session_factory() -> Session:
                return Session(engine)

            _default_checker = DocumentChecker(
                session_factory=session_factory,
                settings=settings,
                executor=ThreadPoolExecutor(max_workers=1, thread_name_prefix="document-check"),
                llm_factory=_production_llm(settings, session_factory),
                geocoder=None
                if settings.use_mocks
                else NominatimGeocoder(settings.nominatim_user_agent),
            )
        return _default_checker


def get_document_checker() -> DocumentChecker:
    """FastAPI dependency (tests override it)."""
    return default_checker()
