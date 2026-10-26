"""The template showcase builder's pure parts (app.jobs.build_template_sites)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, cast

import pytest

from app.jobs import build_template_sites as job
from app.models import Asset, OrderSide
from app.tools.geometry import check_shape


def test_moving_a_step_shifts_only_timestamps_written_since_it_began() -> None:
    since = datetime(2026, 10, 26, 8, 0, tzinfo=UTC)
    delta = timedelta(days=-300)
    doc = {
        "as_of": "2025-12-30",
        "run": {
            "started_at": "2026-10-26T08:00:05+00:00",
            "trace_steps": [{"ts": "2026-10-26T08:01:00+00:00"}, {"ts": "2026-10-25T08:00:00Z"}],
        },
        "note": "not a time",
    }
    moved = job._shift_json(doc, since, delta)
    assert moved["as_of"] == "2025-12-30"
    assert moved["run"]["started_at"] == (since + timedelta(seconds=5) + delta).isoformat()
    assert moved["run"]["trace_steps"][1]["ts"] == "2026-10-25T08:00:00Z"
    assert moved["note"] == "not a time"


def test_auto_units_price_one_at_about_fifty(monkeypatch: pytest.MonkeyPatch) -> None:
    quote = SimpleNamespace(terms=SimpleNamespace(price=Decimal("456.6322")))
    monkeypatch.setattr(job.ipo, "quote", lambda *_: quote)
    asset = cast(Asset, SimpleNamespace(total_shares=1_000_000))
    assert job._units(asset, None, Decimal("51")) == 9_100_000
    quote.terms.price = Decimal("2.5")
    assert job._units(asset, None, Decimal("51")) == 50_000


def test_supporter_trades_are_seeded_and_sell_only_after_a_buy() -> None:
    data: dict[str, Any] = json.loads(job.DATA.read_text())
    first, again = job._supporter_trades(data), job._supporter_trades(data)
    assert first == again
    bought: set[tuple[str, str]] = set()
    for moment, who, side, key, _ in sorted(first, key=lambda trade: trade[0]):
        rule = data["supporter_trades"][key]
        assert job.when(rule["from"]).date() <= moment.date() <= job.when(rule["to"]).date()
        if side is OrderSide.SELL:
            assert (who, key) in bought
        bought.add((who, key))


def test_the_showcase_boundaries_are_valid_listings() -> None:
    data = json.loads(job.DATA.read_text())
    for listing in data["listings"]:
        check = check_shape(listing["geojson"])
        assert check.ok, listing["key"]
        assert check.area_ha is not None and 100 <= check.area_ha <= 5_000, listing["key"]
