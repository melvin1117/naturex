"use client";

import { ArrowLeft, Bot, Lock, MapPin, MessageCircle } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";

import { Delta, SiteBackdrop, ValueRange } from "@/components/proto/bits";
import { PriceChart } from "@/components/proto/charts";
import { GradeBadge } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { ApiLedgerTab } from "@/components/proto/ledger-panels";
import { LoadError } from "@/components/proto/load-error";
import {
  LandPanel,
  NewsList,
  Panel,
  ReportTab,
  ScorePanel,
  ServicesPanel,
  TrendPanel,
} from "@/components/proto/report-panels";
import { IMAGERY_ATTRIBUTION } from "@/components/proto/site-map";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorldGate } from "@/components/world-provider";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, SiteImages } from "@/lib/api/types";
import { boundaryLatLngs, chartPrices, newsItems } from "@/lib/asset-detail";
import { demoSiteMediaUrl } from "@/lib/demo-site-images";
import {
  useAsset,
  useAssetPrices,
  useAssetReports,
  useSiteImages,
} from "@/lib/hooks";
import { countryName, siteImageUrl } from "@/lib/market-cards";
import type { LatLng } from "@/lib/prototype/data";
import {
  GRADE_LABEL,
  ha,
  int,
  price as fmtPrice,
  quarterLabel,
} from "@/lib/prototype/format";
import { num, reportFacts, type ReportFacts } from "@/lib/report-facts";

const TABS = ["overview", "price", "report", "news", "ledger"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  price: "Price",
  report: "Report",
  news: "News",
  ledger: "Ledger",
};

/** The asset page for a real asset: report, charts, map, prices and ledger from the API. */
export function AssetView({ id }: { id: string }) {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Marketplace
      </Link>
      <div className="mt-4">
        <WorldGate>
          <AssetBody id={id} />
        </WorldGate>
      </div>
    </div>
  );
}

function AssetBody({ id }: { id: string }) {
  const asset = useAsset(id);

  if (!asset.data && asset.error)
    return asset.error.status === 404 || asset.error.status === 422 ? (
      <NotFound />
    ) : (
      <LoadError
        title="We couldn't load this site"
        error={asset.error}
        retry={asset.refetch}
      />
    );
  if (!asset.data)
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-2 rounded-[2rem] bg-card py-24 text-sm text-muted-foreground shadow-soft"
      >
        <Spinner aria-hidden="true" role="presentation" />
        Loading the site…
      </div>
    );
  return <AssetLoaded asset={asset.data} />;
}

