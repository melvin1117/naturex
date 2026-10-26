"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  type LucideIcon,
  Minus,
  RefreshCwIcon,
} from "lucide-react";
import Link from "@/components/app-link";
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";

import {
  BackThisSiteIcon,
  CarbonIcon,
  HabitatIcon,
  WorthRangeIcon,
  YourStakesIcon,
} from "@/components/icons";
import { CountTo } from "@/components/live-number";
import { PortfolioBodySkeleton } from "@/components/page-skeletons";
import { SiteThumb } from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AssetCard, HoldingOut, PortfolioOut } from "@/lib/api/types";
import { useAssets, usePortfolio, useWorld } from "@/lib/hooks";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
import { siteIcon } from "@/lib/market-cards";
import type { Grade } from "@/lib/site-data";
import { GRADE_ORDER, int } from "@/lib/format";
import { stakeChart } from "@/lib/stake-chart";
import {
  assetHref,
  decimal,
  forgetFills,
  freshFills,
  money,
  moneyText,
  signedMoneyText,
  unitPrice,
  unitPriceText,
  type FreshFill,
} from "@/lib/trade";

/** `/portfolio`: Your stakes, for whoever the visitor is in their sandbox. */
export function PortfolioScreen() {
  return <PortfolioView />;
}

export function PortfolioView() {
  const portfolio = usePortfolio();
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Your stakes
      </h1>
      {portfolio.data ? (
        <PortfolioBody data={portfolio.data} />
      ) : portfolio.error ? (
        <Alert variant="destructive" className="mt-8 max-w-xl">
          <AlertTitle>We couldn&apos;t load your stakes</AlertTitle>
          <AlertDescription>
            <p>{portfolio.error.message}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void portfolio.refetch()}
            >
              <RefreshCwIcon aria-hidden="true" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <PortfolioBodySkeleton />
      )}
    </div>
  );
}

/** A change's size as a percentage: "2.9%", "0.03%" below 1%, "<0.01%" below that (never a
 * misleading "0.0%" beside a real change). */
function percentText(pct: number): string {
  const n = Math.abs(pct);
  if (n >= 1) return `${n.toFixed(1)}%`;
  if (n >= 0.01) return `${n.toFixed(2)}%`;
  return "<0.01%";
}

/** "+$12.30 (+2.9%)" with an arrow, "−$4.50 (−1.1%)", or "Level": direction in words and an
 * icon, never colour alone (DESIGN.md). */
function Change({
  amount,
  pct = null,
  className,
}: {
  amount: string | null | undefined;
  pct?: number | null;
  className?: string;
}) {
  const n = decimal(amount);
  if (n === null) return <span className={cn("tabular", className)}>—</span>;
  if (n === 0)
    return (
      <span
        className={cn(
          "tabular inline-flex items-center gap-1 text-muted-foreground",
          className,
        )}
      >
        <Minus className="size-3.5" aria-hidden="true" />
        Level
      </span>
    );
  const Arrow = n > 0 ? ArrowUpRight : ArrowDownRight;
  const sign = n > 0 ? "+" : "−";
  return (
    <span
      className={cn(
        "tabular inline-flex items-center gap-1",
        n > 0 ? "text-lime-ink" : "text-clay-ink",
        className,
      )}
    >
      <Arrow className="size-3.5 shrink-0" aria-hidden="true" />
      {signedMoneyText(amount)}
      {pct !== null && " "}
      {pct !== null && (
        <span>
          ({Math.abs(pct) < 0.01 ? "" : sign}
          {percentText(pct)})
        </span>
      )}
    </span>
  );
}

function PortfolioBody({ data }: { data: PortfolioOut }) {
  const assets = useAssets();
  const cards = new Map((assets.data ?? []).map((card) => [card.id, card]));
  const sites = data.holdings.length;
  // A trade made a moment ago on an asset page: show its stake changing here (#216 WP2).
  const account = useWorld().world?.me?.id;
  const [fresh] = useState(() => freshFills(account));
  useEffect(() => forgetFills(fresh.values()), [fresh]);
  if (sites === 0)
    return (
      <>
        <p className="mt-5 max-w-3xl text-xl leading-snug text-pretty text-muted-foreground sm:text-2xl">
          You have{" "}
          <span className="tabular text-foreground">
            {moneyText(data.cash_balance)}
          </span>{" "}
          to back living land.
        </p>
        <div className="mt-10 grid place-items-center rounded-3xl border border-dashed border-foreground/20 px-6 py-16 text-center">
          <YourStakesIcon size={32} aria-hidden="true" />
          <p className="mt-4 max-w-md text-pretty text-muted-foreground">
            Back a site on the Marketplace and you&apos;ll follow its health
            here, rating by rating.
          </p>
          <Button asChild className="mt-6">
            <Link href="/">Back your first site</Link>
          </Button>
        </div>
      </>
    );
  return (
    <>
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <MoneyPanel data={data} />
        <Impact data={data} />
      </div>
      <Holdings holdings={data.holdings} cards={cards} fresh={fresh} />
    </>
  );
}

