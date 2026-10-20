"""Field evidence (T40, dev-spec §7.6): storing photos, analysing them, and the
`field_evidence` tool's provider. Rules are in `app.tools.field_evidence`; the image model in
`app.agents.field_evidence`.

- **Upload** (`store_photo`): the photo was inspected in a worker (`app.tools.documents`, photo
  mode): JPEG or PNG, ≤ 10 MB, re-encoded without metadata. Only the re-encoded JPEG is kept;
  from the EXIF, only the checks' results (inside the listing or how far outside, the date). At
  most `MAX_PHOTOS_PER_ASSET` per listing, each file once.
- **Analysis** (`EvidenceAnalyzer`): when both geotag checks pass, the image model labels the
  photo on a worker thread, never inside a request or a transaction. `ai_mode`: sandboxes use
  MiniCPM-V; the live world only with `FIELD_EVIDENCE_AI_LIVE=true`; `USE_MOCKS=true` runs a
  fake model in-process. Code then decides (`evidence_verdict`); a validated photo gets an
  `events` row (`source='evidence'`) in the same transaction, written by code from its labels.
- **The tool** (`DbEvidenceProvider`): the Orchestrator is offered `field_evidence` when the
  listing has validated photos; it loads them as Auditor events (`validated=True`), which set
  the confidence evidence term (+14.0 points) and never feed threat pressure.
- **Errors:** no model answer, a spent budget or a missing key mark the photo `failed`; neither
  the image, prompts, answers nor error messages are logged (only an error's type and frames).
"""

from __future__ import annotations

import io
import logging
import threading
import traceback
from collections.abc import Callable
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Final, Literal
from uuid import UUID

from PIL import Image
from sqlalchemy import func
from sqlmodel import Session, col, select

from app.agents.auditor import AuditEvent
from app.agents.field_evidence import MockPhotoLLM, StructuredLLM, read_photo
from app.config import Settings
from app.llm import LLMError
from app.models import (
    Asset,
    AssetStatus,
    Event,
    EventSource,
    FieldPhoto,
    FieldPhotoBlob,
    Report,
)
from app.schemas import (
    ConfidenceEffectOut,
    FieldEvidenceOut,
    FieldEvidencePublicOut,
    FieldPhotoObservationOut,
    FieldPhotoOut,
)
from app.tools.documents import Inspection
from app.tools.field_evidence import (
    GPS_BUFFER_M,
    MAX_PHOTO_AGE_DAYS,
    MAX_PHOTOS_PER_ASSET,
    METHOD_VERSION,
    GeotagCheck,
    Observation,
    check_geotag,
    confidence_effect,
    event_fields,
    evidence_verdict,
    labels_of,
)
from app.worlds import LIVE_WORLD_ID

log = logging.getLogger(__name__)

AiMode = Literal["model", "mock", "off"]
PENDING: Final = "pending"
COMPLETED: Final = "completed"
FAILED: Final = "failed"
NOT_RUN: Final = "not_run"
PENDING_TIMEOUT = timedelta(minutes=15)
"""An analysis not stored by then was lost (an API restart drops the queue): it reads `failed`."""

PHOTO_LIMIT_REACHED = "photo_limit_reached"
PHOTO_DUPLICATE = "photo_duplicate"
LISTING_CLOSED = "listing_closed"
CLOSED_STATUSES = frozenset({AssetStatus.WITHDRAWN, AssetStatus.INELIGIBLE})