function NotFound() {
  return (
    <div className="mx-auto max-w-3xl py-16 text-center">
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

function AssetLoaded({ asset }: { asset: AssetDetail }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "overview";

  const reports = useAssetReports(asset.id);
  const prices = useAssetPrices(asset.id);
  const images = useSiteImages(asset.site_key);

  const latest = useMemo(
    () => (asset.latest_report ? reportFacts(asset.latest_report) : null),
    [asset.latest_report],
  );
  const versions = useMemo(() => {
    const listed = (reports.data ?? []).flatMap((r) => {
      const facts = reportFacts(r);
      return facts ? [facts] : [];
    });
    return listed.length ? listed : latest ? [latest] : [];
  }, [reports.data, latest]);
  const prev = latest
    ? versions.find((r) => r.version === latest.version - 1)
    : undefined;
  const points = useMemo(() => chartPrices(prices.data), [prices.data]);
  const current = num(asset.price);
  const change = num(asset.price_change_pct);
  const polygon = useMemo(
    () => boundaryLatLngs(asset.geojson),
    [asset.geojson],
  );
  const news = useMemo(
    () => newsItems(asset.recent_events),
    [asset.recent_events],
  );
  const imageUrl = siteImageUrl(asset.site_key);
  const place = [
    countryName(asset.country ?? null),
    ha(num(asset.area_ha) ?? 0),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <title>{`${asset.name} · NatureX`}</title>
      <section
        className="relative isolate overflow-hidden rounded-[2rem] text-white shadow-lift"
        aria-labelledby="site-title"
      >
        <SiteBackdrop src={imageUrl} />
        <div className="relative grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_auto] lg:p-10">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm text-white/85">
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden="true" />
                {place}
              </span>
              {asset.status === "suspended" && (
                <span className="rounded-full bg-clay px-2.5 py-0.5 text-xs font-medium text-white">
                  Trading paused
                </span>
              )}
            </div>
            <h1
              id="site-title"
              className="mt-3 font-serif text-5xl leading-[1.02] tracking-tight break-words sm:text-6xl"
            >
              {asset.name}
            </h1>
            {asset.description && (
              <p className="mt-3 max-w-2xl text-white/85">
                {asset.description}
              </p>
            )}
            {latest && (
              <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:max-w-2xl">
                {latest.valueLow !== null &&
                latest.valueMid !== null &&
                latest.valueHigh !== null ? (
                  <ValueRange
                    low={latest.valueLow}
                    mid={latest.valueMid}
                    high={latest.valueHigh}
                    confidence={latest.confidence}
                    tone="image"
                  />
                ) : (
                  <div>
                    <div className="text-sm text-white/75">Annual value</div>
                    <div className="text-2xl font-light">Not available</div>
                    <p className="text-xs text-white/75">
                      {latest.confidence.toFixed(0)}% confidence
                    </p>
                  </div>
                )}
                <div>
                  <div className="text-sm text-white/75">
                    Stake price · play money
                  </div>
                  <div className="tabular text-4xl font-light tracking-tight">
                    {current === null ? "—" : fmtPrice(current)}
                  </div>
                  {change !== null && (
                    <Delta
                      value={change}
                      suffix="since opening"
                      className="text-white [&_span]:text-white/90"
                    />
                  )}
                </div>
              </div>
            )}
          </div>
          {latest && (
            <div className="flex flex-col items-center gap-4 rounded-[1.75rem] bg-white/10 p-6 backdrop-blur-md lg:w-72">
              <HealthRing value={latest.health} tone="dark" size={180} />
              <div className="text-center">
                <GradeBadge grade={latest.grade} size="lg" />
                <p className="mt-2 text-sm text-white/85">
                  {GRADE_LABEL[latest.grade]}
                </p>
                {prev && prev.grade !== latest.grade && (
                  <p className="mt-1 text-xs text-white/70">
                    Was {prev.grade} in report v{prev.version}
                  </p>
                )}
                <p className="mt-1 text-xs text-white/70">
                  Report v{latest.version}
                  {latest.period && ` · ${quarterLabel(latest.period)}`}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {!latest ? (
        <p className="mt-8 rounded-3xl bg-card p-8 text-center text-muted-foreground shadow-soft">
          This site hasn&apos;t been rated yet.
        </p>
      ) : (
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Tabs
            value={tab}
            // The History API keeps useSearchParams in sync without a server round trip
            // (which would also reset the page title to the route's metadata).
            onValueChange={(v) =>
              window.history.replaceState(null, "", `${pathname}?tab=${v}`)
            }
            className="min-w-0 gap-6"
          >
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <TabsList className="bg-card shadow-soft">
                {TABS.map((t) => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  >
                    {TAB_LABEL[t]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent value="overview" className="space-y-6">
              <div className="grid gap-6 xl:grid-cols-2">
                <ServicesPanel facts={latest} />
                <ScorePanel facts={latest} />
              </div>
              <LandPanel
                polygon={polygon}
                label={asset.name}
                overlay={overlayFor(asset.site_key, images.data)}
                landcover={latest.landcover}
                simulated={latest.simulated}
                caption={images.data && overlayCaption(images.data)}
              />
              <TrendPanel facts={latest} />
            </TabsContent>
            <TabsContent value="price">
              <PricePanel
                points={points}
                news={news}
                facts={latest}
                loading={prices.isLoading && !prices.data}
                error={prices.data ? null : prices.error}
                retry={prices.refetch}
              />
            </TabsContent>
            <TabsContent value="report">
              {reports.error && !reports.data && (
                <p role="alert" className="mb-4 text-sm text-muted-foreground">
                  Showing the latest report only: {reports.error.message}
                </p>
              )}
              <ReportTab versions={versions} />
            </TabsContent>
            <TabsContent value="news">
              <Panel title="News and evidence near this site">
                <NewsList
                  events={news}
                  empty="No news or evidence has been recorded for this site yet."
                />
              </Panel>
            </TabsContent>
            <TabsContent value="ledger">
              <ApiLedgerTab assetId={asset.id} />
            </TabsContent>
          </Tabs>

          <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
            <TradeComingSoon asset={asset} price={current} />
            <section className="rounded-3xl bg-card p-6 shadow-soft">
              <h2 className="text-base font-semibold">Ask about this site</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The Copilot and the Agent Trace for real sites are coming soon.
                The guided tour shows both on the scripted demo world.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled>
                  <MessageCircle aria-hidden="true" />
                  Open Copilot
                </Button>
                <Button variant="ghost" size="sm" disabled>
                  <Bot aria-hidden="true" />
                  How it was rated
                </Button>
              </div>
            </section>
          </aside>
        </div>
      )}

      <DataAttribution facts={latest} images={images.data} />
    </>
  );
}

function overlayFor(
  siteKey: string | null | undefined,
  images: SiteImages | undefined,
): { url: string; bounds: [LatLng, LatLng] } | null {
  const bounds = images?.overlay.bounds;
  if (!siteKey || !bounds) return null;
  return {
    url: demoSiteMediaUrl(siteKey, "overlay.png"),
    bounds: [
      [bounds[0][0], bounds[0][1]],
      [bounds[1][0], bounds[1][1]],
    ],
  };
}

function overlayCaption(images: SiteImages) {
  const { start, end } = images.overlay.date_window;
  return (
    <>
      Overlay: Dynamic World land-cover mode, {start} to {end}.{" "}
      {images.scenario_note}
    </>
  );
}

function PricePanel({
  points,
  news,
  facts,
  loading,
  error,
  retry,
}: {
  points: ReturnType<typeof chartPrices>;
  news: ReturnType<typeof newsItems>;
  facts: ReportFacts;
  loading: boolean;
  error: ApiError | null;
  retry: () => Promise<void>;
}) {
  return (
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
            Negative news
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-full bg-lime-ink"
              aria-hidden="true"
            />{" "}
            Positive news
          </span>
        </span>
      }
    >
      {error ? (
        <LoadError
          title="We couldn't load the price history"
          error={error}
          retry={retry}
        />
      ) : loading ? (
        <p
          role="status"
          className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
        >
          <Spinner aria-hidden="true" role="presentation" />
          Loading prices…
        </p>
      ) : points.length > 1 ? (
        <PriceChart prices={points} events={news} perDay={false} />
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {points[0]
            ? `Opened at ${fmtPrice(points[0].price)}. The chart fills in as supporters trade.`
            : "No trades yet."}
        </p>
      )}
      {facts.fairValuePerUnit !== null && (
        <p className="mt-4 text-xs text-muted-foreground">
          The price moves with orders and drifts toward the fair price set by
          each rating ({fmtPrice(facts.fairValuePerUnit)} now); a re-rate moves
          it part of the way there at once. Play money only.
        </p>
      )}
    </Panel>
  );
}

function TradeComingSoon({
  asset,
  price,
}: {
  asset: AssetDetail;
  price: number | null;
}) {
  return (
    <section
      className="rounded-3xl bg-card p-6 shadow-soft"
      aria-labelledby="trade-title"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="trade-title" className="text-base font-semibold">
          Back this site
        </h2>
        <span className="text-xs text-muted-foreground">Play money only</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Stake price</dt>
          <dd className="tabular text-xl font-light">
            {price === null ? "—" : fmtPrice(price)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Opening units left</dt>
          <dd className="tabular text-xl font-light">
            {int(asset.primary_shares_remaining)}
          </dd>
          <dd className="text-xs text-muted-foreground">
            of {int(asset.total_shares)}
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex gap-3 rounded-2xl bg-secondary p-4 text-sm">
        <Lock
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <p>
          Trading from this page is coming soon. The guided tour shows a trade
          on the scripted demo world.
        </p>
      </div>
      <Button className="mt-4 w-full" disabled>
        Buy units
      </Button>
    </section>
  );
}

function DataAttribution({
  facts,
  images,
}: {
  facts: ReportFacts | null;
  images: SiteImages | undefined;
}) {
  const lines = [
    ...new Set([
      ...(facts?.attributions ?? []),
      ...(images?.overlay.attributions ?? []),
      ...(images?.thumbnail?.attributions ?? []),
      IMAGERY_ATTRIBUTION,
    ]),
  ];
  return (
    <section
      aria-labelledby="data-sources"
      className="mt-12 rounded-3xl border border-border/70 px-6 py-5 text-xs text-muted-foreground"
    >
      <h2 id="data-sources" className="font-medium text-foreground">
        Data behind this page
        {facts?.period && ` · ${quarterLabel(facts.period)} report`}
      </h2>
      <ul className="mt-2 space-y-1 leading-relaxed">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-2">
        Values are screening estimates from published benefit-transfer
        coefficients, not appraisals. Prices are play money; nothing here is a
        real security.
      </p>
    </section>
  );
}
