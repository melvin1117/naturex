"""Recorded rating runs of the demo sites: a real run with live models, committed as data.

A visitor's sandbox copies the template world, whose reports are the seed's formula-only
ratings with no run behind them, so a judge would see no Agent Trace until they rate a site.
Each demo site therefore carries one recorded run (`data/demo_sites/recorded_runs/<site>.json`),
made by `scripts/record_demo_runs.py` against Token Factory and Tavily, and served read-only at
`GET /media/demo-sites/{site_key}/recorded-run.json`. It is labelled "Recorded" with its date
wherever it is shown, and never changes a report, a price or a ledger entry.
"""

from __future__ import annotations

from datetime import date
from functools import lru_cache
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid5

from app.schemas import RecordedRunOut, RunTraceOut
from app.tools.earth_obs import DATA_DIR
from app.tools.site_images import SITE_KEY_RE, known_site_keys

RECORDED_DIR = DATA_DIR / "recorded_runs"


def placeholder_asset_id(site_key: str) -> UUID:
    """The recorded trace's `asset_id`: stable per site and never an asset of any world."""
    return uuid5(NAMESPACE_URL, f"wildworth:recorded-run:{site_key}")


def placeholder_run_id(site_key: str) -> UUID:
    """The recorded trace's `run_id`: stable per site and never a run of any world."""
    return uuid5(NAMESPACE_URL, f"wildworth:recorded-run:{site_key}:run")


def recorded_run_path(site_key: str) -> Path | None:
    """The committed file for a known demo site, or None (invalid, unknown or not recorded)."""
    if not SITE_KEY_RE.fullmatch(site_key) or site_key not in known_site_keys():
        return None
    path = (RECORDED_DIR / f"{site_key}.json").resolve()
    if not path.is_relative_to(RECORDED_DIR.resolve()) or not path.is_file():
        return None
    return path


@lru_cache(maxsize=16)
def _load(path: Path, mtime_ns: int) -> RecordedRunOut:
    return RecordedRunOut.model_validate_json(path.read_text(encoding="utf-8"))


def recorded_run(site_key: str) -> RecordedRunOut | None:
    path = recorded_run_path(site_key)
    if path is None:
        return None
    return _load(path, path.stat().st_mtime_ns)


def record(site_key: str, trace: RunTraceOut, recorded_on: date) -> RecordedRunOut:
    """The file's content for a finished run, with nothing that names a row of the recording
    database: the asset and run IDs become placeholders and the call-log IDs are dropped."""
    steps = [
        step.model_copy(
            update={"llm_calls": [c.model_copy(update={"id": None}) for c in step.llm_calls]}
        )
        for step in trace.steps
    ]
    return RecordedRunOut(
        site_key=site_key,
        recorded_on=recorded_on,
        trace=trace.model_copy(
            update={
                "asset_id": placeholder_asset_id(site_key),
                "run_id": placeholder_run_id(site_key),
                "steps": steps,
            }
        ),
    )