class EvidenceRefused(Exception):
    """The upload is refused (HTTP 409 with `code`)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class PhotoNotFound(LookupError):
    pass


def ai_mode(settings: Settings, world_id: UUID) -> AiMode:
    """`mock` with USE_MOCKS; `off` in the live world until FIELD_EVIDENCE_AI_LIVE; else
    `model` (sandboxes)."""
    if settings.use_mocks:
        return "mock"
    if world_id == LIVE_WORLD_ID and not settings.field_evidence_ai_live:
        return "off"
    return "model"


# ----- reads ------------------------------------------------------------------------------------


def photos_of(session: Session, world_id: UUID, asset_id: UUID) -> list[FieldPhoto]:
    return list(
        session.exec(
            select(FieldPhoto)
            .where(FieldPhoto.world_id == world_id, FieldPhoto.asset_id == asset_id)
            .order_by(col(FieldPhoto.created_at), col(FieldPhoto.id))
        ).all()
    )


def photo_count(session: Session, world_id: UUID, asset_id: UUID) -> int:
    return int(
        session.exec(
            select(func.count())
            .select_from(FieldPhoto)
            .where(FieldPhoto.world_id == world_id, FieldPhoto.asset_id == asset_id)
        ).one()
    )


def photo_image(session: Session, world_id: UUID, asset_id: UUID, photo_id: UUID) -> bytes:
    """The re-encoded JPEG, loaded by `(world_id, asset_id, id)`; raises PhotoNotFound."""
    content = session.exec(
        select(FieldPhotoBlob.content).where(
            FieldPhotoBlob.world_id == world_id,
            FieldPhotoBlob.asset_id == asset_id,
            FieldPhotoBlob.photo_id == photo_id,
        )
    ).one_or_none()
    if content is None:
        raise PhotoNotFound(photo_id)
    return content


def _geotag(photo: FieldPhoto) -> GeotagCheck:
    return GeotagCheck(
        gps=photo.gps_check,  # type: ignore[arg-type]  # the DB constraint holds the values
        distance_m=photo.gps_distance_m,
        taken=photo.date_check,  # type: ignore[arg-type]
        taken_on=photo.taken_on,
    )


def _observation(stored: dict[str, Any] | None) -> Observation | None:
    if stored is None:
        return None
    return Observation(
        shows_landscape=bool(stored["shows_landscape"]),
        land_cover=tuple(stored["land_cover"]),
        disturbance=tuple(stored["disturbance"]),
        water_clarity=stored["water_clarity"],
        authenticity_concerns=tuple(stored["authenticity_concerns"]),
        instruction_text=bool(stored["instruction_text"]),
    )


def _status(photo: FieldPhoto, now: datetime) -> str:
    if photo.analysis_status == PENDING and now - photo.created_at >= PENDING_TIMEOUT:
        return FAILED
    return photo.analysis_status


def photo_out(photo: FieldPhoto, now: datetime) -> FieldPhotoOut:
    status = _status(photo, now)
    reasons = list(photo.reasons)
    if status == FAILED and photo.analysis_status == PENDING:
        reasons = [*reasons, "not_analysed"]
    observation = None
    if photo.observation is not None:
        observation = FieldPhotoObservationOut.model_validate(photo.observation)
    return FieldPhotoOut(
        id=photo.id,
        asset_id=photo.asset_id,
        created_at=photo.created_at,
        width=photo.width,
        height=photo.height,
        size_bytes=photo.size_bytes,
        gps_check=photo.gps_check,
        gps_distance_m=photo.gps_distance_m,
        gps_buffer_m=GPS_BUFFER_M,
        date_check=photo.date_check,
        taken_on=photo.taken_on,
        max_age_days=MAX_PHOTO_AGE_DAYS,
        analysis_status=status,
        observation=observation,
        validated=photo.validated,
        reasons=reasons,
        event_id=photo.event_id,
    )


def _latest_confidence(
    session: Session, world_id: UUID, asset_id: UUID
) -> tuple[Decimal | None, Decimal | None]:
    """The latest report's confidence and its evidence term (None before the first rating)."""
    report = session.exec(
        select(Report)
        .where(Report.world_id == world_id, Report.asset_id == asset_id)
        .order_by(col(Report.version).desc())
        .limit(1)
    ).first()
    if report is None or report.confidence is None:
        return None, None
    rating = (report.auditor_json or {}).get("rating") or {}
    term = ((rating.get("score") or {}).get("confidence_components") or {}).get("evidence")
    return Decimal(report.confidence), (Decimal(str(term)) if term is not None else None)


