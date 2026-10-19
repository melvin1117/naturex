"use client";

import { ArrowRight, MapPin } from "lucide-react";
import Link from "next/link";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { cn } from "cn";

import {
  Delta,
  SiteBackdrop,
  SiteThumb,
  ValueRange,
} from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { Button } from "@/components/ui/button";
import { countryName, type MarketCard } from "@/lib/market-cards";
import { ha, money, price } from "@/lib/prototype/format";

const TREND_TEXT = {
  improving: "Health improving",
  declining: "Health declining",
  stable: "Health stable",
} as const;

const STATUS_TEXT: Partial<Record<MarketCard["status"], string>> = {
  suspended: "Trading paused",
  rating: "Rating in progress",
  needs_evidence: "Needs evidence",
  ineligible: "Not eligible",
};

/** The card's latest prices (from the API's sparkline); nothing until there are two. */
export function MiniPrice({
  id,
  prices,
  className,
  stroke = "var(--primary)",
}: {
  id: string;
  prices: number[];
  className?: string;
  stroke?: string;
}) {
  const points = prices.map((p) => ({ p }));
  return (
    <div className={cn("h-12 w-full", className)} aria-hidden="true">
      {points.length < 2 ? (
        <div className="grid h-full place-items-center rounded-xl border border-dashed text-xs text-muted-foreground">
          The price chart starts with the first trade
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={points}
            margin={{ top: 4, bottom: 0, left: 0, right: 0 }}
          >
            <defs>
              <linearGradient id={`mini-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Area
              type="monotone"
              dataKey="p"
              stroke={stroke}
              strokeWidth={1.5}
              fill={`url(#mini-${id})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function place(card: MarketCard) {
  return [countryName(card.country), ha(card.areaHa)]
    .filter(Boolean)
    .join(" · ");
}

export function TrendText({
  card,
  className,
}: {
  card: Pick<MarketCard, "trend" | "grade">;
  className?: string;
}) {
  return (
    <span className={className}>
      {card.grade === null
        ? "Awaiting rating"
        : card.trend
          ? `${TREND_TEXT[card.trend]} since last report`
          : "First rating"}
    </span>
  );
}

/** The card's badge: its status, or "Not trading yet" for a listed site awaiting its IPO. */
export function cardBadge(card: MarketCard): string | undefined {
  const status = STATUS_TEXT[card.status];
  if (status) return status;
  return card.status === "listed" && !card.trading
    ? "Not trading yet"
    : undefined;
}

export function SiteCard({ card }: { card: MarketCard }) {
  const status = cardBadge(card);
  return (
    <Link
      href={`/asset/${card.id}`}
      className="group flex flex-col overflow-hidden rounded-3xl bg-card shadow-soft transition-shadow hover:shadow-lift focus-visible:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="relative">
        <SiteThumb
          src={card.imageUrl}
          alt={`Satellite view of ${card.name}`}
          className="aspect-[16/9]"
        />
        {status && (
          <div className="absolute top-3 left-3">
            <span className="rounded-full bg-clay px-2.5 py-1 text-xs font-medium text-white">
              {status}
            </span>
          </div>
        )}
        {card.grade && (
          <div className="absolute right-3 bottom-3">
            <GradeBadge grade={card.grade} />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <h3 className="text-lg leading-tight font-semibold">{card.name}</h3>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
            <MapPin className="size-3.5" aria-hidden="true" />
            {place(card)}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted-foreground">Stake price</div>
            <div className="tabular mt-0.5 text-xl font-light">
              {card.price === null ? "—" : price(card.price)}
            </div>
            {card.changePct !== null && (
              <Delta
                value={card.changePct}
                suffix="since opening"
                className="text-xs"
              />
            )}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              Health · confidence
            </div>
            <div className="tabular mt-0.5 text-xl font-light">
              {card.health === null ? "—" : card.health.toFixed(1)}
            </div>
            <div className="text-xs text-muted-foreground">
              {card.confidence === null
                ? "Not rated yet"
                : `${card.confidence.toFixed(0)}% confidence`}
            </div>
          </div>
        </div>
        <MiniPrice id={card.id} prices={card.sparkline} />
        <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3 text-sm">
          <span className="min-w-0 text-muted-foreground">
            {card.valueLow !== null && card.valueHigh !== null && (
              <span className="tabular block">
                {money(card.valueLow)}–{money(card.valueHigh)} /yr
              </span>
            )}
            <TrendText card={card} className="block text-xs" />
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 font-medium">
            View site
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </span>
        </div>
      </div>
    </Link>
  );
}

export function FeatureSiteCard({ card }: { card: MarketCard }) {
  return (
    <section
      aria-labelledby={`feature-${card.id}`}
      className="relative isolate overflow-hidden rounded-[2rem] text-white shadow-lift"
      data-tour="feature-card"
    >
      <SiteBackdrop src={card.imageUrl} />
      <div className="relative grid gap-8 p-6 sm:p-8 lg:grid-cols-[auto_1fr_auto] lg:items-center lg:gap-10 lg:p-10">
        {card.health !== null && (
          <HealthRing
            value={card.health}
            tone="dark"
            size={188}
            className="mx-auto lg:mx-0"
          />
        )}
        <div className="min-w-0 space-y-5">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-white/80">
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 backdrop-blur">
                Top rated
              </span>
              <span>{place(card)}</span>
            </div>
            <h2
              id={`feature-${card.id}`}
              className="mt-3 font-serif text-4xl leading-[1.05] tracking-tight sm:text-5xl"
            >
              {card.name}
            </h2>
            <TrendText
              card={card}
              className="mt-2 block text-sm text-white/80"
            />
          </div>
          {card.valueLow !== null &&
            card.valueMid !== null &&
            card.valueHigh !== null &&
            card.confidence !== null && (
              <ValueRange
                low={card.valueLow}
                mid={card.valueMid}
                high={card.valueHigh}
                confidence={card.confidence}
                tone="image"
                className="max-w-md"
              />
            )}
        </div>
        <div className="flex flex-col gap-4 rounded-3xl bg-white/12 p-5 backdrop-blur-md lg:w-64">
          {card.grade && <GradeBadge grade={card.grade} size="lg" />}
          <div>
            <div className="text-xs text-white/75">
              Stake price · play money
            </div>
            <div className="tabular text-3xl font-light">
              {card.price === null ? "—" : price(card.price)}
            </div>
            {card.changePct !== null && (
              <Delta
                value={card.changePct}
                suffix="since opening"
                className="text-white [&_span]:text-white/90"
              />
            )}
          </div>
          <Button asChild className="bg-lime text-foreground hover:bg-lime/90">
            <Link href={`/asset/${card.id}`}>View site</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
