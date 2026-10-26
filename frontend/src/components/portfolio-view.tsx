"use client";

import { RefreshCwIcon } from "lucide-react";
import Link from "@/components/app-link";
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";

import {
  CarbonIcon,
  HabitatIcon,
  WorthRangeIcon,
  YourStakesIcon,
} from "@/components/icons";
import { CountTo } from "@/components/live-number";
import { PortfolioBodySkeleton } from "@/components/page-skeletons";
import { Delta, SiteThumb } from "@/components/proto/bits";
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
import {
  assetHref,
  decimal,
  forgetFills,
  freshFills,
  money,
  moneyText,
  signedMoneyText,
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

function Num({ children }: { children: React.ReactNode }) {
  return <span className="tabular text-foreground">{children}</span>;
}

/** "up $12.30 (2.9%)", "down $4.50 (1.1%)" or "level", in the trend's colour. */
function Change({ pnl, pct }: { pnl: string; pct: number | null }) {
  const n = decimal(pnl);
  if (n === null) return <Num>—</Num>;
  if (n === 0) return <Num>level</Num>;
  const pctText = pct === null ? "" : ` (${Math.abs(pct).toFixed(1)}%)`;
  return (
    <span className={cn("tabular", n > 0 ? "text-lime-ink" : "text-clay-ink")}>
      {n > 0 ? "up" : "down"} {money(Math.abs(n))}
      {pctText}
    </span>
  );
}

function PortfolioBody({ data }: { data: PortfolioOut }) {
  const assets = useAssets();
  const cards = new Map((assets.data ?? []).map((card) => [card.id, card]));
  const pnlPct = decimal(data.unrealized_pnl_pct);
  const sites = data.holdings.length;
  // A trade made a moment ago on an asset page: show its stake changing here (#216 WP2).
  const account = useWorld().world?.me?.id;
  const [fresh] = useState(() => freshFills(account));
  useEffect(() => forgetFills(fresh.values()), [fresh]);
  return (
    <>
      <p className="mt-5 max-w-3xl text-xl leading-snug text-pretty text-muted-foreground sm:text-2xl">
        {sites === 0 ? (
          <>
            You have <Num>{moneyText(data.cash_balance)}</Num> to back living
            land.
          </>
        ) : (
          <>
            You back{" "}
            <Num>
              {sites} {sites === 1 ? "site" : "sites"}
            </Num>{" "}
            with stakes worth <Num>{moneyText(data.holdings_value)}</Num>,{" "}
            <Change pnl={data.unrealized_pnl} pct={pnlPct} /> since you bought.{" "}
            <Num>{moneyText(data.cash_balance)}</Num> is left to back more.
          </>
        )}
      </p>
      {sites > 0 && <Impact data={data} />}
      {sites === 0 ? (
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
      ) : (
        <Holdings holdings={data.holdings} cards={cards} fresh={fresh} />
      )}
    </>
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
    <>
      <ul
        aria-label="Stakes"
        className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
      >
        {holdings.map((h) => (
          <HoldingTile
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
    </>
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

function HoldingTile({
  holding: h,
  card,
  fill,
}: {
  holding: HoldingOut;
  card: AssetCard | undefined;
  fill?: FreshFill;
}) {
  const pnlPct = decimal(h.unrealized_pnl_pct);
  const icon = useMemo(() => siteIcon(card), [card]);
  const grade = asGrade(card?.grade);
  return (
    <li
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-3xl bg-card shadow-soft transition-shadow focus-within:shadow-lift hover:shadow-lift",
        fill && "ww-wash",
      )}
      data-fresh={fill ? "" : undefined}
    >
      <div className="relative">
        {icon ? (
          <SiteThumb
            siteKey={icon.siteKey}
            src={icon.src}
            outline={icon.outline}
            alt=""
            credit={false}
            className="aspect-[16/10]"
          />
        ) : (
          <div className="grid aspect-[16/10] place-items-center bg-lichen">
            <HabitatIcon size={32} aria-hidden="true" />
          </div>
        )}
        {grade && (
          <div className="absolute right-3 bottom-3">
            <GradeBadge grade={grade} />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="font-serif text-2xl leading-[1.1] tracking-tight text-balance">
            <Link
              href={assetHref(h.asset_id)}
              className="outline-none after:absolute after:inset-0 after:rounded-3xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              {h.asset_name}
            </Link>
          </h2>
          {fill && <FreshBadge fill={fill} />}
        </div>
        <p className="tabular text-sm text-muted-foreground">
          <Units holding={h} fill={fill} /> {h.shares === 1 ? "unit" : "units"}{" "}
          · {unitPriceText(h.mark_price)} a unit
        </p>
        <dl className="mt-auto flex items-end justify-between gap-3 pt-4">
          <div>
            <dt className="sr-only">Value</dt>
            <dd className="tabular text-2xl font-light">
              {moneyText(h.market_value)}
            </dd>
          </div>
          <div className="text-right">
            <dt className="sr-only">Change since you bought</dt>
            <dd className="tabular text-sm">
              {decimal(h.unrealized_pnl) ? (
                <>
                  {signedMoneyText(h.unrealized_pnl)}
                  {pnlPct !== null && (
                    <Delta value={pnlPct} className="ml-1.5 text-xs" />
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">Level</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
    </li>
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

/** The holder's share of the land, carbon and services their stakes stand for, in one line. */
function Impact({ data }: { data: PortfolioOut }) {
  const hectares = decimal(data.impact.ha_protected) ?? 0;
  const carbon = decimal(data.impact.t_co2_stored) ?? 0;
  const services = decimal(data.impact.services_usd_yr) ?? 0;
  if (hectares <= 0 && carbon <= 0 && services <= 0)
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        Impact figures for your stakes aren&apos;t available yet.
      </p>
    );
  return (
    <section aria-label="Your share of the impact" className="mt-6">
      <ul className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
        <ImpactLine
          icon={<HabitatIcon size={16} aria-hidden="true" />}
          value={area(hectares)}
          label="of living land"
        />
        <ImpactLine
          icon={<CarbonIcon size={16} aria-hidden="true" />}
          value={`${carbon.toFixed(1)} tCO₂`}
          label="stored carbon"
        />
        <ImpactLine
          icon={<WorthRangeIcon size={16} aria-hidden="true" />}
          value={`${money(services)}/yr`}
          label="of nature's services"
        />
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Your share, by the units you hold. Attribution only, not a carbon credit
        or offset.
      </p>
    </section>
  );
}

function ImpactLine({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <span className="grid size-7 place-items-center rounded-full bg-lichen text-foreground">
        {icon}
      </span>
      <span className="tabular font-medium">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </li>
  );
}

function asGrade(value: string | null | undefined): Grade | null {
  return GRADE_ORDER.find((grade) => grade === value) ?? null;
}
