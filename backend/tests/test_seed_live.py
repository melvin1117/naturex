"""The live-world seed's data and pure helpers (app.jobs.seed_live). The seed itself drives a
running API with live models, so only its plumbing runs here, against a fake transport."""

from __future__ import annotations

import json
import re
import stat
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

from app.config import get_settings
from app.jobs import seed_live
from app.jobs.seed_live import (
    DATA,
    Account,
    Seeder,
    box_polygon,
    buy_qty,
    live_settings_problem,
    retry_after_s,
    sell_qty,
    trade_key,
    write_private,
)
from app.schemas import RegisterIn
from app.seed import SEED_COMMUNITIES
from app.services import ipo
from app.tools.geometry import validate_polygon

SEED = json.loads(DATA.read_text())
ROUNDS = ("trades_round_1", "trades_round_2", "trades_round_3")


def community_names() -> set[str]:
    return {c.get("name") or c["match_name"] for c in SEED["communities"]}


def test_every_listing_belongs_to_a_seeded_community_and_has_land() -> None:
    names = community_names()
    for listing in SEED["listings"]:
        assert listing["community"] in names, listing["name"]
        assert ("box" in listing) != ("geometry" in listing), listing["name"]
        assert "documents" not in listing, "no made-up documents"


def test_handed_over_communities_are_the_curated_ones() -> None:
    curated = {c.name for c in SEED_COMMUNITIES}
    for community in SEED["communities"]:
        if "match_name" in community:
            assert community["match_name"] in curated


def test_every_community_has_an_owner_and_a_steward_who_are_people() -> None:
    people = {p["key"] for p in SEED["people"]}
    owners = [c["owner"] for c in SEED["communities"]]
    assert len(set(owners)) == len(owners), "one community each"
    for community in SEED["communities"]:
        assert community["owner"] in people
        assert community["stewards"]
        assert set(community["stewards"]) <= people


def test_every_boundary_is_valid_and_none_overlap() -> None:
    drawn: list[tuple[Any, dict[str, Any]]] = []
    for index, listing in enumerate(SEED["listings"]):
        geometry = listing.get("geometry") or box_polygon(listing["box"])
        feature = {"type": "Feature", "properties": {}, "geometry": geometry}
        check = validate_polygon(feature, drawn)
        assert check.ok, (listing["name"], check.problems)
        assert not check.overlaps, listing["name"]
        drawn.append((index, feature))


def test_every_account_passes_the_register_routes_checks() -> None:
    """The seed registers in-process (`register_person`), which skips the route's checks."""
    emails = [p["email"] for p in SEED["people"]]
    assert len(set(emails)) == len(emails)
    for p in SEED["people"]:
        RegisterIn(email=p["email"], password="a-long-enough-password", name=p["name"])


def test_trades_name_real_sites_and_sells_follow_buys() -> None:
    sites = {c.site.name for c in SEED_COMMUNITIES} | {item["name"] for item in SEED["listings"]}
    bought: set[tuple[str, str]] = set()
    for round_key in ROUNDS:
        for who, site, side, _amount in SEED[round_key]:
            assert site in sites, site
            if side == "buy":
                bought.add((who, site))
            else:
                assert (who, site) in bought, f"{who} sells {site} before buying it"


def test_supporters_never_trade_their_own_community() -> None:
    """Members can't back their own community's sites (the insider rule), so traders are
    supporters only."""
    members = {c["owner"] for c in SEED["communities"]} | {
        s for c in SEED["communities"] for s in c["stewards"]
    }
    for round_key in ROUNDS:
        for who, _site, side, amount in SEED[round_key]:
            assert who not in members
            assert side in {"buy", "sell"}
            assert amount > 0 and (side == "buy" or amount <= 1)
        keys = [trade_key(round_key, row) for row in SEED[round_key]]
        assert len(set(keys)) == len(keys), "a repeated row would be skipped as done"


def test_the_data_holds_no_secret_and_no_admin() -> None:
    text = DATA.read_text().lower()
    assert "password" not in text.replace("passwords are generated", "")
    assert not re.search(r"\b(sk|key|token)[-_][a-z0-9]{8,}", text)
    assert "admin" not in SEED


def test_a_box_is_a_closed_lon_lat_ring() -> None:
    ring = box_polygon([20.0, -87.5, 20.1, -87.4])["coordinates"][0]
    assert ring[0] == ring[-1] == [-87.5, 20.0]
    assert len(ring) == 5


def test_quantities_round_down_and_never_divide_by_zero() -> None:
    assert buy_qty(900, 21.49) == 41
    assert buy_qty(900, 0) == 0
    assert sell_qty(41, 0.5) == 20
    assert sell_qty(1, 0.3) == 0


def test_retry_after_reads_seconds_and_http_dates() -> None:
    now = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
    assert retry_after_s("30", now=now) == 30
    assert retry_after_s("Thu, 01 Oct 2026 12:00:45 GMT", now=now) == 45
    assert retry_after_s("Thu, 01 Oct 2026 11:00:00 GMT", now=now) == 0
    assert retry_after_s("soon", now=now) == 10
    assert retry_after_s(None) == 10


def test_the_seed_refuses_mocks_and_fake_satellite_data() -> None:
    settings = get_settings()
    live = settings.model_copy(update={"use_mocks": False, "earth_engine_live": True})
    assert live_settings_problem(live) is None
    mocked = live.model_copy(update={"use_mocks": True})
    assert "USE_MOCKS" in (live_settings_problem(mocked) or "")
    offline = live.model_copy(update={"earth_engine_live": False})
    assert "EARTH_ENGINE_LIVE" in (live_settings_problem(offline) or "")


