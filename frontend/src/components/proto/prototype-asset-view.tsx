"use client";

import { ArrowLeft, MapPin, MessageCircle } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Delta, SiteBackdrop, ValueRange } from "@/components/proto/bits";
import { PriceChart } from "@/components/proto/charts";
import { LedgerTab } from "@/components/proto/ledger-panels";
import { GradeBadge } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import {
  LandPanel,
  NewsList,
  Panel,
  ReportTab,
  type NewsItem,
  ScorePanel,
  ServicesPanel,
  TrendPanel,
  VerificationTab,
} from "@/components/proto/report-panels";
import { TradePanel } from "@/components/proto/trade-panel";
import { VerificationBadge } from "@/components/proto/verification";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RatingTraceCard } from "@/components/trace/rating-trace-card";
import {
  date,
  GRADE_LABEL,
  ha,
  price,
  quarterLabel,
} from "@/lib/prototype/format";
import { siteDataFor } from "@/lib/prototype/data";
import { prototypeFacts } from "@/lib/prototype/rating";
import { usePrototype } from "@/lib/prototype/store";
import {
  changeSinceOpen,
  latestReport,
  previousReport,
  type NewsEvent,
} from "@/lib/prototype/world";

const TABS = [
  "overview",
  "price",
  "report",
  "news",
  "ledger",
  "verification",
] as const;
type Tab = (typeof TABS)[number];

function newsItem(e: NewsEvent): NewsItem {
  return {
    ...e,
    kind: e.kind,
    sourceLabel:
      e.source === "time_machine"
        ? "Injected by Time Machine"
        : "Found by News Scout",
    sample: true,
  };
}

/**
 * The asset page on the prototype's scripted world, for prototype site IDs (the guided tour,
 * Steward, Portfolio and Control room still link here). Real asset IDs render `AssetView`.
 */
