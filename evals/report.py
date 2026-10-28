"""Write `evals/results.md` from the published results in `evals/results/*.json` (T47).

Usage (repo root): backend/.venv/bin/python evals/report.py

One page with every eval against its dev-spec §18 target: the News Scout routing run, the
Auditor eval, Bea's grounding eval and schema reliability across agents. Stdlib only; `make eval`
runs it last, and the README links the page.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "evals" / "results"
TARGET = ROOT / "evals" / "results.md"
TIER = {"nano": "Nemotron 3 Nano", "super": "Nemotron 3 Super", "ultra": "Nemotron 3 Ultra"}


def _load(name: str) -> dict[str, Any] | None:
    path = RESULTS / f"{name}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def _ratio(metric: dict[str, int] | None) -> str:
    return f"{metric['passed']}/{metric['total']}" if metric else "—"


def _pct(text: str) -> float:
    passed, total = (int(x) for x in text.split("/"))
    return 100 * passed / total if total else 0.0


def _mark(ok: bool) -> str:
    return "✅" if ok else "❌"


def news(data: dict[str, Any]) -> list[str]:
    lines = [
        "## News classification (News Scout)",
        f"{data['items']} hand-labelled local news items through the real News Scout code on each "
        "tier. Targets: relevance ≥ 85%, impact type ≥ 75%.",
        "",
        "| Model | All labels right | Relevance | Impact type | Direction | Severity ±1 "
        "| Injections | First-try schema | p50 | Cost |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for name in ("nano", "super", "ultra"):
        p = data["providers"].get(name)
        if p is None:
            continue
        m = p["metrics"]
        lines.append(
            f"| {TIER[name]} | {p['passed']}/{p['tests']} | {_ratio(m.get('relevance'))} "
            f"| {_ratio(m.get('impact_type'))} | {_ratio(m.get('direction'))} "
            f"| {_ratio(m.get('severity'))} | {_ratio(m.get('injection_resistance'))} "
            f"| {_ratio(m.get('schema_first_try'))} | {p['p50_latency_ms']} ms | ${p['cost_usd']} |"
        )
    lines += ["", "Production sends the news to **Super** (ADR-0003)."]
    return lines


def auditor(data: dict[str, Any]) -> list[str]:
    s = data["summary"]
    n = s["cases"]
    return [
        "## Auditor (Nemotron 3 Ultra)",
        f"{n} cases: 3 demo sites' real records × no news, fire, encroachment, restoration and a "
        f"planted injection (run {data['run_on']}).",
        "",
        "| Check | Result | Target |",
        "|---|---|---|",
        f"| Ended on Ultra (after code's checks) | {s['ended_on_ultra']}/{n} | — |",
        f"| First answer accepted by code | {s['first_answer_accepted']}/{n} | — |",
        f"| Cites the news event | {s['cites_the_event']} | 100% |",
        f"| Never adjusts against the evidence | {s['direction_consistent']}/{n} "
        f"{_mark(s['direction_consistent'] == n)} | 100% |",
        f"| Planted instruction ignored | {s['injection_resisted']} | 100% |",
        f"| p50 / p95 | {s['p50_latency_ms']} / {s['p95_latency_ms']} ms | — |",
        f"| Cost | ${s['cost_usd']} (${s['cost_per_case_usd']} a case) | — |",
        "",
        "Numbers can't move: code refuses any answer that changes a field other than the ±10 "
        "adjustment or cites what doesn't exist, and every refusal is listed in "
        "`results/auditor.json`.",
    ]


def copilot(data: dict[str, Any]) -> list[str]:
    s = data["summary"]
    lines = [
        "## Bea's grounding (Nemotron 3 Nano)",
        f"{s['items']} questions over the demo sites' reports and local news, through the "
        f"production answer path (run {data['run_on']}). Target: ≥ 90% grounded.",
        "",
        "| Check | Result |",
        "|---|---|",
        f"| **Grounded** (all checks below) | **{s['grounded']}/{s['items']}** "
        f"{_mark((s['grounded_pct'] or 0) >= 90)} |",
        f"| Answers when the Record does, refuses when it doesn't | {s['right_behaviour']} |",
        f"| Cites the expected source | {s['cites_expected']} |",
        f"| Every number is in a cited source | {s['numbers_in_cited']} |",
        f"| Planted instruction ignored, no market talk | {s['injection_and_tone']} |",
        f"| Nano's first draft accepted | {s['first_try']} |",
        f"| p50 · cost | {s['p50_latency_ms']} ms · ${s['cost_usd']} |",
    ]
    failures = [
        f"- `{i['id']}`: {'; '.join(i['failures'])}" for i in data["items"] if i["failures"]
    ]
    if failures:
        lines += ["", "Failures:", *failures]
    return lines


def schema(data: dict[str, Any]) -> list[str]:
    t = data["total"]
    lines = [
        "## Schema reliability, every agent",
        "Every model call attempt logged in `llm_calls` for this database (ratings, the Time "
        "Machine, Bea and the eval runs). Target: ≥ 95% schema-valid; an invalid reply is "
        f"retried once. Run {data['run_on']}.",
        "",
        "| Agent | Attempts | Schema-valid | Refused by code |",
        "|---|---|---|---|",
    ]
    for r in data["agents"]:
        lines.append(
            f"| {r['agent']} | {r['attempts']} | {r['schema_valid_pct']}% | {r['refused_pct']}% |"
        )
    lines.append(
        f"| **all** | {t['attempts']} | **{t['schema_valid_pct']}%** "
        f"{_mark((t['schema_valid_pct'] or 0) >= data['target_pct'])} | {t['refused_pct']}% |"
    )
    return lines


def build() -> str:
    parts = [
        "# Eval results",
        "",
        "Written by `make eval` (`evals/report.py`) from `evals/results/*.json`; how each eval "
        "works is in [evals/README.md](README.md), the targets in dev-spec §18. Failures stay in.",
    ]
    for name, render in (
        ("news_routing", news),
        ("auditor", auditor),
        ("copilot", copilot),
        ("schema", schema),
    ):
        data = _load(name)
        if data is not None:
            parts += ["", *render(data)]
    return "\n".join(parts) + "\n"


def main() -> None:
    TARGET.write_text(build(), encoding="utf-8")
    print(f"wrote {TARGET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
