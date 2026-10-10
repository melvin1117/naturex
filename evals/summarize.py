"""Summarise a promptfoo News Scout run: per-metric pass rates, tokens, cost and failures.

Usage (repo root): backend/.venv/bin/python evals/summarize.py [evals/output/news-results.json]

Reads promptfoo's JSON output (`outputPath` in promptfooconfig.yaml) and prints Markdown, one
table row per provider (nano / super / ultra), so T47 can paste it into the G3 routing table.
Stdlib only.

Errored rows (provider error, e.g. budget stop or timeout) have no assertion results, so they
would silently drop out of every denominator. Instead each one counts as a failure in every
metric its test would have asserted (rebuilt from `vars.id` via news_eval.build_test), and the
`errors` column shows how many there were.
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import news_eval  # noqa: E402

DEFAULT_RESULTS = Path(__file__).resolve().parent / "output" / "news-results.json"
METRICS = news_eval.METRICS
# promptfoo's ResultFailureReason.ERROR
FAILURE_REASON_ERROR = 2


def _expected_metrics(item_id: str, items: dict[str, dict[str, Any]]) -> list[str]:
    item = items.get(item_id)
    if item is None:
        return ["schema_valid", "schema_first_try", "relevance"]
    return [a["metric"] for a in news_eval.build_test(item)["assert"]]


def summarise(
    data: dict[str, Any], items: list[dict[str, Any]] | None = None
) -> dict[str, dict[str, Any]]:
    by_id = {item["id"]: item for item in (news_eval.load_items() if items is None else items)}
    by_provider: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "tests": 0,
            "passed": 0,
            "errors": 0,
            "metrics": defaultdict(lambda: [0, 0]),
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "cached": 0,
            "requests": 0,
            "cost": 0.0,
            "cost_uncached": 0.0,
            "latencies": [],
            "failures": [],
        }
    )
    for row in data["results"]["results"]:
        provider = row["provider"].get("label") or row["provider"]["id"]
        stats = by_provider[provider]
        stats["tests"] += 1
        stats["passed"] += 1 if row.get("success") else 0
        item_id = (row.get("vars") or {}).get("id", f"test-{row.get('testIdx')}")
        response = row.get("response") or {}
        components = (row.get("gradingResult") or {}).get("componentResults") or []
        errored = bool(response.get("error")) or row.get("failureReason") == FAILURE_REASON_ERROR
        if errored:
            stats["errors"] += 1
            reason = response.get("error") or row.get("error") or "provider error"
            stats["failures"].append((item_id, "provider error", reason))
            if not components:
                for expected_metric in _expected_metrics(str(item_id), by_id):
                    stats["metrics"][expected_metric][1] += 1
        # The provider keeps the original call's tokens, cost and latency in metadata, so
        # cached re-runs still report what the model costs (needed for the routing table).
        meta = response.get("metadata") or {}
        usage = response.get("tokenUsage") or {}
        stats["prompt_tokens"] += int(meta.get("prompt_tokens", usage.get("prompt")) or 0)
        stats["completion_tokens"] += int(
            meta.get("completion_tokens", usage.get("completion")) or 0
        )
        stats["cached"] += 1 if (response.get("cached") or meta.get("cached")) else 0
        stats["requests"] += int(usage.get("numRequests") or 0)
        stats["cost"] += float(row.get("cost") or 0)
        stats["cost_uncached"] += float(meta.get("cost_usd", row.get("cost")) or 0)
        if meta.get("latency_ms") is not None:
            stats["latencies"].append(int(meta["latency_ms"]))
        for component in components:
            metric = (component.get("assertion") or {}).get("metric")
            if not metric:
                continue
            counts = stats["metrics"][metric]
            counts[1] += 1
            if component.get("pass"):
                counts[0] += 1
            else:
                stats["failures"].append((item_id, metric, component.get("reason", "")))
    return by_provider


def render(summary: dict[str, dict[str, Any]]) -> str:
    header = [
        "provider",
        "tests passed",
        "errors",
        *METRICS,
        "tokens in/out",
        "USD uncached",
        "USD this run",
        "p50 ms",
    ]
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for provider, stats in summary.items():
        cells = [provider, f"{stats['passed']}/{stats['tests']}", str(stats["errors"])]
        for metric in METRICS:
            passed, total = stats["metrics"].get(metric, (0, 0))
            cells.append(f"{passed}/{total} ({passed / total:.0%})" if total else "n/a")
        cells.append(f"{stats['prompt_tokens']}/{stats['completion_tokens']}")
        cells.append(f"{stats['cost_uncached']:.5f}")
        cells.append(f"{stats['cost']:.5f} ({stats['cached']} cached)")
        latencies = stats["latencies"]
        cells.append(str(int(statistics.median(latencies))) if latencies else "n/a")
        lines.append("| " + " | ".join(cells) + " |")
    for provider, stats in summary.items():
        if stats["failures"]:
            lines += ["", f"Failures ({provider}):"]
            lines += [f"- {item}: {metric}: {reason}" for item, metric, reason in stats["failures"]]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else DEFAULT_RESULTS
    print(render(summarise(json.loads(path.read_text(encoding="utf-8")))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
