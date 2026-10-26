"""Build the template world's showcase: real places, their ratings and a year of trading.

Run once, on a database whose template world holds only the seed (`make seed`), with live
models and live Earth Engine:

    cd backend && USE_MOCKS=false EARTH_ENGINE_LIVE=true \\
        uv run python -m app.jobs.build_template_sites

Sandboxes copy the result (`app.sandbox`), so every visitor sees it, and a database dump
carries it to another environment. Every number comes from the product's own code: boundaries
from OpenStreetMap (`data/template_sites.json`), Earth Engine observations for each rating's
quarter (`ObservationWindow`), News Scout (Tavily, once per listing, each rating seeing only
what was published by its date), the rating runner (Nemotron) for each report, the offer
review for each launch and the market engine for each trade. The people and communities are
fictional.

Each step runs now; its rows are then moved to the step's date (`_shift`), so the history reads
as the year it describes. Steps run in date order, so moved rows keep their order.
"""

from __future__ import annotations

import json
import logging
import random
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_DOWN, Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import ee
from sqlalchemy import text
from sqlmodel import Session, col, select

from app.agents.news_scout import NewsScoutAsset
from app.communities import add_member, create_community
from app.config import Settings, get_settings
from app.db import engine
from app.market.engine import Position, execute
from app.market.offering import MAX_TOTAL_SHARES, MIN_TOTAL_SHARES, Offering
from app.models import (
    Asset,
    Community,
    CommunityRole,
    OrderSide,
    Price,
    Report,
    User,
    UserKind,
    UserRole,
    World,
)
from app.routers.market import _holding, _lock_world, _order_rows, _tradable_market
from app.schemas import NewsScoutOutput
from app.seed import DEMO_SITES, PERSONAS
from app.seed import WORLD_ID as TEMPLATE
from app.services import ipo, offers
from app.services.earth_obs_live import LiveEarthObs, LiveMetricsError, live_site_key
from app.services.listings import ListingDetails, ListingSubmit, create_draft
from app.services.rating import latest_report
from app.services.rating_runs import (
    InlineExecutor,
    RatingRunner,
    build_runner,
    get_run,
    investigator_for,
    news_runner,
)
from app.tools.earth_engine import (
    CURRENT_WINDOW,
    ObservationWindow,
    compute_polygon_metrics,
    init_ee,
)
from app.tools.earth_obs import EarthObsMetrics
from app.tools.geometry import bare_geometry, geometry_sha256

log = logging.getLogger("build_template_sites")

EE_ATTEMPTS = 6
UNIT_PRICE = Decimal(50)
DATA = Path(__file__).resolve().parents[2] / "data" / "template_sites.json"
CURATED = {"celestun": "mangrove_mx", "xochimilco": "wetland_mx", "sumidero": "restoration_forest"}
SHIFTED: dict[str, tuple[str, ...]] = {
    "alert_recipients": ("created_at", "read_at"),
    "alerts": ("created_at",),
    "asset_overlays": ("created_at",),
    "asset_views": ("created_at",),
    "assets": ("created_at", "attested_at", "submitted_at", "offer_sent_at", "ipo_at"),
    "communities": ("created_at",),
    "community_members": ("created_at",),
    "doc_chunks": ("created_at",),
    "events": ("created_at",),
    "field_evidence_photos": ("created_at", "analysed_at"),
    "ledger_entries": ("created_at",),
    "metrics": ("created_at",),
    "orders": ("created_at",),
    "prices": ("ts",),
    "reports": ("created_at",),
    "world_events": ("created_at",),
}
"""Every timestamp a step writes in a world (dates of observations and news stay as they are)."""


def say(message: str) -> None:
    print(f"[{datetime.now(UTC):%H:%M:%S}] {message}", flush=True)


