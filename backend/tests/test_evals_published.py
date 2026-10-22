"""The frontend's eval numbers (`frontend/src/lib/evals.json`) match `evals/results`."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_the_published_evals_match_the_results() -> None:
    spec = importlib.util.spec_from_file_location("publish", ROOT / "evals" / "publish.py")
    assert spec is not None and spec.loader is not None
    publish = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publish)

    published = json.loads((ROOT / "frontend" / "src" / "lib" / "evals.json").read_text())

    assert published == publish.build(), "run: backend/.venv/bin/python evals/publish.py"
