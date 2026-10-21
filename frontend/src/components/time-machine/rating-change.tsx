import { ArrowRight } from "lucide-react";

import { GradeBadge } from "@/components/proto/grade";
import type { AssetRating } from "@/lib/api/types";
import { price as fmtPrice } from "@/lib/prototype/format";
import { asGrade } from "@/lib/report-facts";
import { ratingChange } from "@/lib/time-machine";

const DASH = "—";

function Pair({
  before,
  after,
  label,
}: {
  before: React.ReactNode;
  after: React.ReactNode;
  /** The change in words, for screen readers. */
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="contents">
        {before}
        <ArrowRight
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        {after}
      </span>
    </span>
  );
}

function healthText(h: number | null) {
  return h === null ? DASH : h.toFixed(1);
}

function priceText(p: number | null) {
  return p === null ? DASH : fmtPrice(p);
}

/** Health, grade and price before → after, as the backend stored them. */
export function changeCells(
  before: AssetRating | null | undefined,
  after: AssetRating | null | undefined,
) {
  const change = ratingChange(before, after);
  const [h0, h1] = change.health;
  const [g0, g1] = change.grade.map(asGrade);
  const [p0, p1] = change.price;
  const grade = (g: typeof g0) =>
    g ? <GradeBadge grade={g} size="sm" /> : <span>{DASH}</span>;
  return {
    health: (
      <Pair
        label={`Health ${healthText(h0)} to ${healthText(h1)}`}
        before={<span className="tabular">{healthText(h0)}</span>}
        after={<span className="tabular font-medium">{healthText(h1)}</span>}
      />
    ),
    grade: (
      <Pair
        label={`Grade ${g0 ?? "none"} to ${g1 ?? "none"}`}
        before={grade(g0)}
        after={grade(g1)}
      />
    ),
    price: (
      <Pair
        label={`Stake price ${priceText(p0)} to ${priceText(p1)}`}
        before={<span className="tabular">{priceText(p0)}</span>}
        after={<span className="tabular font-medium">{priceText(p1)}</span>}
      />
    ),
  };
}