def when(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _shift_json(value: Any, since: datetime, delta: timedelta) -> Any:
    """`value` with every ISO timestamp written since `since` moved by `delta`."""
    if isinstance(value, str) and len(value) >= 19 and value[4] == "-" and "T" in value:
        try:
            moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
        if moment.tzinfo is not None and moment >= since:
            return (moment + delta).isoformat()
        return value
    if isinstance(value, list):
        return [_shift_json(item, since, delta) for item in value]
    if isinstance(value, dict):
        return {key: _shift_json(item, since, delta) for key, item in value.items()}
    return value


def _shift(session: Session, since: datetime, to: datetime) -> None:
    """Move every template row written since `since` so the step starts at `to`. The ledger's
    append-only trigger is bypassed for this one transaction (its hashes don't cover times)."""
    delta = to - since
    session.execute(text("SET LOCAL session_replication_role = replica"))
    for table, columns in SHIFTED.items():
        for column in columns:
            session.execute(
                text(
                    f"UPDATE {table} SET {column} = {column} + :delta "
                    f"WHERE world_id = :world AND {column} >= :since"
                ),
                {"delta": delta, "world": TEMPLATE, "since": since},
            )
    moved = session.exec(
        select(Report).where(Report.world_id == TEMPLATE, col(Report.created_at) >= to)
    ).all()
    for report in moved:
        if report.auditor_json is not None:
            report.auditor_json = _shift_json(report.auditor_json, since, delta)
            session.add(report)
    session.commit()


@dataclass
class Builder:
    settings: Settings
    runner: RatingRunner
    live: LiveEarthObs
    data: dict[str, Any]
    users: dict[str, UUID] = field(default_factory=dict)
    communities: dict[str, UUID] = field(default_factory=dict)
    assets: dict[str, UUID] = field(default_factory=dict)
    news_seen: dict[str, NewsScoutOutput] = field(default_factory=dict)
    news_file: Path | None = None
    as_of: date = date(2025, 10, 1)

    def session(self) -> Session:
        return Session(engine)

    def at(self, moment: datetime, label: str, step: Callable[[], None]) -> None:
        since = datetime.now(UTC) - timedelta(seconds=2)
        say(f"{moment:%Y-%m-%d %H:%M} {label}")
        step()
        with self.session() as session:
            _shift(session, since, moment)

    # --- people and communities ---

    def people(self) -> None:
        with self.session() as session:
            for persona in PERSONAS:
                self.users[persona.key] = persona.id
            for person in self.data["people"]:
                user = User(
                    world_id=TEMPLATE,
                    name=person["name"],
                    role=UserRole(person["role"]),
                    kind=UserKind.PERSON,
                )
                session.add(user)
                session.flush()
                self.users[person["key"]] = user.id
            session.commit()

    def community(self, spec: dict[str, Any]) -> None:
        with self.session() as session:
            community = create_community(
                session,
                TEMPLATE,
                spec["name"],
                self.users[spec["owner"]],
                country=spec["country"],
                description=spec["description"],
            )
            self.communities[spec["key"]] = community.id
            session.commit()

    def steward(self, community_key: str, person: str) -> None:
        with self.session() as session:
            community = session.get_one(Community, self.communities[community_key])
            add_member(session, community, self.users[person], CommunityRole.STEWARD)
            session.commit()

    # --- listings, ratings and offers ---

    def draft(self, spec: dict[str, Any]) -> None:
        with self.session() as session:
            asset = create_draft(
                session,
                world_id=TEMPLATE,
                community_id=self.communities[spec["community"]],
                details=ListingDetails(
                    name=spec["name"],
                    country=spec["country"],
                    description=spec["description"],
                    geojson=spec["geojson"],
                ),
            )
            session.commit()
            self.assets[spec["key"]] = asset.id

    def geojson(self, key: str) -> dict[str, Any]:
        """The listing's stored boundary, as the draft normalized it: caches and views key on it."""
        with self.session() as session:
            return dict(session.get_one(Asset, self.assets[key]).geojson)

    def metrics(self, spec: dict[str, Any], window_end: str, moment: datetime) -> EarthObsMetrics:
        """The listing's observations over the quarter before `window_end`; the current quarter's
        are cached, so a sandbox's own re-rate of the listing reuses them."""
        window = ObservationWindow.ending(date.fromisoformat(window_end))
        geojson = self.geojson(spec["key"])

        def compute() -> EarthObsMetrics:
            if window == CURRENT_WINDOW:
                return self.live.compute_fresh(geojson)[0]
            document = compute_polygon_metrics(
                bare_geometry(geojson),
                site_key=live_site_key(geometry_sha256(geojson)),
                window=window,
            )
            return EarthObsMetrics.model_validate(document)

        # A large valley's 60 monthly NDVI reductions can hit the project's concurrent
        # aggregation limit; it clears within a minute or two.
        for attempt in range(1, EE_ATTEMPTS + 1):
            try:
                metrics = compute()
                break
            except (ee.EEException, LiveMetricsError) as exc:
                if attempt == EE_ATTEMPTS:
                    raise
                say(f"  Earth Engine: {type(exc).__name__}; retrying in {45 * attempt} s")
                time.sleep(45 * attempt)
        return metrics.model_copy(update={"computed_at_utc": moment.isoformat()})

    def rate(self, spec: dict[str, Any], window_end: str, moment: datetime, *, first: bool) -> None:
        metrics = self.metrics(spec, window_end, moment)
        self.as_of = moment.date()
        self.runner.today = lambda: moment.date()
        investigate = window_end in spec.get("investigate", [])
        self.runner.investigator = investigator_for(self.settings) if investigate else None
        asset_id = self.assets[spec["key"]]
        if first:
            run_id = self.runner.start(
                TEMPLATE,
                asset_id,
                trigger="listing",
                on_queue=ListingSubmit(metrics.data_version),
                metrics=metrics,
                inline=True,
            )
        else:
            run_id = self.runner.start(
                TEMPLATE,
                asset_id,
                trigger="scheduled",
                metrics=metrics,
                inline=True,
                max_runs_per_hour=1000,
            )
        with self.session() as session:
            run = get_run(session, TEMPLATE, run_id)
            asset = session.get_one(Asset, asset_id)
            if run is None or run.report_id is None:
                raise RuntimeError(f"{spec['name']}: the rating run failed ({run})")
            say(
                f"  {spec['name']}: {run.status.value} grade {run.grade} health "
                f"{run.health_score} confidence {run.confidence} → {asset.status.value}"
            )

    def news(self, scout_asset: NewsScoutAsset, llm: Any) -> NewsScoutOutput:
        """News Scout once per listing (Tavily's credits are scarce); each rating then sees only
        what was published by its date."""
        if scout_asset.name not in self.news_seen:
            self.news_seen[scout_asset.name] = news_runner(self.settings)(scout_asset, llm)
            if self.news_file is not None:
                self.news_file.write_text(
                    json.dumps({k: v.model_dump(mode="json") for k, v in self.news_seen.items()})
                )
        seen = self.news_seen[scout_asset.name]
        latest = self.as_of >= date.fromisoformat(CURRENT_WINDOW.end)
        kept = [
            event
            for event in seen.events
            if (event.published_at <= self.as_of if event.published_at else latest)
        ]
        funnel = seen.funnel.model_copy(update={"kept": len(kept)}) if seen.funnel else None
        return seen.model_copy(update={"events": kept, "funnel": funnel})

    def send_offer(self, key: str, total_shares: int | str, retained_pct: str) -> None:
        with self.session() as session:
            asset = session.get_one(Asset, self.assets[key])
            report = latest_report(session, TEMPLATE, asset.id)
            if total_shares == "auto":
                total_shares = _units(asset, report, Decimal(retained_pct))
            offering = Offering(int(total_shares), Decimal(retained_pct))
            quote = ipo.quote(asset, report, offering)
            offers.send(session, TEMPLATE, asset.id, offering, expected_price=quote.terms.price)
            session.commit()
            say(f"  offer: {total_shares:,} units at {quote.terms.price}, keeps {retained_pct}%")

    def send_back(self, key: str, note: str) -> None:
        with self.session() as session:
            asset = session.get_one(Asset, self.assets[key])
            assert asset.offer_sent_at is not None
            offers.send_back(session, TEMPLATE, asset.id, sent_at=asset.offer_sent_at, note=note)
            session.commit()

    def approve(self, key: str) -> None:
        with self.session() as session:
            asset = session.get_one(Asset, self.assets[key])
            assert asset.offer_sent_at is not None
            offers.approve(session, TEMPLATE, asset.id, sent_at=asset.offer_sent_at)
            session.commit()

    def render(self, key: str) -> None:
        """The listing's land-cover overlay and before/after views (a rating with given metrics
        doesn't start them)."""
        geojson = self.geojson(key)
        for renderer in (self.runner.live_overlays, self.runner.live_views):
            job = renderer.start(TEMPLATE, self.assets[key], geojson) if renderer else None
            if job is not None and not job.wait():
                say(f"  {key}: a render did not finish")

    # --- trades ---

    def trade(self, person: str, side: OrderSide, key: str, how: dict[str, Any]) -> None:
        """One market order, persisted the way `POST /orders` does."""
        with self.session() as session:
            _lock_world(session, TEMPLATE)
            asset = session.exec(
                select(Asset).where(Asset.id == self._asset_id(session, key)).with_for_update()
            ).one()
            actor = session.exec(
                select(User).where(User.id == self.users[person]).with_for_update()
            ).one()
            market = _tradable_market(session, asset)
            holding = _holding(session, TEMPLATE, actor.id, asset.id)
            if side is OrderSide.BUY:
                budget = min(Decimal(str(how["budget"])), actor.cash_balance * Decimal("0.95"))
                qty = int((budget / (market.price * Decimal("1.02"))).to_integral(ROUND_DOWN))
            else:
                qty = int(holding.shares * how["fraction"])
            if qty < 1:
                say(f"  skipped: {person} {side.value} {key} (nothing to trade)")
                return
            position = Position(
                cash=actor.cash_balance, shares=holding.shares, avg_cost=holding.avg_cost
            )
            result = execute(market, position, side, qty)
            asset.primary_shares_remaining = result.market.primary_shares_remaining
            asset.community_wallet = result.market.community_wallet
            actor.cash_balance = result.trader.cash
            holding.shares = result.trader.shares
            holding.avg_cost = result.trader.avg_cost
            orders = _order_rows(TEMPLATE, actor.id, asset.id, side, qty, result)
            price = Price(
                world_id=TEMPLATE,
                asset_id=asset.id,
                price=result.price_change.price,
                reason=result.price_change.reason.value,
            )
            session.add_all([asset, actor, holding, *orders, price])
            session.commit()
            say(f"  {person} {side.value}s {qty} {key} at {result.fill_price} → {price.price}")

    def _asset_id(self, session: Session, key: str) -> UUID:
        if key in CURATED:
            site = next(site for site in DEMO_SITES if site.key == CURATED[key])
            return site.id
        return self.assets[key]


def _units(asset: Asset, report: Report | None, retained_pct: Decimal) -> int:
    """A round number of units (two significant digits) so one costs about `UNIT_PRICE` at the
    rating's fair value: an old-growth forest is valued at hundreds of millions."""
    reference = ipo.quote(asset, report, Offering(asset.total_shares, retained_pct))
    raw = int(reference.terms.price * asset.total_shares / UNIT_PRICE)
    step = 10 ** max(len(str(raw)) - 2, 0)
    units: int = round(raw / step) * step
    return max(MIN_TOTAL_SHARES, min(MAX_TOTAL_SHARES, units))


def _supporter_trades(data: dict[str, Any]) -> list[tuple[datetime, str, OrderSide, str, Any]]:
    """The supporters' trades (`supporter_trades` in the data): seeded, so a rebuild repeats them.
    A sell is drawn only once the supporter could hold some of the listing."""
    supporters = [p["key"] for p in data["people"] if p["role"] == "investor"]
    out: list[tuple[datetime, str, OrderSide, str, Any]] = []
    for key, rule in data["supporter_trades"].items():
        if key.startswith("_"):
            continue
        rng = random.Random(f"wildworth-template:{key}")
        start, end = when(rule["from"]), when(rule["to"])
        span = (end - start).total_seconds()
        moments = sorted(
            start + timedelta(seconds=rng.uniform(0, span)) for _ in range(rule["count"])
        )
        bought: set[str] = set()
        for moment in moments:
            # US and European daytime, whatever the draw.
            moment = moment.replace(hour=rng.randint(13, 22), minute=rng.randint(0, 59))
            sellers = sorted(bought)
            if sellers and rng.random() < rule["sell_share"]:
                who = rng.choice(sellers)
                fraction = round(rng.uniform(0.25, 0.7), 2)
                out.append((moment, who, OrderSide.SELL, key, {"fraction": fraction}))
            else:
                who = rng.choice(supporters)
                low, high = rule["budget"]
                out.append((moment, who, OrderSide.BUY, key, {"budget": rng.randint(low, high)}))
                bought.add(who)
    return out


def plan(builder: Builder) -> list[tuple[datetime, str, Callable[[], None]]]:
    """Every step of the year, in date order."""
    data = builder.data
    steps: list[tuple[datetime, str, Callable[[], None]]] = []
    for spec in data["communities"]:
        steps.append(
            (when(spec["at"]), f"community {spec['name']}", _bind(builder.community, spec))
        )
        for person, moment in spec["stewards"]:
            steps.append(
                (
                    when(moment),
                    f"{person} joins {spec['key']}",
                    _bind(builder.steward, spec["key"], person),
                )
            )
    for spec in data["listings"]:
        ratings = spec["ratings"]
        listed = when(ratings[0][0])
        steps.append(
            (listed - timedelta(hours=2), f"draft {spec['name']}", _bind(builder.draft, spec))
        )
        for index, (moment, window_end) in enumerate(ratings):
            steps.append(
                (
                    when(moment),
                    f"rate {spec['name']} (quarter to {window_end})",
                    _bind(builder.rate, spec, window_end, when(moment), first=index == 0),
                )
            )
        last = when(ratings[-1][0])
        steps.append(
            (
                last + timedelta(minutes=20),
                f"views of {spec['name']}",
                _bind(builder.render, spec["key"]),
            )
        )
        offer = spec.get("offer")
        if offer:
            shares = offer["total_shares"]
            steps.append(
                (
                    when(offer["sent"]),
                    f"offer {spec['name']}",
                    _bind(builder.send_offer, spec["key"], shares, offer["retained_pct"]),
                )
            )
            if "sent_back" in offer:
                moment, note = offer["sent_back"]
                steps.append(
                    (
                        when(moment),
                        f"sent back {spec['name']}",
                        _bind(builder.send_back, spec["key"], note),
                    )
                )
                again = offer["resent"]
                steps.append(
                    (
                        when(again["at"]),
                        f"offer again {spec['name']}",
                        _bind(builder.send_offer, spec["key"], shares, again["retained_pct"]),
                    )
                )
            if "approved" in offer:
                steps.append(
                    (
                        when(offer["approved"]),
                        f"approve {spec['name']}",
                        _bind(builder.approve, spec["key"]),
                    )
                )
    trades = [
        (when(moment), who, OrderSide(side), key, how)
        for moment, who, side, key, how in data["persona_trades"]
    ] + _supporter_trades(data)
    for moment, who, side, key, how in trades:
        steps.append(
            (moment, f"trade {who} {side.value} {key}", _bind(builder.trade, who, side, key, how))
        )
    return sorted(steps, key=lambda step: step[0])


def _bind(fn: Callable[..., None], *args: Any, **kwargs: Any) -> Callable[[], None]:
    return lambda: fn(*args, **kwargs)


def _check_template(session: Session) -> None:
    if session.get(World, TEMPLATE) is None:
        raise SystemExit("No template world: run `make seed` first.")
    built = session.exec(
        select(Asset.id).where(Asset.world_id == TEMPLATE, col(Asset.site_key).is_(None))
    ).first()
    if built is not None:
        raise SystemExit("The template already holds listings beyond the seed's: nothing to do.")


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    if settings.use_mocks or not settings.earth_engine_live:
        raise SystemExit("Run with USE_MOCKS=false and EARTH_ENGINE_LIVE=true.")
    with Session(engine) as session:
        _check_template(session)
    init_ee(settings.ee_service_account_json)
    runner = build_runner(settings, lambda: Session(engine), InlineExecutor())
    live = runner.live_metrics
    if live is None:
        raise SystemExit("Live Earth Engine is off: check EE_SERVICE_ACCOUNT_JSON.")
    builder = Builder(settings, runner, live, json.loads(DATA.read_text()))
    # Optional: a file keeping News Scout's results, so a retried build spends no credits again.
    if argv := sys.argv[1:] if argv is None else argv:
        builder.news_file = Path(argv[0])
        if builder.news_file.exists():
            saved = json.loads(builder.news_file.read_text())
            builder.news_seen = {k: NewsScoutOutput.model_validate(v) for k, v in saved.items()}
    runner.news = builder.news
    builder.people()
    started = time.monotonic()
    for moment, label, step in plan(builder):
        builder.at(moment, label, step)
    with Session(engine) as session:
        # Progress events are the API's live stream, not history: sealed reports keep traces.
        session.execute(
            text("DELETE FROM world_events WHERE world_id = :world"), {"world": TEMPLATE}
        )
        session.commit()
    say(f"done in {time.monotonic() - started:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