/**
 * Where the visitor's play money stands: the total against what they started with, split
 * between their stakes (what they paid, what those are worth now) and their sandbox balance.
 */
function MoneyPanel({ data }: { data: PortfolioOut }) {
  const total = decimal(data.total_value) ?? 0;
  const inStakes = decimal(data.holdings_value) ?? 0;
  // Each part's share of the total; a sliver of stakes still shows on the bar.
  const stakesPct =
    total > 0 && inStakes > 0
      ? Math.min(98, Math.max(2, Math.round((inStakes / total) * 100)))
      : 0;
  return (
    <section
      aria-labelledby="money-title"
      className="rounded-3xl bg-card p-6 shadow-soft sm:p-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="money-title" className="text-base font-semibold">
          Your money
        </h2>
        <Button asChild variant="outline" size="sm">
          <Link href="/">
            <BackThisSiteIcon aria-hidden="true" />
            Back another site
          </Link>
        </Button>
      </div>

      <p className="mt-5 text-sm text-muted-foreground">Total now</p>
      <p className="tabular mt-1 text-5xl leading-none font-light tracking-[-0.03em]">
        {moneyText(data.total_value)}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
        <Change amount={data.since_start} className="font-medium" /> since you
        started with {moneyText(data.starting_cash)}
      </p>

      <div
        aria-hidden="true"
        className="mt-7 flex h-3 gap-1 overflow-hidden rounded-full"
      >
        {stakesPct > 0 && (
          <span
            className="rounded-full bg-primary"
            style={{ width: `${stakesPct}%` }}
          />
        )}
        <span className="flex-1 rounded-full bg-lichen" />
      </div>

      <dl className="mt-5 grid gap-6 sm:grid-cols-2">
        <div>
          <dt className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full bg-primary"
            />
            In stakes
          </dt>
          <dd className="tabular mt-1.5 text-3xl font-light tracking-[-0.03em]">
            {moneyText(data.holdings_value)}
          </dd>
          <dd className="mt-1.5 text-sm text-muted-foreground">
            You paid{" "}
            <span className="tabular text-foreground">
              {moneyText(data.cost_basis)}
            </span>
          </dd>
          <dd className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            <Change
              amount={data.unrealized_pnl}
              pct={decimal(data.unrealized_pnl_pct)}
            />{" "}
            change in value
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full bg-lichen ring-1 ring-foreground/15"
            />
            Sandbox balance
          </dt>
          <dd className="tabular mt-1.5 text-3xl font-light tracking-[-0.03em]">
            {moneyText(data.cash_balance)}
          </dd>
          <dd className="mt-1.5 text-sm text-muted-foreground">
            Ready to back more sites
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Holdings({
  holdings,
  cards,
  fresh,
}: {
  holdings: HoldingOut[];
  cards: Map<string, AssetCard>;
  fresh: Map<string, FreshFill>;
}) {
  return (
    <section aria-labelledby="stakes-title" className="mt-12">
      <h2
        id="stakes-title"
        className="font-serif text-3xl leading-tight tracking-tight"
      >
        How each stake is doing
      </h2>
      <ul aria-label="Stakes" className="mt-5 space-y-3">
        {holdings.map((h) => (
          <StakeRow
            key={h.asset_id}
            holding={h}
            card={cards.get(h.asset_id)}
            fill={fillFor(h, fresh)}
          />
        ))}
      </ul>
      {showsMap(holdings, cards) && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Site maps: {IMAGERY_ATTRIBUTION}
        </p>
      )}
    </section>
  );
}

/** The fill that just changed this stake, if the stake still holds what the fill left. */
function fillFor(
  h: HoldingOut,
  fresh: Map<string, FreshFill>,
): FreshFill | undefined {
  const fill = fresh.get(h.asset_id);
  return fill?.unitsAfter === h.shares ? fill : undefined;
}

/**
 * The fresh fill as text: the wash and the count are motion (gone under reduced motion), and
 * this says the same thing without it.
 */
function FreshBadge({ fill }: { fill: FreshFill }) {
  const delta = fill.unitsAfter - fill.unitsBefore;
  const n = Math.abs(delta);
  return (
    <Badge
      variant="secondary"
      className="tabular bg-lime/30 font-medium text-lime-ink"
    >
      {delta >= 0 ? "+" : "−"}
      {int(n)} {n === 1 ? "unit" : "units"} just now
    </Badge>
  );
}

/** A stake's units, counting from before a fresh fill to what it holds now. */
function Units({
  holding: h,
  fill,
}: {
  holding: HoldingOut;
  fill?: FreshFill;
}) {
  return <CountTo value={h.shares} from={fill?.unitsBefore} format={int} />;
}

/**
 * One stake: the site (picture, name, grade, units), its latest prices against what was paid,
 * then what was paid, what it's worth now and the change. A row from `lg`, stacked below it.
 */
function StakeRow({
  holding: h,
  card,
  fill,
}: {
  holding: HoldingOut;
  card: AssetCard | undefined;
  fill?: FreshFill;
}) {
  const icon = useMemo(() => siteIcon(card), [card]);
  const grade = asGrade(card?.grade);
  const health = decimal(card?.health_score);
  return (
    <li
      className={cn(
        "group relative grid gap-4 rounded-3xl bg-card p-4 shadow-soft transition-shadow focus-within:shadow-lift hover:shadow-lift sm:p-5",
        "lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.6fr)] lg:items-center lg:gap-6",
        fill && "ww-wash",
      )}
      data-fresh={fill ? "" : undefined}
    >
      <div className="flex min-w-0 items-center gap-4">
        <div className="size-16 shrink-0 overflow-hidden rounded-[18px] sm:size-20">
          {icon ? (
            <SiteThumb
              siteKey={icon.siteKey}
              src={icon.src}
              outline={icon.outline}
              alt=""
              credit={false}
              className="size-full"
            />
          ) : (
            <div className="grid size-full place-items-center bg-lichen">
              <HabitatIcon size={24} aria-hidden="true" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="font-serif text-xl leading-[1.1] tracking-tight text-balance sm:text-2xl">
              <Link
                href={assetHref(h.asset_id)}
                className="outline-none after:absolute after:inset-0 after:rounded-3xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                {h.asset_name}
              </Link>
            </h3>
            {fill && <FreshBadge fill={fill} />}
          </div>
          <p className="tabular mt-1 text-sm text-muted-foreground">
            <Units holding={h} fill={fill} />{" "}
            {h.shares === 1 ? "unit" : "units"} · {unitPriceText(h.mark_price)}{" "}
            a unit
          </p>
          {grade && (
            <GradeBadge
              grade={grade}
              health={health ?? undefined}
              showLabel
              size="sm"
              className="mt-2"
            />
          )}
        </div>
      </div>

      <StakeChart
        prices={card?.sparkline ?? []}
        paid={h.avg_cost}
        name={h.asset_name}
      />

      <dl className="grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs text-muted-foreground">You paid</dt>
          <dd className="tabular mt-1 text-lg font-light">
            {moneyText(h.cost_basis)}
          </dd>
          <dd className="tabular text-xs text-muted-foreground">
            {unitPriceText(h.avg_cost)} a unit
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Worth now</dt>
          <dd className="tabular mt-1 text-lg font-light">
            {moneyText(h.market_value)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Change in value</dt>
          <dd className="mt-1 text-sm">
            <Change
              amount={h.unrealized_pnl}
              pct={decimal(h.unrealized_pnl_pct)}
              className="flex-wrap font-medium"
            />
          </dd>
        </div>
      </dl>
    </li>
  );
}

const CHART = { width: 240, height: 56 };

/**
 * The stake's latest prices (the card's, up to 30), the line filled lime as a price fill, with
 * a dashed line at the average price paid: above it, the stake is worth more than it cost.
 */
function StakeChart({
  prices,
  paid,
  name,
}: {
  prices: readonly string[];
  paid: string | null | undefined;
  name: string;
}) {
  const values = useMemo(
    () => prices.map(decimal).filter((v): v is number => v !== null),
    [prices],
  );
  const paidPrice = decimal(paid);
  const chart = useMemo(
    () => stakeChart(values, paidPrice, CHART),
    [values, paidPrice],
  );
  if (!chart)
    return (
      <p className="text-xs text-muted-foreground lg:text-center">
        Its price chart starts after a few more trades.
      </p>
    );
  const first = values[0]!;
  const last = values[values.length - 1]!;
  return (
    <figure className="min-w-0">
      <svg
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        preserveAspectRatio="none"
        className="block h-14 w-full overflow-visible"
        role="img"
        aria-label={`${name}: its latest ${values.length} prices, from ${unitPrice(first)} to ${unitPrice(last)} a unit${paidPrice === null ? "" : `; you paid ${unitPrice(paidPrice)} a unit`}.`}
      >
        <path d={chart.area} className="fill-lime/25" />
        {chart.paidY !== null && (
          <line
            x1="0"
            x2={CHART.width}
            y1={chart.paidY}
            y2={chart.paidY}
            className="stroke-foreground/45"
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={chart.line}
          fill="none"
          className="stroke-primary"
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span
          aria-hidden="true"
          className="w-3 border-t border-dashed border-foreground/45"
        />
        What you paid, against its latest prices
      </figcaption>
    </figure>
  );
}

/** A boundary map stands in for at least one stake's thumbnail: its credit goes below. */
function showsMap(holdings: HoldingOut[], cards: Map<string, AssetCard>) {
  return holdings.some((h) => {
    const icon = siteIcon(cards.get(h.asset_id));
    return icon !== null && !icon.siteKey && !icon.src;
  });
}

/** A share of land: hectares, or square metres below a tenth of one. */
function area(hectares: number): string {
  return hectares >= 0.1
    ? `${hectares.toFixed(2)} ha`
    : `${int(Math.max(1, Math.round(hectares * 10_000)))} m²`;
}

/**
 * The holder's share of what their sites do: land, stored carbon and nature's services, by the
 * units they hold (the API's ImpactSummary). Attribution only, never a credit.
 */
function Impact({ data }: { data: PortfolioOut }) {
  const hectares = decimal(data.impact.ha_protected) ?? 0;
  const carbon = decimal(data.impact.t_co2_stored) ?? 0;
  const services = decimal(data.impact.services_usd_yr) ?? 0;
  const none = hectares <= 0 && carbon <= 0 && services <= 0;
  return (
    <section
      aria-labelledby="impact-title"
      className="rounded-3xl bg-lichen p-6 sm:p-8"
    >
      <h2 id="impact-title" className="text-base font-semibold">
        What your stakes keep alive
      </h2>
      {none ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Impact figures for your stakes aren&apos;t available yet.
        </p>
      ) : (
        <>
          <ul className="mt-5 space-y-5">
            <ImpactFigure
              icon={HabitatIcon}
              value={area(hectares)}
              label="of living land"
              note="Your share of the sites' area"
            />
            <ImpactFigure
              icon={CarbonIcon}
              value={`${carbon.toFixed(1)} tCO₂`}
              label="stored carbon"
              note="Held in the land's plants and soil"
            />
            <ImpactFigure
              icon={WorthRangeIcon}
              value={`${money(services)} a year`}
              label="of nature's services"
              note="Water, flood protection, habitat and more"
            />
          </ul>
          <p className="mt-6 text-xs text-muted-foreground">
            Your share, by the units you hold. Attribution only, not a carbon
            credit or offset.
          </p>
        </>
      )}
    </section>
  );
}

function ImpactFigure({
  icon: Icon,
  value,
  label,
  note,
}: {
  icon: LucideIcon;
  value: string;
  label: string;
  note: string;
}) {
  return (
    <li className="flex items-start gap-4">
      {/* An icon tile is a rounded square (DESIGN.md, Shapes). */}
      <span className="grid size-11 shrink-0 place-items-center rounded-[14px] bg-card text-foreground">
        <Icon size={22} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="tabular block text-2xl leading-tight font-light tracking-[-0.03em] text-foreground">
          {value}
        </span>{" "}
        <span className="block text-sm text-foreground">{label}</span>{" "}
        <span className="block text-xs text-muted-foreground">{note}</span>
      </span>
    </li>
  );
}

function asGrade(value: string | null | undefined): Grade | null {
  return GRADE_ORDER.find((grade) => grade === value) ?? null;
}
