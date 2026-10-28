"""Publish the eval results to the frontend: `evals/results/*.json` → `frontend/src/lib/evals.json`.

Usage (repo root, after an eval run): backend/.venv/bin/python evals/publish.py

The Agent Trace drawer's eval section shows these numbers, failures included. The frontend keeps
its own small copy because its build context doesn't include `evals/`;
`backend/tests/test_evals_published.py` fails when the copy drifts from the results.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "evals" / "results"
TARGET = ROOT / "frontend" / "src" / "lib" / "evals.json"
NEWS_METRICS = ("relevance", "impact_type", "direction", "severity", "injection_resistance")


def _ratio(metric: dict[str, int] | None) -> str | None:
    return f"{metric['passed']}/{metric['total']}" if metric else None


def news(data: dict[str, Any]) -> dict[str, Any]:
    order = ("nano", "super", "ultra")
    rows = []
    for name in sorted(data["providers"], key=lambda p: order.index(p) if p in order else 9):
        p = data["providers"][name]
        rows.append(
            {
                "tier": name,
                "passed": p["passed"],
                "tests": p["tests"],
                "metrics": {m: _ratio(p["metrics"].get(m)) for m in NEWS_METRICS},
                "cost_usd": p["cost_usd"],
                "p50_latency_ms": p["p50_latency_ms"],
                "failures": [f"{f['item']}: {f['reason']}" for f in p["failures"]][:8],
            }
        )
    return {"items": data["items"], "rows": rows}


def auditor(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_on": data["run_on"],
        "model": data["model"],
        "summary": data["summary"],
        "failures": [
            {
                "case": f"{c['site']}/{c['case']}",
                "what": "; ".join(c["failures"]),
                "refused": c["rejections"][:2],
                "recovered": c["source"] == "ultra",
            }
            for c in data["cases"]
            if c["failures"]
        ],
    }


def copilot(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_on": data["run_on"],
        "summary": {k: v for k, v in data["summary"].items() if k != "grounded_pct"},
        "failures": [
            {"id": i["id"], "question": i["question"], "what": "; ".join(i["failures"])}
            for i in data["items"]
            if i["failures"]
        ],
    }


def schema(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_on": data["run_on"],
        "agents": [
            {k: r[k] for k in ("agent", "attempts", "schema_valid_pct", "refused_pct")}
            for r in data["agents"]
        ],
        "total": {k: data["total"][k] for k in ("attempts", "schema_valid_pct", "refused_pct")},
    }


def _read(name: str) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads((RESULTS / f"{name}.json").read_text(encoding="utf-8")))


def build() -> dict[str, Any]:
    return {
        "news": news(_read("news_routing")),
        "auditor": auditor(_read("auditor")),
        "copilot": copilot(_read("copilot")),
        "schema": schema(_read("schema")),
    }


def main() -> None:
    TARGET.write_text(json.dumps(build(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {TARGET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
