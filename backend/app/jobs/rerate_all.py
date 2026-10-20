"""`python -m app.jobs.rerate_all [--world ID] [--period 2026Q4] [--max-usd 2]` (T75).

Re-rates every listed asset of the world (default: the live world) once per quarter, raising
re-rate alerts, then pays the quarter's revenue (T41). Safe to re-run: see
`app.services.monitoring`.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Sequence
from decimal import Decimal

from app.jobs.runtime import (
    inline_runner,
    job_settings,
    parse_args,
    report_and_exit_code,
    session_factory,
    spend,
)
from app.services.monitoring import parse_quarter_period, quarter_label, rerate_all


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(__doc__ or "", quarter_label, parse_quarter_period, argv)
    settings = job_settings()
    report = rerate_all(
        session_factory,
        inline_runner(settings),
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
