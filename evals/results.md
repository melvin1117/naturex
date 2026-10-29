# Eval results

Written by `make eval` (`evals/report.py`) from `evals/results/*.json`; how each eval works is in [evals/README.md](README.md), the targets in dev-spec §18. Failures stay in.

## News classification (News Scout)
40 hand-labelled local news items through the real News Scout code on each tier. Targets: relevance ≥ 85%, impact type ≥ 75%.

| Model | All labels right | Relevance | Impact type | Direction | Severity ±1 | Injections | First-try schema | p50 | Cost |
|---|---|---|---|---|---|---|---|---|---|
| Nemotron 3 Nano | 33/40 | 36/40 | 21/24 | 24/24 | 24/24 | 3/3 | 40/40 | 1245 ms | $0.00284 |
| Nemotron 3 Super | 39/40 | 40/40 | 23/24 | 24/24 | 24/24 | 3/3 | 40/40 | 1056 ms | $0.01236 |
| Nemotron 3 Ultra | 40/40 | 40/40 | 24/24 | 24/24 | 24/24 | 3/3 | 40/40 | 865 ms | $0.04311 |

Production sends the news to **Super** (ADR-0003).

## Auditor (Nemotron 3 Ultra)
15 cases: 3 demo sites' real records × no news, fire, encroachment, restoration and a planted injection (run 2026-10-22).

| Check | Result | Target |
|---|---|---|
| Ended on Ultra (after code's checks) | 15/15 | — |
| First answer accepted by code | 11/15 | — |
| Cites the news event | 12/12 | 100% |
| Never adjusts against the evidence | 15/15 ✅ | 100% |
| Planted instruction ignored | 3/3 | 100% |
| p50 / p95 | 13571 / 18442 ms | — |
| Cost | $0.2794 ($0.0186 a case) | — |

Numbers can't move: code refuses any answer that changes a field other than the ±10 adjustment or cites what doesn't exist, and every refusal is listed in `results/auditor.json`.

## Bea's grounding (Nemotron 3 Nano)
15 questions over the demo sites' reports and local news, through the production answer path (run 2026-10-28). Target: ≥ 90% grounded.

| Check | Result |
|---|---|
| **Grounded** (all checks below) | **15/15** ✅ |
| Answers when the Record does, refuses when it doesn't | 15/15 |
| Cites the expected source | 13/13 |
| Every number is in a cited source | 13/13 |
| Planted instruction ignored, no market talk | 15/15 |
| Nano's first draft accepted | 12/13 |
| p50 · cost | 1094 ms · $0.001 |

## Schema reliability, every agent
Every model call attempt logged in `llm_calls` for this database (ratings, the Time Machine, Bea and the eval runs). Target: ≥ 95% schema-valid; an invalid reply is retried once. Run 2026-10-28.

| Agent | Attempts | Schema-valid | Refused by code |
|---|---|---|---|
| article_reader | 12 | 100.0% | 0.0% |
| auditor | 61 | 98.4% | 20.0% |
| copilot | 21 | 100.0% | 4.8% |
| copilot_embed | 11 | 100.0% | 0.0% |
| news_scout | 52 | 100.0% | 0.0% |
| orchestrator | 229 | 100.0% | 0.0% |
| report_summary | 1 | 100.0% | 0.0% |
| site_vision | 20 | 100.0% | 0.0% |
| **all** | 407 | **99.8%** ✅ | 3.2% |
