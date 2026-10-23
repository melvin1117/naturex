"""Copilot API (T39): lazy per-world index, isolation, refusal, streaming, budget and rate caps.

Runs with USE_MOCKS=true (deterministic hash embeddings, extractive answers) unless a test
swaps in a fake Token Factory, so CI needs no keys.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, func, select

from app.config import Settings, get_settings
from app.db import engine as db_engine
from app.db import get_session
from app.llm import BudgetExceeded
from app.main import app
from app.models import (
    Asset,
    AssetStatus,
    ChunkSource,
    CopilotQuestion,
    DocChunk,
    Event,
    EventSource,
    LlmCall,
    Report,
    User,
    World,
)
from app.rag import index as rag_index
from app.rag.answer import COPILOT_AGENT, NOT_IN_RECORD
from app.rag.embed import EMBED_AGENT, HashEmbedder, LlmEmbedder, Purpose
from app.rag.index import EVENTS_PER_ASSET, IndexStats, index_assets
from app.rag.retrieve import retrieve, visible_assets
from app.rag.service import CopilotModels, CopilotRateLimited, reserve_question
from app.routers.copilot import copilot_models_dep
from app.sandbox import create_world
from app.seed import seed
from app.services.rating import rate_asset
from app.tools.earth_obs import load_site_metrics
from tests.conftest import alembic_cfg, requires_db
from tests.rag_fakes import FakeTokenFactory, MemoryLog, draft, fake_client
from tests.worlds import drop_worlds, start_demo

HERO = "wetland_mx"
PRICE_DROP = "Why did the price drop?"


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so test worlds never persist."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, use_mocks=True)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


class CountingEmbedder(HashEmbedder):
    def __init__(self) -> None:
        self.calls: list[int] = []

    def embed(
        self, texts: Sequence[str], *, purpose: Purpose, world_id: UUID | None
    ) -> list[list[float]]:
        self.calls.append(len(texts))
        return super().embed(texts, purpose=purpose, world_id=world_id)


def events_of(res: Any) -> list[dict[str, Any]]:
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/event-stream")
    return [
        json.loads(line.removeprefix("data: "))
        for line in res.text.splitlines()
        if line.startswith("data: ")
    ]


def ask(client: TestClient, question: str, asset_id: UUID | None = None) -> list[dict[str, Any]]:
    body: dict[str, Any] = {"question": question}
    if asset_id is not None:
        body["asset_id"] = str(asset_id)
    return events_of(client.post("/copilot", json=body))


def done(events: list[dict[str, Any]]) -> dict[str, Any]:
    assert events[-1]["type"] == "done", events
    return events[-1]


def wetland(session: Session, world_id: UUID) -> Asset:
    return session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.site_key == HERO)
    ).one()


def encroach(session: Session, world_id: UUID, title: str | None = None) -> Event:
    """Report v2 from the encroachment scenario plus the news event behind it."""
    asset = wetland(session, world_id)
    rate_asset(
        session,
        world_id,
        asset,
        metrics=load_site_metrics(HERO, "encroachment"),
        as_of=date(2026, 10, 1),
    )
    event = Event(
        world_id=world_id,
        asset_id=asset.id,
        source=EventSource.TAVILY,
        title=title or "Industrial park expansion cleared near Xochimilco wetlands",
        summary="State approved a 40-ha industrial park expansion bordering the wetland.",
        impact_type="encroachment",
        direction=-1,
        severity=4,
        published_at=date(2026, 9, 12),
    )
    session.add(event)
    session.commit()
    return event


def ref_of(event: Event) -> str:
    return f"E{event.id.hex[:8]}"


# --- the hero question ---------------------------------------------------------------------


@requires_db
def test_why_did_the_price_drop_cites_the_encroachment_event(
    client: TestClient, session: Session
) -> None:
    world = start_demo(client, session)
    event = encroach(session, world.id)
    asset = wetland(session, world.id)

    events = ask(client, PRICE_DROP, asset.id)

    assert [e["type"] for e in events][0] == "sources"
    assert {e["type"] for e in events[1:-1]} == {"delta"}
    final = done(events)
    assert final["mode"] == "extractive"
    cited = {c["ref"]: c for c in final["citations"]}
    assert ref_of(event) in cited
    assert cited[ref_of(event)]["event_id"] == str(event.id)
    assert cited[ref_of(event)]["kind"] == "event"
    assert f"[{ref_of(event)}]" in final["answer"]
    assert "".join(e["text"] for e in events[1:-1]) == final["answer"]
    assert all(c["asset_id"] == str(asset.id) for c in final["citations"])


@requires_db
def test_a_world_wide_question_finds_the_event_too(client: TestClient, session: Session) -> None:
    world = start_demo(client, session)
    event = encroach(session, world.id)

    final = done(ask(client, PRICE_DROP))

    assert ref_of(event) in {c["ref"] for c in final["citations"]}


@requires_db
def test_a_question_the_record_does_not_answer_is_refused(
    client: TestClient, session: Session
) -> None:
    world = start_demo(client, session)
    encroach(session, world.id)

    events = ask(client, "What is the capital of France?")

    assert events[0] == {"type": "sources", "sources": []}
    final = done(events)
    assert (final["mode"], final["answer"], final["citations"]) == ("refusal", NOT_IN_RECORD, [])


@pytest.mark.parametrize("question", ["", "   ", "x" * 501])
@requires_db
def test_blank_and_overlong_questions_are_rejected(
    client: TestClient, session: Session, question: str
) -> None:
    start_demo(client, session)

    assert client.post("/copilot", json={"question": question}).status_code == 422


# --- isolation -----------------------------------------------------------------------------


@requires_db
def test_chunks_of_another_world_are_never_retrieved(client: TestClient, session: Session) -> None:
    mine = start_demo(client, session)
    other = create_world(session)
    secret = encroach(session, other.id, title="Volcanic eruption buries the wetland canals")
    embedder = HashEmbedder()
    other_assets = visible_assets(session, None, other.id)
    index_assets(session, other.id, other_assets, embedder)
    session.commit()
    assert session.exec(select(DocChunk).where(DocChunk.event_id == secret.id)).first()

    final = done(ask(client, "Did a volcanic eruption bury the canals?"))
    # Even handed the other world's asset IDs, retrieval only reads the caller's world.
    leaked = retrieve(
        session,
        mine.id,
        {a.id: a.name for a in other_assets},
        embedder.model,
        embedder.embed(["volcanic eruption"], purpose="query", world_id=mine.id)[0],
        min_similarity=0.0,
    )

    assert secret.id not in {c.get("event_id") for c in final["citations"]}
    assert "Volcanic" not in final["answer"]
    assert leaked == []
    other_asset = wetland(session, other.id)
    res = client.post("/copilot", json={"question": "why?", "asset_id": str(other_asset.id)})
    assert (res.status_code, res.json()["detail"]) == (404, "not_found")


def _first_community_asset(session: Session, world: World) -> Asset:
    asset = session.exec(
        select(Asset).where(Asset.world_id == world.id).order_by(Asset.site_key)
    ).first()
    assert asset is not None and asset.community_id is not None
    return asset


@requires_db
@pytest.mark.parametrize(
    "private",
    [
        pytest.param({"status": AssetStatus.NEEDS_EVIDENCE}, id="under-review"),
        pytest.param({"status": AssetStatus.LISTED, "ipo_at": None}, id="listed-not-launched"),
    ],
)
def test_a_private_listing_is_retrieved_only_by_its_community_and_admins(
    client: TestClient, session: Session, private: dict[str, Any]
) -> None:
    world = create_world(session)
    hidden = _first_community_asset(session, world)
    session.add(
        Event(
            world_id=world.id,
            asset_id=hidden.id,
            source=EventSource.EVIDENCE,
            title="Pipeline route approved through the reserve",
            summary="A pipeline route through the reserve was approved.",
            impact_type="infrastructure",
            direction=-1,
            severity=3,
        )
    )
    session.execute(update(Asset).where(col(Asset.id) == hidden.id).values(**private))
    session.commit()
    question = "Was a pipeline route approved through the reserve?"

    seen: dict[str, set[str]] = {}
    for persona in ("arjun", "rosa", "admin"):
        start_demo(client, session, world, persona_key=persona)
        events = ask(client, question)
        seen[persona] = {s["asset_id"] for s in events[0]["sources"]} | {
            c["asset_id"] for c in done(events)["citations"]
        }

    assert str(hidden.id) not in seen["arjun"]
    assert str(hidden.id) in seen["rosa"]
    assert str(hidden.id) in seen["admin"]


# --- the index ------------------------------------------------------------------------------


@requires_db
def test_indexing_is_idempotent_and_world_copies_reuse_vectors(session: Session) -> None:
    first, second = create_world(session), create_world(session)
    embedder = CountingEmbedder()

    built = index_assets(session, first.id, visible_assets(session, None, first.id), embedder)
    again = index_assets(session, first.id, visible_assets(session, None, first.id), embedder)
    copied = index_assets(session, second.id, visible_assets(session, None, second.id), embedder)

    assert built.added > 0 and built.embedded > 0
    assert (again.added, again.removed, again.embedded) == (0, 0, 0)
    assert copied.added == built.added and copied.embedded == 0
    assert copied.reused == copied.added
    assert sum(embedder.calls) == built.embedded
    rows = session.exec(
        select(func.count()).select_from(DocChunk).where(DocChunk.world_id == first.id)
    ).one()
    assert rows == built.added


@requires_db
def test_a_new_report_indexes_only_what_changed(session: Session) -> None:
    world = create_world(session)
    embedder = CountingEmbedder()
    index_assets(session, world.id, visible_assets(session, None, world.id), embedder)

    encroach(session, world.id)
    stats = index_assets(session, world.id, visible_assets(session, None, world.id), embedder)

    report = session.exec(
        select(Report).where(Report.world_id == world.id, Report.version == 2)
    ).one()
    new_chunks = session.exec(select(DocChunk).where(DocChunk.report_id == report.id)).all()
    assert stats.removed == 0
    assert stats.added == len(new_chunks) + 1  # the report's chunks and the event's
    assert "fell" in new_chunks[0].content


# --- the model path, budget and rate limits --------------------------------------------------


def _use_models(models: CopilotModels, **settings: Any) -> None:
    app.dependency_overrides[copilot_models_dep] = lambda: models
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, use_mocks=False, **settings
    )


@requires_db
def test_the_model_answer_is_streamed_with_only_retrieved_citations(
    client: TestClient, session: Session
) -> None:
    world = start_demo(client, session)
    event = encroach(session, world.id)
    ref = ref_of(event)
    transport = FakeTokenFactory(
        draft(f"An encroachment event of severity 4 was reported [{ref}] [E00000000]."),
    )
    llm, log = fake_client(transport)

    _use_models(CopilotModels(LlmEmbedder(llm), llm))

    events = ask(client, PRICE_DROP, wetland(session, world.id).id)
    final = done(events)

    assert events[0]["type"] == "sources"
    assert final["mode"] == "model"
    assert final["model"] == "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
    assert final["answer"] == f"An encroachment event of severity 4 was reported [{ref}]."
    assert [c["ref"] for c in final["citations"]] == [ref]
    assert [(r.agent, r.status) for r in log.rows if r.agent == COPILOT_AGENT] == [
        (COPILOT_AGENT, "ok")
    ]
    embeds = [r for r in log.rows if r.agent == "copilot_embed"]
    assert embeds and all(r.world_id == world.id and r.status == "ok" for r in embeds)


@requires_db
def test_an_exhausted_budget_is_a_503_before_streaming(
    client: TestClient, session: Session
) -> None:
    world = start_demo(client, session)
    llm, log = fake_client(FakeTokenFactory(), MemoryLog(budget_exhausted=True))

    _use_models(CopilotModels(LlmEmbedder(llm), llm))

    res = client.post("/copilot", json={"question": PRICE_DROP})

    assert (res.status_code, res.json()["detail"]) == (503, "copilot_unavailable")
    assert log.rows == []
    chunks = session.exec(
        select(func.count()).select_from(DocChunk).where(DocChunk.world_id == world.id)
    ).one()
    assert chunks == 0  # nothing indexed without an embedding


@requires_db
def test_each_world_has_an_hourly_copilot_call_limit_embeddings_included(
    client: TestClient, session: Session
) -> None:
    world = start_demo(client, session)
    for agent in (COPILOT_AGENT, EMBED_AGENT):
        session.add(LlmCall(world_id=world.id, agent=agent, created_at=datetime.now(UTC)))
    session.add(LlmCall(world_id=world.id, agent="report_summary", created_at=datetime.now(UTC)))
    session.commit()
    llm, _ = fake_client(FakeTokenFactory())

    _use_models(CopilotModels(LlmEmbedder(llm), llm), copilot_calls_per_world_per_hour=2)

    res = client.post("/copilot", json={"question": PRICE_DROP})

    assert (res.status_code, res.json()["detail"]) == (429, "copilot_rate_limited")


@requires_db
def test_each_account_has_an_hourly_question_limit(client: TestClient, session: Session) -> None:
    world = start_demo(client, session)
    ref = ref_of(encroach(session, world.id))
    llm, _ = fake_client(FakeTokenFactory(draft(f"Encroachment was reported [{ref}].")))
    _use_models(CopilotModels(LlmEmbedder(llm), llm), copilot_questions_per_user_per_hour=1)

    first = client.post("/copilot", json={"question": PRICE_DROP})
    second = client.post("/copilot", json={"question": PRICE_DROP})
    start_demo(client, session, world, persona_key="rosa")
    other_user = client.post("/copilot", json={"question": "What is the capital of France?"})

    assert done(events_of(first))["mode"] == "model"
    assert (second.status_code, second.json()["detail"]) == (429, "copilot_rate_limited")
    assert done(events_of(other_user))["mode"] == "refusal"
    asked = session.exec(
        select(func.count())
        .select_from(CopilotQuestion)
        .where(CopilotQuestion.world_id == world.id)
    ).one()
    assert asked == 2


@requires_db
def test_each_world_has_an_hourly_question_limit(client: TestClient, session: Session) -> None:
    world = start_demo(client, session)
    rosa = session.exec(
        select(User).where(User.world_id == world.id, User.persona_key == "rosa")
    ).one()
    session.add(CopilotQuestion(world_id=world.id, user_id=rosa.id))
    session.commit()
    llm, _ = fake_client(FakeTokenFactory())
    _use_models(CopilotModels(LlmEmbedder(llm), llm), copilot_questions_per_world_per_hour=1)

    res = client.post("/copilot", json={"question": PRICE_DROP})

    assert (res.status_code, res.json()["detail"]) == (429, "copilot_rate_limited")


@requires_db
def test_the_copilot_never_spends_the_llm_reserve(client: TestClient, session: Session) -> None:
    start_demo(client, session)
    llm, log = fake_client(FakeTokenFactory(), llm_budget_usd=5.0, llm_reserve_usd=6.0)
    _use_models(CopilotModels(LlmEmbedder(llm), llm), llm_budget_usd=5.0, llm_reserve_usd=6.0)

    res = client.post("/copilot", json={"question": PRICE_DROP})

    assert (res.status_code, res.json()["detail"]) == (503, "copilot_unavailable")
    assert log.rows == []


# --- index: windows, caps, partial failures, concurrency ------------------------------------


@requires_db
def test_events_falling_out_of_the_window_are_removed(session: Session) -> None:
    world = create_world(session)
    asset = wetland(session, world.id)
    base = datetime(2026, 9, 1, tzinfo=UTC)

    def add_event(day: int) -> Event:
        event = Event(
            world_id=world.id,
            asset_id=asset.id,
            source=EventSource.TAVILY,
            title=f"Local news item number {day}",
            created_at=base + timedelta(days=day),
        )
        session.add(event)
        return event

    events = [add_event(day) for day in range(EVENTS_PER_ASSET)]
    session.commit()
    index_assets(session, world.id, [asset], HashEmbedder())
    oldest = events[0]
    assert session.exec(select(DocChunk).where(DocChunk.event_id == oldest.id)).first()

    newest = add_event(EVENTS_PER_ASSET)
    session.commit()
    stats = index_assets(session, world.id, [asset], HashEmbedder())

    assert (stats.removed, stats.added) == (1, 1)
    assert session.exec(select(DocChunk).where(DocChunk.event_id == oldest.id)).first() is None
    assert session.exec(select(DocChunk).where(DocChunk.event_id == newest.id)).first()


class FailingAfter(CountingEmbedder):
    """Embeds `ok` requests, then fails like an exhausted budget."""

    def __init__(self, ok: int) -> None:
        super().__init__()
        self.ok = ok

    def embed(
        self, texts: Sequence[str], *, purpose: Purpose, world_id: UUID | None
    ) -> list[list[float]]:
        if len(self.calls) >= self.ok:
            self.calls.append(-len(texts))
            raise BudgetExceeded("over budget")
        return super().embed(texts, purpose=purpose, world_id=world_id)


def _vectors(session: Session, world_id: UUID) -> tuple[int, int]:
    """(rows with an embedding, claims without one) in the world."""
    rows = session.exec(select(DocChunk.embedding).where(DocChunk.world_id == world_id)).all()
    return sum(1 for r in rows if r is not None), sum(1 for r in rows if r is None)


@requires_db
def test_a_failed_batch_keeps_the_batches_already_paid_for(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rag_index, "EMBED_BATCH", 2)
    world = create_world(session)
    assets = visible_assets(session, None, world.id)
    failing = FailingAfter(ok=1)

    first = index_assets(session, world.id, assets, failing)

    assert (first.embedded, first.added) == (2, 2)
    assert first.skipped > 0
    assert _vectors(session, world.id) == (2, 0)  # failed claims are released
    retry = CountingEmbedder()
    second = index_assets(session, world.id, assets, retry)
    assert sum(retry.calls) == second.embedded == first.skipped  # nothing paid twice
    assert _vectors(session, world.id) == (2 + second.added, 0)


@requires_db
def test_each_question_embeds_at_most_the_cap(session: Session) -> None:
    world = create_world(session)
    assets = visible_assets(session, None, world.id)
    embedder = CountingEmbedder()

    first = index_assets(session, world.id, assets, embedder, max_embed=2)
    rest = index_assets(session, world.id, assets, embedder)

    assert first.embedded == 2 and first.skipped > 0
    assert rest.embedded == first.skipped
    assert sum(embedder.calls) == first.embedded + rest.embedded


@requires_db
def test_a_busy_index_lock_is_skipped_not_waited_on(session: Session) -> None:
    world = create_world(session)
    assets = visible_assets(session, None, world.id)
    embedder = CountingEmbedder()
    engine = create_engine(get_settings().database_url)
    with engine.connect() as holder:
        holder.execute(
            text("SELECT pg_advisory_xact_lock(:ns, hashtext(:world))"),
            {"ns": rag_index.INDEX_LOCK_NAMESPACE, "world": str(world.id)},
        )
        started = time.monotonic()
        stats = index_assets(session, world.id, assets, embedder, lock_wait_s=0.2)
        waited = time.monotonic() - started
        holder.rollback()
    engine.dispose()

    assert stats.busy and waited < 1.5
    assert embedder.calls == []


class GatedEmbedder(CountingEmbedder):
    """Blocks inside `embed` until released, to hold a request mid-embedding."""

    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def embed(
        self, texts: Sequence[str], *, purpose: Purpose, world_id: UUID | None
    ) -> list[list[float]]:
        self.entered.set()
        assert self.release.wait(10)
        return super().embed(texts, purpose=purpose, world_id=world_id)


@requires_db
def test_two_questions_at_once_neither_wait_nor_embed_twice() -> None:
    command.upgrade(alembic_cfg(), "head")
    with Session(db_engine) as setup:
        seed(setup)
        world_id = create_world(setup).id
    slow, fast = GatedEmbedder(), CountingEmbedder()
    results: dict[str, IndexStats] = {}

    def first() -> None:
        with Session(db_engine) as s:
            results["first"] = index_assets(s, world_id, visible_assets(s, None, world_id), slow)

    thread = threading.Thread(target=first)
    try:
        thread.start()
        assert slow.entered.wait(10), "the first request is embedding"
        started = time.monotonic()
        with Session(db_engine) as s:
            second = index_assets(s, world_id, visible_assets(s, None, world_id), fast)
        waited = time.monotonic() - started
        slow.release.set()
        thread.join(10)
        assert not thread.is_alive()

        assert waited < 1.5 and not second.busy
        assert second.embedded == 0 and fast.calls == []  # the first request's claims stand
        assert results["first"].embedded == sum(slow.calls) > 0
        with Session(db_engine) as s:
            assert _vectors(s, world_id) == (results["first"].added, 0)
    finally:
        slow.release.set()
        thread.join(10)
        drop_worlds(db_engine, [world_id])


@requires_db
def test_concurrent_questions_cannot_both_take_the_last_slot() -> None:
    command.upgrade(alembic_cfg(), "head")
    with Session(db_engine) as setup:
        seed(setup)
        world = create_world(setup)
        world_id = world.id
        users = [u.id for u in setup.exec(select(User).where(User.world_id == world_id)).all()][:4]
    settings = Settings(_env_file=None, copilot_questions_per_world_per_hour=1)
    barrier = threading.Barrier(len(users))
    outcomes: list[str] = []

    def ask_once(user_id: UUID) -> None:
        with Session(db_engine) as s:
            barrier.wait(5)
            try:
                reserve_question(s, world_id, user_id, settings, datetime.now(UTC))
                outcomes.append("ok")
            except CopilotRateLimited:
                outcomes.append("limited")

    threads = [threading.Thread(target=ask_once, args=(u,)) for u in users]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        assert sorted(outcomes) == ["limited"] * (len(users) - 1) + ["ok"]
    finally:
        drop_worlds(db_engine, [world_id])


# --- schema ---------------------------------------------------------------------------------


@requires_db
@pytest.mark.parametrize(
    "fields",
    [
        {"source_kind": "report"},  # neither report nor event
        {"source_kind": "event", "report": True},
        {"source_kind": "report", "report": True, "event": True},
        {"source_kind": "note", "report": True},
    ],
)
def test_a_chunk_must_name_exactly_its_one_source(session: Session, fields: dict[str, Any]) -> None:
    world = create_world(session)
    event = encroach(session, world.id)
    report = session.exec(select(Report).where(Report.world_id == world.id)).first()
    assert report is not None
    with pytest.raises(IntegrityError, match="ck_doc_chunks"), session.begin_nested():
        session.execute(
            text(
                "INSERT INTO doc_chunks (id, world_id, asset_id, source_kind, report_id, "
                "event_id, seq, content, content_sha256, embed_model) VALUES (gen_random_uuid(), "
                ":world, :asset, :kind, :report, :event, 0, 'x', :sha, 'm')"
            ),
            {
                "world": world.id,
                "asset": event.asset_id,
                "kind": fields["source_kind"],
                "report": report.id if fields.get("report") else None,
                "event": event.id if fields.get("event") else None,
                "sha": "0" * 64,
            },
        )


@requires_db
def test_a_chunk_cannot_name_another_worlds_asset(session: Session) -> None:
    mine, other = create_world(session), create_world(session)
    event = encroach(session, mine.id)
    with pytest.raises(IntegrityError, match="fk_doc_chunks_asset"), session.begin_nested():
        session.add(
            DocChunk(
                world_id=mine.id,
                asset_id=wetland(session, other.id).id,
                source_kind=ChunkSource.EVENT,
                event_id=event.id,
                content="x",
                content_sha256="0" * 64,
                embed_model="m",
            )
        )
        session.flush()
