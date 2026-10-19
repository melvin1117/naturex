"use client";

import { Leaf, RefreshCwIcon, Sprout, Trees } from "lucide-react";
import Link from "next/link";

import { Delta, SiteThumb, Stat } from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { Portfolio as PrototypePortfolio } from "@/components/proto/portfolio";
import { Panel } from "@/components/proto/report-panels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AssetCard, HoldingOut, PortfolioOut } from "@/lib/api/types";
import { useAssets, usePortfolio, useWorld } from "@/lib/hooks";
import type { Grade } from "@/lib/prototype/data";
import { GRADE_ORDER, int, price } from "@/lib/prototype/format";
import { decimal } from "@/lib/trade";

/**
 * `/portfolio`: the signed-in account's real stakes. `<RequireAccount allowPrototypeDemo>`
 * also lets an anonymous visitor in the scripted demo through; they see the prototype's
 * scripted portfolio until T65 gives the demo real sessions.
 */
export function PortfolioScreen() {
  const { world } = useWorld();
  return world?.me ? (
    <PortfolioView name={world.me.name} />
  ) : (
    <PrototypePortfolio />
  );
}

export function PortfolioView({ name }: { name: string }) {
  const portfolio = usePortfolio();
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Your stakes
      </h1>
      <p className="mt-3 text-muted-foreground">
        {name}&apos;s sandbox account. Everything here is play money.
      </p>
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
        <div
          role="status"
          aria-label="Loading your stakes"
          className="mt-8 space-y-6"
        >
          <div className="h-28 animate-pulse rounded-3xl bg-muted" />
          <div className="h-64 animate-pulse rounded-3xl bg-muted" />
        </div>
      )}
    </div>
  );
}

function PortfolioBody({ data }: { data: PortfolioOut }) {
  const assets = useAssets();
  const cards = new Map((assets.data ?? []).map((card) => [card.id, card]));
  const pnlPct = decimal(data.unrealized_pnl_pct);
  return (
    <>
      <div className="mt-8 grid gap-4 rounded-3xl bg-card p-6 shadow-soft sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Play money available" value={money(data.cash_balance)} />
        <Stat
          label="Value of stakes"
          value={money(data.holdings_value)}
          sub={
            pnlPct !== null && (
              <Delta value={pnlPct} suffix="vs cost" className="text-xs" />
            )
          }
        />
        <Stat label="Total" value={money(data.total_value)} />
        <Stat
          label="Total profit and loss"
          value={signedMoney(data.unrealized_pnl)}
          sub="unrealised, at today's prices"
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel title="Holdings">
          {data.holdings.length === 0 ? (
            <div className="py-8 text-center">
              <Sprout
                className="mx-auto size-8 text-lime-ink"
                aria-hidden="true"
              />
              <p className="mt-3 text-muted-foreground">
                No stakes yet. Every rated site in the Marketplace is open for
                play-money stakes.
              </p>
              <Button asChild className="mt-4">
                <Link href="/">Back your first site</Link>
              </Button>
            </div>
          ) : (
            <HoldingsTable holdings={data.holdings} cards={cards} />
          )}
        </Panel>
        <ImpactCard data={data} />
      </div>
    </>
  );
}