def steward_view(
    session: Session, settings: Settings, world_id: UUID, asset_id: UUID, now: datetime
) -> FieldEvidenceOut:
    photos = photos_of(session, world_id, asset_id)
    validated = sum(1 for photo in photos if photo.validated)
    current, term = _latest_confidence(session, world_id, asset_id)
    effect = confidence_effect(current, term, validated=validated > 0)
    return FieldEvidenceOut(
        photos=[photo_out(photo, now) for photo in photos],
        max_photos=MAX_PHOTOS_PER_ASSET,
        validated=validated,
        ai_analysis=ai_mode(settings, world_id),
        confidence=ConfidenceEffectOut(
            current=effect.current,
            projected=effect.projected,
            points=effect.points,
            counted=effect.counted,
        ),
    )


def public_view(session: Session, world_id: UUID, asset_id: UUID) -> FieldEvidencePublicOut:
    """Counts and labels of validated photos: no photo, position, date of upload or uploader."""
    photos = photos_of(session, world_id, asset_id)
    validated = [photo for photo in photos if photo.validated]
    observations = [o for photo in validated if (o := _observation(photo.observation))]
    cover, signs = labels_of(observations)
    _, term = _latest_confidence(session, world_id, asset_id)
    dates = [photo.taken_on for photo in validated if photo.taken_on is not None]
    return FieldEvidencePublicOut(
        photos=len(photos),
        validated=len(validated),
        latest_taken_on=max(dates, default=None),
        land_cover=cover,
        disturbance=signs,
        counted_in_latest_report=term is not None and term >= Decimal("1"),
    )


# ----- writes -----------------------------------------------------------------------------------


def check_open(asset: Asset) -> None:
    if asset.status in CLOSED_STATUSES:
        raise EvidenceRefused(LISTING_CLOSED)


def _lock_asset(session: Session, world_id: UUID, asset_id: UUID) -> Asset:
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id).with_for_update()
    ).one_or_none()
    if asset is None:
        raise LookupError(asset_id)
    return asset


def store_photo(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    uploaded_by: UUID,
    sha256: str,
    inspection: Inspection,
    mode: AiMode,
    today: date,
) -> FieldPhoto:
    """Store an inspected photo with its geotag checks, in the caller's transaction (the caller
    commits). Under the asset's row lock: the limit and duplicates are checked again, so two
    uploads can't both take the last slot. Raises EvidenceRefused or LookupError."""
    jpeg = inspection.photo_jpeg
    if jpeg is None or inspection.width is None or inspection.height is None:
        raise ValueError("not a photo inspection")
    asset = _lock_asset(session, world_id, asset_id)
    check_open(asset)
    if photo_count(session, world_id, asset_id) >= MAX_PHOTOS_PER_ASSET:
        raise EvidenceRefused(PHOTO_LIMIT_REACHED)
    duplicate = session.exec(
        select(FieldPhoto.id).where(
            FieldPhoto.world_id == world_id,
            FieldPhoto.asset_id == asset_id,
            FieldPhoto.sha256 == sha256,
        )
    ).first()
    if duplicate is not None:
        raise EvidenceRefused(PHOTO_DUPLICATE)
    geotag = check_geotag(
        asset.geojson, inspection.gps_lat, inspection.gps_lon, inspection.taken_at, today
    )
    analyse = geotag.passed and mode != "off"
    # The worker's re-encoded JPEG, not the upload; only its header is read here.
    with Image.open(io.BytesIO(jpeg), formats=["JPEG"]) as stored:
        width, height = stored.size
    photo = FieldPhoto(
        world_id=world_id,
        asset_id=asset_id,
        uploaded_by=uploaded_by,
        size_bytes=len(jpeg),
        width=width,
        height=height,
        sha256=sha256,
        gps_check=geotag.gps,
        gps_distance_m=geotag.distance_m,
        date_check=geotag.taken,
        taken_on=geotag.taken_on,
        analysis_status=PENDING if analyse else NOT_RUN,
        reasons=[] if analyse else list(evidence_verdict(geotag, None)[1]),
        method_version=METHOD_VERSION,
    )
    session.add(photo)
    session.flush()
    session.add(
        FieldPhotoBlob(photo_id=photo.id, world_id=world_id, asset_id=asset_id, content=jpeg)
    )
    session.flush()
    return photo


