import { cn } from "cn";

import type { IpoPreview } from "@/lib/api/types";
import {
  CONFIDENCE_FACTOR_FORMULA,
  FORMULA_YEARS,
  HEALTH_FACTOR_FORMULA,
  trimDecimal,
} from "@/lib/ipo";
import { int } from "@/lib/prototype/format";
import { moneyText, unitPriceText } from "@/lib/trade";

function Step({
  label,
  value,
  strong = false,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("shrink-0 text-right", strong && "font-semibold")}>
        {value}
      </span>
    </li>
  );
}

/**
 * The opening price, step by step (dev-spec §8), from the backend's preview. Every number is
 * a term the API returned; nothing is computed here, only formatted.
 */
export function IpoPriceSteps({
  preview,
  className,
}: {
  preview: IpoPreview;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="rounded-2xl bg-secondary p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Opening price, step by step</h3>
          <span className="text-xs text-muted-foreground">
            From rating report v{preview.report_version}
          </span>
        </div>
        <ol
          className="tabular mt-3 space-y-1.5 text-sm"
          aria-label="How the opening price is computed"
        >
          <Step
            label="Yearly value of the site's nature (midpoint of the report's range)"
            value={`${moneyText(preview.value_mid)}/yr`}
          />
          <Step
            label={`× ${FORMULA_YEARS} years of that value`}
            value={`× ${FORMULA_YEARS}`}
          />
          <Step
            label={`× health factor (${HEALTH_FACTOR_FORMULA}, health ${trimDecimal(preview.health)})`}
            value={`× ${trimDecimal(preview.health_factor)}`}
          />
          <Step
            label={`× confidence factor (${CONFIDENCE_FACTOR_FORMULA}, confidence ${trimDecimal(preview.confidence)})`}
            value={`× ${trimDecimal(preview.confidence_factor)}`}
          />
          <Step
            label="= Fair value of the whole site"
            value={moneyText(preview.fair_value_total)}
            strong
          />
          <Step
            label="÷ Units issued"
            value={`÷ ${int(preview.total_shares)}`}
          />
          <Step
            label="= Fair price per unit"
            value={unitPriceText(preview.fair_value_per_share)}
            strong
          />
        </ol>
        <div className="mt-4 flex items-baseline justify-between gap-3 border-t pt-3">
          <span className="text-sm font-medium">
            Opening price per unit
            <span className="block text-xs font-normal text-muted-foreground">
              Sandbox price · play money
            </span>
          </span>
          <span className="tabular text-3xl font-light" data-testid="ipo-price">
            {unitPriceText(preview.ipo_price)}
          </span>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-2xl border p-3">
          <dt className="text-xs text-muted-foreground">
            Units offered to supporters
          </dt>
          <dd className="tabular text-lg font-light">
            {int(preview.shares_offered)}
          </dd>
        </div>
        <div className="rounded-2xl border p-3">
          <dt className="text-xs text-muted-foreground">
            Your community keeps ({trimDecimal(preview.retained_pct)}%)
          </dt>
          <dd className="tabular text-lg font-light">
            {int(preview.retained_shares)} units
          </dd>
        </div>
      </dl>
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">
          The formula, as the market engine computes it
        </summary>
        <p className="mt-2 font-mono break-words">{preview.formula}</p>
      </details>
    </div>
  );
}