export function PrototypeAssetView({ id }: { id: string }) {
  const { world, openCopilot, openTrace } = usePrototype();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const site = world.sites.find((s) => s.id === id);
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "overview";

  if (!site) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h1 className="font-serif text-4xl">Site not found</h1>
        <p className="mt-2 text-muted-foreground">
          That site doesn&apos;t exist in your sandbox. It may have been removed
          when the demo was reset.
        </p>
        <Button asChild className="mt-6">
          <Link href="/">Back to the Marketplace</Link>
        </Button>
      </div>
    );
  }

  const report = latestReport(site);
  const prev = previousReport(site);
  const events = world.events.filter((e) => e.siteId === site.id);
  const lastRun = [...world.runs].reverse().find((r) => r.siteId === site.id);
  const siteAlerts = world.alerts
    .filter((a) => a.siteId === site.id && a.persona === "investor")
    .slice(0, 3);

  return (
    <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Marketplace
      </Link>

      <section
        className="relative isolate mt-4 overflow-hidden rounded-[2rem] text-white shadow-lift"
        aria-labelledby="site-title"
      >
        <SiteBackdrop siteKey={site.key} />
        <div className="relative grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_auto] lg:p-10">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm text-white/85">
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 backdrop-blur">
                {site.ecosystem}
              </span>
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden="true" />
                {site.place}
              </span>
              <span aria-hidden="true">·</span>
              <span>{ha(site.areaHa)}</span>
              <VerificationBadge
                level={site.verification}
                tone="image"
                compact
              />
            </div>
            <h1
              id="site-title"
              className="mt-3 font-serif text-5xl leading-[1.02] tracking-tight sm:text-6xl"
            >
              {site.name}
            </h1>
            <p className="mt-3 max-w-2xl text-white/85">{site.description}</p>
            <p className="mt-2 text-sm text-white/70">
              Stewarded by {site.community}
            </p>
            {report && (
              <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:max-w-2xl">
                <ValueRange
                  low={report.valueLow}
                  mid={report.valueMid}
                  high={report.valueHigh}
                  confidence={report.confidence}
                  tone="image"
                />
                <div>
                  <div className="text-sm text-white/75">
                    Stake price · play money
                  </div>
                  <div className="tabular text-4xl font-light tracking-tight">
                    {price(site.price)}
                  </div>
                  <Delta
                    value={changeSinceOpen(site)}
                    suffix="since opening"
                    className="text-white [&_span]:text-white/90"
                  />
                </div>
              </div>
            )}
          </div>
          {report && (
            <div className="flex flex-col items-center gap-4 rounded-[1.75rem] bg-white/10 p-6 backdrop-blur-md lg:w-72">
              <HealthRing value={report.health} tone="dark" size={180} />
              <div className="text-center">
                <GradeBadge grade={report.grade} size="lg" />
                <p className="mt-2 text-sm text-white/85">
                  {GRADE_LABEL[report.grade]}
                </p>
                {prev && prev.grade !== report.grade && (
                  <p className="mt-1 text-xs text-white/70">
                    Was {prev.grade} in report v{prev.version}
                  </p>
                )}
                <p className="mt-1 text-xs text-white/70">
                  Report v{report.version} · {quarterLabel(report.period)}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {!report ? (
        <p className="mt-8 rounded-3xl bg-card p-8 text-center text-muted-foreground shadow-soft">
          This site hasn&apos;t been rated yet.
        </p>
      ) : (
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Tabs
            value={tab}
            onValueChange={(v) =>
              router.replace(`${pathname}?tab=${v}`, { scroll: false })
            }
            className="min-w-0 gap-6"
          >
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <TabsList className="bg-card shadow-soft">
                <TabsTrigger
                  value="overview"
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  Overview
                </TabsTrigger>
                <TabsTrigger
                  value="price"
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  Price
                </TabsTrigger>
                <TabsTrigger
                  value="report"
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  Report
                </TabsTrigger>
                <TabsTrigger
                  value="news"
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  News
                </TabsTrigger>
                <TabsTrigger
                  value="ledger"
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  Ledger
                </TabsTrigger>
                <TabsTrigger
                  value="verification"
                  className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  Verification
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="overview" className="space-y-6">
              <div className="grid gap-6 xl:grid-cols-2">
                <ServicesPanel facts={prototypeFacts(report)} />
                <ScorePanel facts={prototypeFacts(report)} />
              </div>
              <LandPanel
                polygon={site.polygon}
                label={site.name}
                overlay={{
                  url: `/demo-sites/${site.key}.overlay.png`,
                  bounds: siteDataFor(site.key).overlayBounds,
                }}
                landcover={report.landcover}
                simulated={report.scenario !== "baseline"}
              />
              <TrendPanel facts={prototypeFacts(report)} />
            </TabsContent>
            <TabsContent value="price">
              <Panel
                title="Stake price"
                action={
                  <span className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="size-2.5 rounded-full border-2 border-primary bg-card"
                        aria-hidden="true"
                      />{" "}
                      Opening and re-rates
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="size-2.5 rounded-full bg-clay"
                        aria-hidden="true"
                      />{" "}
                      Negative event
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="size-2.5 rounded-full bg-lime-ink"
                        aria-hidden="true"
                      />{" "}
                      Positive event
                    </span>
                  </span>
                }
              >
                {site.prices.length > 1 ? (
                  <PriceChart prices={site.prices} events={events} />
                ) : (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    Opened today at {price(site.prices[0]?.price ?? site.price)}
                    . The chart fills in as supporters trade.
                  </p>
                )}
                <p className="mt-4 text-xs text-muted-foreground">
                  The price moves with orders and drifts toward the fair price
                  set by each rating ({price(report.fairValuePerUnit)} now). On
                  a re-rate it moves 35% of the way at once. Play money only.
                </p>
              </Panel>
            </TabsContent>
            <TabsContent value="report">
              <ReportTab
                versions={[...site.reports]
                  .reverse()
                  .map((r) => prototypeFacts(r))}
              />
            </TabsContent>
            <TabsContent value="news">
              <Panel title="News and evidence near this site">
                <NewsList events={[...events].reverse().map(newsItem)} />
              </Panel>
            </TabsContent>
            <TabsContent value="ledger">
              <LedgerTab site={site} />
            </TabsContent>
            <TabsContent value="verification">
              <VerificationTab site={site} />
            </TabsContent>
          </Tabs>

          <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
            <TradePanel site={site} />
            <RatingTraceCard
              onOpen={lastRun ? () => openTrace(lastRun.id) : undefined}
              tourAnchor="trace-button"
            />
            <section className="rounded-3xl bg-card p-6 shadow-soft">
              <h2 className="text-base font-semibold">Ask about this site</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The Copilot answers from this site&apos;s reports, news and
                ledger, with sources.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openCopilot(site.id)}
                >
                  <MessageCircle aria-hidden="true" />
                  Open Copilot
                </Button>
              </div>
            </section>
            {siteAlerts.length > 0 && (
              <section className="rounded-3xl bg-card p-6 shadow-soft">
                <h2 className="text-base font-semibold">Recent alerts</h2>
                <ul className="mt-3 space-y-3">
                  {siteAlerts.map((a) => (
                    <li key={a.id} className="text-sm">
                      <div className="font-medium">{a.title}</div>
                      <div className="text-muted-foreground">{a.message}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {date(a.date)}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