def test_private_files_are_created_owner_only(tmp_path: Path) -> None:
    path = tmp_path / "accounts.json"
    path.write_text("{}")
    path.chmod(0o644)
    write_private(path, {"a@example.com": "x"})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text()) == {"a@example.com": "x"}


def test_the_accounts_file_must_be_git_ignored(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        seed_live.main(["--api", "http://x", "--origin", "http://y", "--accounts-out", "a.json"])


def test_only_the_seed_skips_the_verification_gate() -> None:
    app_dir = Path(seed_live.__file__).resolve().parents[1]
    callers = {
        path.relative_to(app_dir).as_posix()
        for path in app_dir.rglob("*.py")
        if "require_verification" in path.read_text()
    }
    assert callers == {"jobs/seed_live.py", "services/ipo.py"}


class FakeApi:
    """Two open sites, one supporter's portfolio and a community's listing; records every
    order and rating run."""

    def __init__(self) -> None:
        self.orders: list[dict[str, Any]] = []
        self.held = {"site-a": 40}
        self.runs: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/me/communities":
            return httpx.Response(200, json=[{"id": "c1", "name": "Trust"}])
        if path == "/communities/c1/assets":
            # The community list carries no report version (only grade and health).
            listing = {"id": "site-a", "name": "Site A", "status": "listed"}
            return httpx.Response(200, json=[listing])
        if path == "/assets/site-a/rate":
            self.runs.append("run-1")
            return httpx.Response(202, json={"run_id": "run-1", "asset_id": "site-a"})
        if path == "/runs/run-1":
            done = {"status": "succeeded", "version": 3, "grade": "AA"}
            return httpx.Response(200, json={"run_id": "run-1", **done})
        if request.url.path == "/assets":
            return httpx.Response(
                200,
                json=[
                    {"id": "site-a", "name": "Site A", "price": "20.00"},
                    {"id": "site-b", "name": "Site B", "price": None},
                ],
            )
        if request.url.path == "/portfolio":
            holdings = [{"asset_id": k, "shares": v} for k, v in self.held.items()]
            return httpx.Response(200, json={"holdings": holdings})
        if request.url.path == "/orders":
            self.orders.append(json.loads(request.content))
            return httpx.Response(200, json={})
        return httpx.Response(404)


def seeder_for(api: FakeApi, tmp_path: Path) -> Seeder:
    seeder = Seeder(
        api="http://api.test",
        origin="http://web.test",
        accounts_out=tmp_path / ".env.seed-accounts.json",
        data={
            "communities": [{"name": "Trust", "owner": "sam", "stewards": []}],
            "listings": [
                {"community": "Trust", "name": "Site A", "rerate": True},
                {"community": "Trust", "name": "Site B"},
            ],
            "trades_round_1": [
                ["hannah", "Site A", "buy", 100],
                ["hannah", "Site B", "buy", 100],
                ["hannah", "Site A", "sell", 0.5],
            ],
        },
        transport=httpx.MockTransport(api),
    )
    seeder.load()
    seeder.people = {
        "hannah": Account("Hannah", "h@example.com", "-", seeder.client()),
        "sam": Account("Sam", "s@example.com", "-", seeder.client()),
    }
    return seeder


def test_a_re_run_never_repeats_a_trade(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seed_live, "TRADE_PAUSE_S", 0)
    api = FakeApi()

    seeder_for(api, tmp_path).trade("trades_round_1")
    seeder_for(api, tmp_path).trade("trades_round_1")

    # Site B has no price yet (not open): skipped, and tried again on the next run.
    assert api.orders == [
        {"asset_id": "site-a", "side": "buy", "qty": 5},
        {"asset_id": "site-a", "side": "sell", "qty": 20},
    ]
    state = json.loads((tmp_path / ".env.seed-state.json").read_text())
    assert state == {
        "done": ["trades_round_1:hannah|Site A|buy|100", "trades_round_1:hannah|Site A|sell|0.5"]
    }


def test_an_owner_re_rate_runs_once_and_waits_for_its_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(seed_live, "RUN_POLL_S", 0)
    jobs: list[str] = []
    monkeypatch.setattr(Seeder, "job", lambda self, phase, module, *args: jobs.append(module))
    api = FakeApi()

    first = seeder_for(api, tmp_path)
    first.phase_rerate()
    second = seeder_for(api, tmp_path)
    second.phase_rerate()

    assert api.runs == ["run-1"], "a re-run never starts another owner re-rate"
    assert jobs == ["app.jobs.rerate_all", "app.jobs.rerate_all"]  # idempotent per quarter
    assert first.unfinished == second.unfinished == []
    assert "rerate:Site A" in json.loads((tmp_path / ".env.seed-state.json").read_text())["done"]


def test_a_refused_launch_is_logged_and_the_run_moves_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise ipo.IpoRefused("ipo_price_too_high")

    monkeypatch.setattr(ipo, "launch", refuse)
    seeder = seeder_for(FakeApi(), tmp_path)
    site = str(uuid4())
    replies = {
        f"/assets/{site}": {"ipo_at": None},
        f"/assets/{site}/ipo/preview": {"ipo_price": "9"},
    }
    seeder.people["sam"].client = httpx.Client(
        base_url="http://api.test",
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=replies[r.url.path])),
    )

    assert seeder.launch(seeder.people["sam"], {"id": site, "name": "Site A"}) is False
