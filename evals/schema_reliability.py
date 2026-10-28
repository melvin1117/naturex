"""Schema reliability across every agent, from the `llm_calls` log (dev-spec §18, T47).

Usage (repo root): backend/.venv/bin/python evals/schema_reliability.py [--out evals/results]

Every model call attempt is a row in `llm_calls` (`app.llm`): `ok` when the reply parsed and
validated, `invalid_output` when it didn't (the client retries it once, on the same tier or the
next), `rejected` when it was valid but a code check refused it afterwards (the Auditor's
evidence rules, Bea's citation and number checks), `error` for an API failure, `reserved` for a
call still in flight. Per agent, over every call this database has logged (the demo's own
ratings, the Time Machine, Bea and the eval runs):

- **schema-valid:** attempts that parsed and validated, out of attempts that got a reply
  (`ok` + `rejected` out of `ok` + `rejected` + `invalid_output`); target ≥ 95% (dev-spec §18);
- **refused by code:** valid replies a check sent back (`rejected` out of `ok` + `rejected`);
- **errors:** API failures, not counted in either.

Writes `<out>/schema.json` and prints a Markdown table. No model calls, so no cost.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from sqlalchemy import text  # noqa: E402

from app.db import engine  # noqa: E402

TARGET_PCT = 95.0


def _pct(part: int, whole: int) -> float | None:
    return round(100 * part / whole, 1) if whole else None


def summarise(counts: dict[str, dict[str, int]]) -> dict[str, Any]:
    agents = []
    total: dict[str, int] = defaultdict(int)
    for agent in sorted(counts):
        c = counts[agent]
        valid = c.get("ok", 0) + c.get("rejected", 0)
        replied = valid + c.get("invalid_output", 0)
        row = {
            "agent": agent,
            "attempts": replied,
            "schema_valid": valid,
            "schema_valid_pct": _pct(valid, replied),
            "refused_by_code": c.get("rejected", 0),
            "refused_pct": _pct(c.get("rejected", 0), valid),
            "errors": c.get("error", 0),
        }
        agents.append(row)
        for key in ("attempts", "schema_valid", "refused_by_code", "errors"):
            total[key] += row[key]
    return {
        "agents": agents,
        "total": {
            **total,
            "schema_valid_pct": _pct(total["schema_valid"], total["attempts"]),
            "refused_pct": _pct(total["refused_by_code"], total["schema_valid"]),
        },
        "target_pct": TARGET_PCT,
    }


def render(summary: dict[str, Any]) -> str:
    lines = [
        "| Agent | Attempts | Schema-valid | Refused by code | API errors |",
        "|---|---|---|---|---|",
    ]
    for r in [*summary["agents"], {"agent": "**all**", **summary["total"]}]:
        lines.append(
            f"| {r['agent']} | {r['attempts']} | {r['schema_valid']} ({r['schema_valid_pct']}%) "
            f"| {r['refused_by_code']} ({r['refused_pct']}%) | {r['errors']} |"
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", default=str(ROOT / "evals" / "results"))
    args = parser.parse_args()
    counts: dict[str, dict[str, int]] = defaultdict(dict)
    with engine.connect() as conn:
        for agent, status, n in conn.execute(
            text("SELECT agent, status, count(*) FROM llm_calls GROUP BY agent, status")
        ):
            counts[agent][status] = n
    summary = summarise(counts)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {"eval": "schema", "run_on": date.today().isoformat(), **summary}
    (out_dir / "schema.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(render(summary))


if __name__ == "__main__":
    main()
