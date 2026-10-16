"use client";

import { Leaf, Trees } from "lucide-react";
import Link from "next/link";

import { Delta, SiteThumb, Stat } from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { Panel } from "@/components/proto/report-panels";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { date, int, price } from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
import {
  actingTrader,
  latestReport,
  PERSONAS,
  type TraderKey,
} from "@/lib/prototype/world";

export function Portfolio() {
  const { world } = usePrototype();
  // Admins don't hold stakes; the page then shows Arjun's account with a note.
  const trader: TraderKey = actingTrader(world.persona) ?? "investor";
  const holdings = world.holdings[trader]
    .map((h) => {
      const site = world.sites.find((s) => s.id === h.siteId)!;
      const report = latestReport(site);
      return {
        ...h,
        site,
        report,
        value: h.units * site.price,
        cost: h.units * h.avgCost,
      };
    })
    .filter((h) => h.site);
  const cash = world.cash[trader];
  const invested = holdings.reduce((s, h) => s + h.value, 0);
  const cost = holdings.reduce((s, h) => s + h.cost, 0);
  const change = cost ? ((invested - cost) / cost) * 100 : 0;
  const hectares = holdings.reduce(
    (s, h) => s + (h.units / h.site.totalUnits) * h.site.areaHa,
    0,
  );
  const carbon = holdings.reduce(
    (s, h) => s + (h.units / h.site.totalUnits) * (h.report?.carbon.stock ?? 0),
    0,
  );
  const fundsRaised = world.orders
    .filter((o) => o.trader === trader)
    .reduce((s, o) => s + o.primaryUnits * o.fill, 0);
  const alerts = world.alerts.filter((a) => a.persona === trader);
  const orders = world.orders.filter((o) => o.trader === trader).slice(0, 8);

  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
            Your stakes
          </h1>
          <p className="mt-3 text-muted-foreground">
            {PERSONAS[trader].name}&apos;s sandbox account. Everything here is
            play money.
          </p>
        </div>
        {world.persona === "admin" && (
          <p className="rounded-full bg-secondary px-4 py-2 text-sm text-muted-foreground">
            Showing Arjun&apos;s account. Admins don&apos;t hold stakes.
          </p>
        )}
      </div>

      <dl className="mt-8 grid gap-4 rounded-3xl bg-card p-6 shadow-soft sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Play money available" value={price(cash)} />
        <Stat
          label="Value of stakes"
          value={price(invested)}
          sub={<Delta value={change} suffix="vs cost" className="text-xs" />}
        />
        <Stat label="Total" value={price(cash + invested)} />
        <Stat
          label="Paid to communities"
          value={price(fundsRaised)}
          sub="from your primary units"
        />
      </dl>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-8">
          <Panel title="Holdings">
            {holdings.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-muted-foreground">
                  No stakes yet. Explore the Marketplace to back a site.
                </p>
                <Button asChild className="mt-4">
                  <Link href="/">Explore the Marketplace</Link>
                </Button>
              </div>
            ) : (
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
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {holdings.map((h) => (
                      <TableRow key={h.siteId}>
                        <TableCell>
                          <Link
                            href={`/asset/${h.siteId}`}
                            className="flex items-center gap-3 font-medium hover:underline"
                          >
                            <SiteThumb
                              siteKey={h.site.key}
                              alt=""
                              className="size-10 shrink-0 rounded-xl"
                            />
                            {h.site.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {h.report && (
                            <GradeBadge grade={h.report.grade} size="sm" />
                          )}
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {int(h.units)}
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {price(h.avgCost)}
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {price(h.site.price)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="tabular">{price(h.value)}</div>
                          <Delta
                            value={
                              ((h.site.price - h.avgCost) / h.avgCost) * 100
                            }
                            className="text-xs"
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
          <Panel title="Recent orders">
            {orders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No orders in this sandbox yet.
              </p>
            ) : (
              <ul className="divide-y text-sm">
                {orders.map((o) => {
                  const site = world.sites.find((s) => s.id === o.siteId);
                  return (
                    <li
                      key={o.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3"
                    >
                      <span className="font-medium capitalize">
                        {o.side === "buy" ? "Bought" : "Sold"}
                      </span>
                      <span className="tabular">{o.units} units</span>
                      <span className="text-muted-foreground">
                        {site?.name}
                      </span>
                      <span className="tabular ml-auto">{price(o.total)}</span>
                      <span className="w-full text-xs text-muted-foreground sm:w-auto">
                        {date(o.date)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
        <aside className="space-y-6">
          <section className="relative overflow-hidden rounded-3xl bg-machine p-6 text-machine-ink shadow-soft">
            <h2 className="text-base font-semibold">
              Your share of the impact
            </h2>
            <p className="mt-1 text-sm text-machine-muted">
              Your units as a share of each site&apos;s land and stored carbon.
            </p>
            <div className="mt-5 space-y-4">
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-2xl bg-lime text-machine">
                  <Trees className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <div className="tabular text-2xl font-light">
                    {hectares.toFixed(2)} ha
                  </div>
                  <div className="text-xs text-machine-muted">
                    of living land supported
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-2xl bg-lilac text-machine">
                  <Leaf className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <div className="tabular text-2xl font-light">
                    {carbon.toFixed(1)} tCO₂
                  </div>
                  <div className="text-xs text-machine-muted">
                    stored carbon, attributable share
                  </div>
                </div>
              </div>
            </div>
            <p className="mt-5 text-xs text-machine-muted">
              Attribution only. Not a carbon credit or offset.
            </p>
          </section>
          <Panel title="Alerts">
            {alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No alerts yet. You&apos;ll hear here when a site you back is
                re-rated.
              </p>
            ) : (
              <ul className="space-y-3">
                {alerts.slice(0, 6).map((a) => (
                  <li key={a.id} className="text-sm">
                    <Link
                      href={`/asset/${a.siteId}`}
                      className="font-medium hover:underline"
                    >
                      {a.title}
                    </Link>
                    <p className="text-muted-foreground">{a.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {date(a.date)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