def delete_photo(session: Session, world_id: UUID, asset_id: UUID, photo_id: UUID) -> None:
    """Delete a photo and its image (the caller commits). Its evidence event stays as history;
    the next rating no longer counts it. Raises PhotoNotFound."""
    _lock_asset(session, world_id, asset_id)
    photo = session.exec(
        select(FieldPhoto).where(
            FieldPhoto.world_id == world_id,
            FieldPhoto.asset_id == asset_id,
            FieldPhoto.id == photo_id,
        )
    ).one_or_none()
    if photo is None:
        raise PhotoNotFound(photo_id)
    session.delete(photo)  # the blob goes with it (ON DELETE CASCADE)
    session.flush()


def finish_analysis(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    photo_id: UUID,
    observation: Observation | None,
    model: str | None,
    now: datetime,
) -> FieldPhoto | None:
    """Record a pending photo's analysis and, if code validates it, its evidence event, in one
    transaction (the caller commits). None when the photo is gone or no longer pending."""
    photo = session.exec(
        select(FieldPhoto)
        .where(
            FieldPhoto.world_id == world_id,
            FieldPhoto.asset_id == asset_id,
            FieldPhoto.id == photo_id,
            FieldPhoto.analysis_status == PENDING,
        )
        .with_for_update()
    ).one_or_none()
    if photo is None:
        return None
    validated, reasons = evidence_verdict(_geotag(photo), observation)
    if validated and observation is not None:
        fields = event_fields(observation, photo.taken_on)
        event = Event(
            world_id=world_id,
            asset_id=asset_id,
            source=EventSource.EVIDENCE,
            title=fields.title,
            published_at=photo.taken_on,
            impact_type=fields.impact_type,
            direction=fields.direction,
            severity=fields.severity,
            summary=fields.summary,
        )
        session.add(event)
        session.flush()
        photo.event_id = event.id
    photo.analysis_status = FAILED if observation is None else COMPLETED
    photo.observation = observation.to_json() if observation is not None else None
    photo.reasons = list(reasons)
    photo.validated = validated
    photo.model = model
    photo.analysed_at = now
    session.add(photo)
    session.flush()
    return photo


# ----- the analyzer -----------------------------------------------------------------------------


def _frames(exc: BaseException) -> str:
    """Where an exception happened, never its message (which can quote a model's answer)."""
    return "\n".join(
        f"  {frame.filename}:{frame.lineno} in {frame.name}"
        for frame in traceback.extract_tb(exc.__traceback__)
    )


LlmFactory = Callable[[], StructuredLLM]


@dataclass
class EvidenceAnalyzer:
    """Schedules and runs the image model on pending photos."""

    session_factory: Callable[[], Session]
    settings: Settings
    executor: Executor
    llm_factory: LlmFactory
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)

    def schedule(self, world_id: UUID, asset_id: UUID, photo_id: UUID) -> bool:
        """Queue the analysis (after the photo is committed); False if the worker is down, in
        which case the photo reads `failed` after PENDING_TIMEOUT."""
        try:
            self.executor.submit(self.run, world_id, asset_id, photo_id)
        except RuntimeError:
            log.warning("field photo %s not queued: worker unavailable", photo_id)
            return False
        return True

    def shutdown(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)

    def run(self, world_id: UUID, asset_id: UUID, photo_id: UUID) -> None:
        try:
            self._run(world_id, asset_id, photo_id)
        except Exception as exc:  # a worker thread: the kind and frames, never the message
            log.error(
                "field photo %s analysis failed: %s\n%s", photo_id, type(exc).__name__, _frames(exc)
            )

    def _run(self, world_id: UUID, asset_id: UUID, photo_id: UUID) -> None:
        with self.session_factory() as session:
            pending = session.exec(
                select(FieldPhoto.id).where(
                    FieldPhoto.world_id == world_id,
                    FieldPhoto.asset_id == asset_id,
                    FieldPhoto.id == photo_id,
                    FieldPhoto.analysis_status == PENDING,
                )
            ).first()
            if pending is None:
                return
            jpeg = photo_image(session, world_id, asset_id, photo_id)
        observation: Observation | None = None
        model: str | None = None
        try:
            result = read_photo(self.llm_factory(), world_id=world_id, asset_id=asset_id, jpeg=jpeg)
            observation, model = result.value.observation(), result.model
        except LLMError as exc:
            log.warning("field photo %s: no model answer (%s)", photo_id, type(exc).__name__)
        with self.session_factory() as session:
            finish_analysis(
                session,
                world_id=world_id,
                asset_id=asset_id,
                photo_id=photo_id,
                observation=observation,
                model=model,
                now=self.clock(),
            )
            session.commit()


