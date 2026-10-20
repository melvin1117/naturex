"""`python -m app.jobs.news_sweep [--world ID] [--period 2026-10-19] [--max-usd 2]` (T75).

Runs News Scout once a day per listed asset of the world (default: the live world), stores new
events and alerts holders and the community on severity ≥ 4. Safe to re-run: see
`app.services.monitoring`. The daily GitHub Action (`.github/workflows/news-sweep.yml`) runs it.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Sequence
from decimal import Decimal

from app.jobs.runtime import (
    job_settings,
    parse_args,
    production_news,
    report_and_exit_code,
    session_factory,
    spend,
)
from app.services.monitoring import day_label, news_sweep


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(__doc__ or "", lambda now: day_label(now.date()), argv)
    settings = job_settings()
    report = news_sweep(
        session_factory,
        production_news(settings),
        world_id=args.world,
        period=args.period,
        spend=spend(),
        llm_budget_usd=Decimal(str(settings.llm_budget_usd)),
        job_cap_usd=(
            Decimal(str(settings.monitor_job_budget_usd)) if args.max_usd is None else args.max_usd
        ),
    )
    return report_and_exit_code(report)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    sys.exit(main())
