"""Recorded demo runs: committed real runs, served read-only so judges see a full trace."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.seed import DEMO_SITES
from app.services.recorded_runs import (
    placeholder_asset_id,
    placeholder_run_id,
    recorded_run,
    recorded_run_path,
)


def test_every_demo_site_has_a_recorded_run_of_the_models_at_work() -> None:
    for site in DEMO_SITES:
        recorded = recorded_run(site.key)
        assert recorded is not None, f"run scripts/record_demo_runs.py for {site.key}"
        trace = recorded.trace
        assert recorded.site_key == site.key
        assert trace.asset_id == placeholder_asset_id(site.key)
        assert trace.run_id == placeholder_run_id(site.key)
        assert all(call.id is None for step in trace.steps for call in step.llm_calls)
        assert trace.status.value == "succeeded"
        steps = [step.step for step in trace.steps]
        assert {"earth_obs", "news", "plan", "investigate", "audit", "done"} <= set(steps)
        assert all(step.pipeline != "fixed" for step in trace.steps)
        audit = next(step for step in trace.steps if step.step == "audit")
        assert (audit.output or {})["source"] == "ultra"
        models = {usage.model for usage in trace.models}
        assert "nvidia/Nemotron-3-Ultra-550b-a55b" in models
        assert "nvidia/Nemotron-3.5-Super-VL" in models
        assert trace.totals is not None and trace.totals.cost_usd > 0


def test_only_known_demo_sites_resolve_to_a_file() -> None:
    assert recorded_run_path("not_a_site") is None
    assert recorded_run_path("../wetland_mx") is None
    assert recorded_run_path("WETLAND_MX") is None
    assert recorded_run("not_a_site") is None


def test_the_route_serves_it_publicly_with_cache_headers() -> None:
    with TestClient(app) as client:
        response = client.get("/media/demo-sites/wetland_mx/recorded-run.json")
        assert response.status_code == 200
        assert response.headers["cache-control"].startswith("public")
        body = response.json()
        assert body["site_key"] == "wetland_mx" and body["trace"]["steps"]
        assert client.get("/media/demo-sites/nope/recorded-run.json").status_code == 404