function HoldingsTable({
  holdings,
  cards,
}: {
  holdings: HoldingOut[];
  cards: Map<string, AssetCard>;
}) {
  return (
    <div className="-mx-6 overflow-x-auto px-6">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Site</TableHead>
            <TableHead>Grade</TableHead>
            <TableHead className="text-right">Units</TableHead>
            <TableHead className="text-right">Avg cost</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Profit and loss</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {holdings.map((h) => {
            const card = cards.get(h.asset_id);
            const grade = asGrade(card?.grade);
            const pnlPct = decimal(h.unrealized_pnl_pct);
            return (
              <TableRow key={h.asset_id}>
                <TableCell>
                  <Link
                    href={`/asset/${h.asset_id}`}
                    className="flex items-center gap-3 font-medium hover:underline"
                  >
                    {card?.site_key ? (
                      <SiteThumb
                        siteKey={card.site_key}
                        alt=""
                        className="size-10 shrink-0 rounded-xl"
                      />
                    ) : (
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-lichen">
                        <Leaf
                          className="size-4 text-lime-ink"
                          aria-hidden="true"
                        />
                      </span>
                    )}
                    {h.asset_name}
                  </Link>
                </TableCell>
                <TableCell>
                  {grade ? (
                    <GradeBadge grade={grade} size="sm" />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="tabular text-right">
                  {int(h.shares)}
                </TableCell>
                <TableCell className="tabular text-right">
                  {money(h.avg_cost)}
                </TableCell>
                <TableCell className="tabular text-right">
                  {money(h.mark_price)}
                </TableCell>
                <TableCell className="tabular text-right">
                  {money(h.market_value)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="tabular">{signedMoney(h.unrealized_pnl)}</div>
                  {pnlPct !== null && (
                    <Delta value={pnlPct} className="text-xs" />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function ImpactCard({ data }: { data: PortfolioOut }) {
  const hectares = decimal(data.impact.ha_protected) ?? 0;
  const carbon = decimal(data.impact.t_co2_stored) ?? 0;
  const services = decimal(data.impact.services_usd_yr) ?? 0;
  const known = hectares > 0 || carbon > 0 || services > 0;
  return (
    <section
      aria-labelledby="impact-title"
      className="relative self-start overflow-hidden rounded-3xl bg-machine p-6 text-machine-ink shadow-soft"
    >
      <h2 id="impact-title" className="text-base font-semibold">
        Your share of the impact
      </h2>
      <p className="mt-1 text-sm text-machine-muted">
        Your units as a share of each site&apos;s land, stored carbon and
        nature&apos;s services.
      </p>
      {known ? (
        <ul className="mt-5 space-y-4">
          <ImpactLine
            icon={<Trees className="size-5" aria-hidden="true" />}
            tone="bg-lime"
            value={`${hectares.toFixed(2)} ha`}
            label="of living land supported"
          />
          <ImpactLine
            icon={<Leaf className="size-5" aria-hidden="true" />}
            tone="bg-lilac"
            value={`${carbon.toFixed(1)} tCO₂`}
            label="stored carbon, attributable share"
          />
          <ImpactLine
            icon={<Sprout className="size-5" aria-hidden="true" />}
            tone="bg-sky"
            value={`${price(services)}/yr`}
            label="of nature's services"
          />
        </ul>
      ) : (
        <p className="mt-5 text-sm text-machine-muted">
          {data.holdings.length === 0
            ? "Back a site to see the hectares, carbon and services your stake supports."
            : "Impact figures for your stakes aren't available yet."}
        </p>
      )}
      <p className="mt-5 text-xs text-machine-muted">
        Attribution only. Not a carbon credit or offset.
      </p>
    </section>
  );
}

function ImpactLine({
  icon,
  tone,
  value,
  label,
}: {
  icon: React.ReactNode;
  tone: string;
  value: string;
  label: string;
}) {
  return (
    <li className="flex items-center gap-3">
      <span
        className={`grid size-10 place-items-center rounded-2xl text-machine ${tone}`}
      >
        {icon}
      </span>
      <div>
        <div className="tabular text-2xl font-light">{value}</div>
        <div className="text-xs text-machine-muted">{label}</div>
      </div>
    </li>
  );
}

function asGrade(value: string | null | undefined): Grade | null {
  return GRADE_ORDER.find((grade) => grade === value) ?? null;
}

function money(value: string | null | undefined): string {
  const n = decimal(value);
  return n === null ? "—" : price(n);
}

/** "+$12.34", "−$5.00" or "$0.00": the API's P&L with its sign spelt out. */
function signedMoney(value: string | null | undefined): string {
  const n = decimal(value);
  if (n === null) return "—";
  if (n === 0) return price(0);
  return `${n > 0 ? "+" : "−"}${price(Math.abs(n))}`;
}
