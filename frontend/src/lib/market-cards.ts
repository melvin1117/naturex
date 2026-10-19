/**
 * Marketplace cards from `GET /assets`: decimal strings as numbers, plus sort and filter.
 * Every number is the API's; a missing one stays null and sorts last.
 */
import type { AssetCard } from "./api/types";
import { demoSiteMediaUrl } from "./demo-site-images";
import type { Grade } from "./prototype/data";
import { GRADE_ORDER } from "./prototype/format";
import { asGrade, num } from "./report-facts";

export type HealthTrend = "improving" | "declining" | "stable";

export type MarketCard = {
  id: string;
  name: string;
  country: string | null;
  status: AssetCard["status"];
  /** Orders are open: listed and its opening offer (IPO) launched (T59). */
  trading: boolean;
  areaHa: number;
  price: number | null;
  /** Latest price vs the IPO price, percent. */
  changePct: number | null;
  grade: Grade | null;
  /** Health vs the previous report; null with a single report. */
  trend: HealthTrend | null;
  confidence: number | null;
  health: number | null;
  valueLow: number | null;
  valueMid: number | null;
  valueHigh: number | null;
  imageUrl: string | null;
  /** The latest prices, oldest first. */
  sparkline: number[];
};

const TRENDS: readonly string[] = ["improving", "declining", "stable"];

export function marketCard(card: AssetCard): MarketCard {
  return {
    id: card.id,
    name: card.name,
    country: card.country ?? null,
    status: card.status,
    trading: card.trading === true,
    areaHa: num(card.area_ha) ?? 0,
    price: num(card.price),
    changePct: num(card.price_change_pct),
    grade: asGrade(card.grade),
    trend:
      card.trend && TRENDS.includes(card.trend)
        ? (card.trend as HealthTrend)
        : null,
    confidence: num(card.confidence),
    health: num(card.health_score),
    valueLow: num(card.value_low),
    valueMid: num(card.value_mid),
    valueHigh: num(card.value_high),
    imageUrl: siteImageUrl(card.site_key, card.cover_image_url),
    sparkline: (card.sparkline ?? []).flatMap((p) => {
      const n = num(p);
      return n === null ? [] : [n];
    }),
  };
}

/**
 * The site's satellite thumbnail through the backend's media route, else its cover image if
 * it's an https URL (it's user-supplied); otherwise null, for the placeholder.
 */
export function siteImageUrl(
  siteKey: string | null | undefined,
  coverUrl?: string | null,
): string | null {
  if (siteKey) return demoSiteMediaUrl(siteKey, "thumbnail.webp");
  if (!coverUrl) return null;
  try {
    const url = new URL(coverUrl);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "region" }).of(
        code.toUpperCase(),
      ) ?? code
    );
  } catch {
    return code;
  }
}

export type SortKey = "grade" | "change" | "confidence" | "value";

/** Descending by `pick`, nulls last. */
function desc(pick: (c: MarketCard) => number | null) {
  return (a: MarketCard, b: MarketCard) => {
    const x = pick(a);
    const y = pick(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return y - x;
  };
}

const gradeRank = (c: MarketCard) =>
  c.grade ? GRADE_ORDER.length - GRADE_ORDER.indexOf(c.grade) : null;

export const SORTS: Record<
  SortKey,
  { label: string; fn: (a: MarketCard, b: MarketCard) => number }
> = {
  grade: {
    label: "Best grade",
    fn: (a, b) => desc(gradeRank)(a, b) || desc((c) => c.health)(a, b),
  },
  change: { label: "Price change", fn: desc((c) => c.changePct) },
  confidence: { label: "Confidence", fn: desc((c) => c.confidence) },
  value: { label: "Annual value", fn: desc((c) => c.valueMid) },
};

export type GradeBand = "all" | "a" | "b" | "low";

export const GRADE_BANDS: Record<
  GradeBand,
  { label: string; grades: Grade[] }
> = {
  all: { label: "All", grades: GRADE_ORDER },
  a: { label: "AAA–A", grades: ["AAA", "AA", "A"] },
  b: { label: "BBB–BB", grades: ["BBB", "BB"] },
  low: { label: "B–D", grades: ["B", "C", "D"] },
};

/** Own keys only: `?grade=toString` or `__proto__` from a URL must not match. */
export function isBand(v: string | null): v is GradeBand {
  return v !== null && Object.hasOwn(GRADE_BANDS, v);
}

export function isSort(v: string | null): v is SortKey {
  return v !== null && Object.hasOwn(SORTS, v);
}

export function shownCards(
  cards: MarketCard[],
  band: GradeBand,
  sort: SortKey,
): MarketCard[] {
  return cards
    .filter(
      (c) =>
        band === "all" ||
        (c.grade !== null && GRADE_BANDS[band].grades.includes(c.grade)),
    )
    .sort(SORTS[sort].fn);
}