# ----- the `field_evidence` tool ----------------------------------------------------------------


def evidence_events(session: Session, world_id: UUID, asset_id: UUID) -> list[AuditEvent]:
    """The listing's validated photos as Auditor events, oldest first. Their text is code's."""
    rows = session.exec(
        select(FieldPhoto, Event)
        .join(Event, col(Event.id) == col(FieldPhoto.event_id))
        .where(
            FieldPhoto.world_id == world_id,
            FieldPhoto.asset_id == asset_id,
            col(FieldPhoto.validated).is_(True),
            Event.world_id == world_id,
        )
        .order_by(col(FieldPhoto.created_at), col(FieldPhoto.id))
    ).all()
    return [
        AuditEvent(
            id=str(event.id),
            source="evidence",
            relevant=True,
            impact_type=event.impact_type or "other",
            direction=event.direction or 0,
            severity=event.severity or 1,
            published_at=event.published_at,
            validated=True,
            title=event.title,
            summary=event.summary or "",
        )
        for _, event in rows
    ]


@dataclass(frozen=True)
class DbEvidenceProvider:
    """`rating_runs.EvidenceProvider` over the stored photos (T40)."""

    session_factory: Callable[[], Session]

    def available(self, world_id: UUID, asset_id: UUID) -> bool:
        with self.session_factory() as session:
            found = session.exec(
                select(FieldPhoto.id)
                .where(
                    FieldPhoto.world_id == world_id,
                    FieldPhoto.asset_id == asset_id,
                    col(FieldPhoto.validated).is_(True),
                )
                .limit(1)
            ).first()
            return found is not None

    def load(self, world_id: UUID, asset_id: UUID) -> list[AuditEvent]:
        with self.session_factory() as session:
            return evidence_events(session, world_id, asset_id)


# ----- the process-wide analyzer ----------------------------------------------------------------

_default_analyzer: EvidenceAnalyzer | None = None
_default_lock = threading.Lock()


def _production_llm(settings: Settings, session_factory: Callable[[], Session]) -> LlmFactory:
    def factory() -> StructuredLLM:
        if settings.use_mocks:
            return MockPhotoLLM()
        from app.llm import get_llm_client

        return get_llm_client(settings, session_factory)  # ModelNotConfigured without a key

    return factory


def default_analyzer() -> EvidenceAnalyzer:
    global _default_analyzer
    with _default_lock:
        if _default_analyzer is None:
            from app.config import get_settings
            from app.db import engine

            settings = get_settings()

            def session_factory() -> Session:
                return Session(engine)

            _default_analyzer = EvidenceAnalyzer(
                session_factory=session_factory,
                settings=settings,
                executor=ThreadPoolExecutor(max_workers=1, thread_name_prefix="field-evidence"),
                llm_factory=_production_llm(settings, session_factory),
            )
        return _default_analyzer


def get_evidence_analyzer() -> EvidenceAnalyzer:
    """FastAPI dependency (tests override it)."""
    return default_analyzer()


def shutdown_default_analyzer() -> None:
    with _default_lock:
        if _default_analyzer is not None:
            _default_analyzer.shutdown()
