"""Record a real rating run of each demo site and commit it as data (`services.recorded_runs`).

Usage (repo root; a migrated, seeded database; NEBIUS_API_KEY, TAVILY_API_KEY and MODEL_* in
.env; about $0.15 and 3 minutes for the three sites):

    cd backend && USE_MOCKS=false SITE_VISION_LIVE=true RATING_RUNS_PER_WORLD_PER_HOUR=40 \\
        uv run python ../scripts/record_demo_runs.py [--sites wetland_mx] [--run-ids <uuid>...]

Each demo asset of the live world is rated inline by the production runner (Super, Tavily,
Super VL, Nano, Ultra). **That writes a new report, fair value and ledger entry in the live
world of DATABASE_URL**, so use a local or scratch database: the script refuses
ENVIRONMENT=production. The finished run's Agent Trace is written to
`backend/data/demo_sites/recorded_runs/<site>.json` with today's date and a placeholder asset
ID. `--run-ids` exports finished runs instead of starting new ones. A run that failed, fell
back to the fixed pipeline or ended on the no-op audit is refused: a recording should show the
models at work.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from sqlmodel import Session, select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import engine  # noqa: E402
from app.jobs.runtime import inline_runner  # noqa: E402
from app.models import Asset  # noqa: E402
from app.schemas import RunTraceOut  # noqa: E402
from app.seed import DEMO_SITES  # noqa: E402
from app.services.rating_runs import get_run_trace  # noqa: E402
from app.services.recorded_runs import RECORDED_DIR, record  # noqa: E402
from app.worlds import LIVE_WORLD_ID  # noqa: E402

ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b"
VISION = "nvidia/Nemotron-3.5-Super-VL"
SHOWN_STEPS = {"earth_obs", "news", "plan", "investigate", "audit", "done"}


def problems(trace: RunTraceOut) -> list[str]:
    """Why a run can't be the recording (the same bar as `tests/test_recorded_runs.py`)."""
    found: list[str] = []
    if trace.status.value != "succeeded":
        found.append(f"status {trace.status.value}")
    if any(step.pipeline == "fixed" for step in trace.steps):
        found.append("the fixed pipeline ran part of it")
    missing = SHOWN_STEPS - {step.step for step in trace.steps}
    if missing:
        found.append(f"no {', '.join(sorted(missing))} step")
    audit = next((s for s in trace.steps if s.step == "audit"), None)
    if audit is None or (audit.output or {}).get("source") != "ultra":
        found.append("not audited by Ultra")
    models = {usage.model for usage in trace.models}
    for model in (ULTRA, VISION):
        if model not in models:
            found.append(f"no {model} call")
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--sites", nargs="*", default=[site.key for site in DEMO_SITES])
    parser.add_argument("--run-ids", nargs="*", default=[], type=UUID)
    args = parser.parse_args()

    settings = get_settings()
    if settings.use_mocks:
        raise SystemExit("USE_MOCKS=true: a recording must use the real models")
    if settings.environment == "production" and not args.run_ids:
        raise SystemExit("ENVIRONMENT=production: rating would change the live demo's reports")
    RECORDED_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(UTC).date()

    with Session(engine) as session:
        assets = {
            asset.site_key: asset.id
            for asset in session.exec(select(Asset).where(Asset.world_id == LIVE_WORLD_ID)).all()
            if asset.site_key in args.sites
        }
    runs: list[UUID] = list(args.run_ids)
    if not runs:
        runner = inline_runner(settings)
        for site in args.sites:
            if site not in assets:
                raise SystemExit(f"{site} is not an asset of the live world (run make seed)")
            runs.append(runner.start(LIVE_WORLD_ID, assets[site], inline=True))

    by_asset = {asset_id: site for site, asset_id in assets.items()}
    failed = False
    for run_id in runs:
        with Session(engine) as session:
            trace = get_run_trace(session, LIVE_WORLD_ID, run_id)
        if trace is None:
            print(f"✗ run {run_id}: not found in the live world")
            failed = True
            continue
        site = by_asset.get(trace.asset_id)
        issues = problems(trace)
        if site is None or issues:
            print(f"✗ run {run_id} ({site or 'not a demo site'}): {'; '.join(issues) or 'skipped'}")
            failed = True
            continue
        recording = record(site, trace, today)
        path = RECORDED_DIR / f"{site}.json"
        path.write_text(
            json.dumps(recording.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        cost = trace.totals.cost_usd if trace.totals else "?"
        print(f"✓ {site}: run {run_id}, ${cost}, {len(trace.steps)} steps → {path.name}")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
