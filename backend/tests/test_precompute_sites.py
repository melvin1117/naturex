"""Pure precompute-script helpers that do not call Earth Engine."""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from precompute_sites import compare_cached_metrics  # noqa: E402


def test_compare_cached_metrics_allows_small_numeric_drift() -> None:
    expected = {"site_key": "tiny", "metrics": [{"value": 1.00004}]}
    actual = {"site_key": "tiny", "metrics": [{"value": 1.00005}]}

    assert compare_cached_metrics(expected, actual) == []


def test_compare_cached_metrics_reports_meaningful_paths() -> None:
    expected = {"site_key": "tiny", "metrics": [{"value": 1.0}]}
    actual = {"site_key": "tiny", "metrics": [{"value": 1.2}]}

    assert compare_cached_metrics(expected, actual) == ["$.metrics[0].value: 1.0 != 1.2"]
