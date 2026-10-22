"use client";

import { ArrowLeft, Bot, MapPin } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { CopilotChat } from "@/components/copilot-chat";
import { FieldEvidencePanel } from "@/components/evidence/field-evidence-panel";
import { AssetBodySkeleton } from "@/components/page-skeletons";
import { Delta, SiteBackdrop, ValueRange } from "@/components/proto/bits";
import { PriceChart, PriceChartSkeleton } from "@/components/proto/charts";
import { GradeBadge } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { ApiLedgerTab } from "@/components/proto/ledger-panels";
import { LoadError } from "@/components/proto/load-error";
import { PriceTick } from "@/components/live-number";
import {
  LandPanel,
  NewsList,
  Panel,
  ReportTab,
  ScorePanel,
  ServicesPanel,
  TrendPanel,
} from "@/components/proto/report-panels";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TradePanel } from "@/components/trade-panel";
import {
  VerificationHeroBadge,
  VerificationPanel,
} from "@/components/verification/verification-panel";
import { WorldGate } from "@/components/world-provider";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, SiteImages } from "@/lib/api/types";
import { boundaryLatLngs, chartPrices, newsItems } from "@/lib/asset-detail";
import { outlineRings } from "@/lib/boundary-map";
import {
  assetLandCover,
  NO_OVERLAY_NOTE,
  type AssetLandCover,
} from "@/lib/land-cover-overlay";
import {
  useAsset,
  useAssetPrices,
  useAssetReports,
  useSiteImages,
} from "@/lib/hooks";
import { countryName, siteImageUrl } from "@/lib/market-cards";
import {
  GRADE_LABEL,
  ha,
  price as fmtPrice,
  quarterLabel,
} from "@/lib/prototype/format";
import { usePrototype } from "@/lib/prototype/store";
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
        <WorldGate
          fallback={<AssetBodySkeleton label="Opening your demo world…" />}
        >
          <AssetBody id={id} />
        </WorldGate>
      </div>
    </div>
  );
}

function AssetBody({ id }: { id: string }) {
  const asset = useAsset(id);
  const fresh = useFetchedSinceMount(asset.isFetching);

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
  if (!asset.data) return <AssetBodySkeleton />;
  return <AssetLoaded asset={asset.data} fresh={fresh} />;
}

/**
 * True once the asset has been read from the API since the page opened: a cached value being
 * refreshed on arrival isn't a price move, so the hero only flashes after this.
 */
function useFetchedSinceMount(isFetching: boolean): boolean {
  const [phase, setPhase] = useState<"idle" | "fetching" | "done">("idle");
  if (phase === "idle" && isFetching) setPhase("fetching");
  if (phase === "fetching" && !isFetching) setPhase("done");
  return phase === "done";
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

function AssetLoaded({
  asset,
  fresh,
}: {
  asset: AssetDetail;
  /** The asset has been read since the page opened (see `useFetchedSinceMount`). */
  fresh: boolean;
}) {
  const pathname = usePathname();
  const { openTrace } = usePrototype();
  const params = useSearchParams();
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "overview";

  const reports = useAssetReports(asset.id);
  const prices = useAssetPrices(asset.id);
  const images = useSiteImages(asset.site_key);
  const landCover = assetLandCover(asset, images.data);

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
  // Versions are newest first: the previous report is the one after the latest.
  const latestIndex = latest
    ? versions.findIndex((r) => r.id === latest.id)
    : -1;
  const prev = latestIndex >= 0 ? versions[latestIndex + 1] : undefined;
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
  const imageUrl = siteImageUrl(asset.site_key, asset.cover_image_url);
  const outline = useMemo(() => outlineRings(asset.outline), [asset.outline]);
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
        <SiteBackdrop src={imageUrl} outline={outline} />
        <div className="relative grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_auto] lg:p-10">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm text-white/85">
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden="true" />
                {place}
              </span>
              <VerificationHeroBadge assetId={asset.id} />
              {asset.status === "suspended" && (
                <span className="rounded-full bg-clay px-2.5 py-0.5 text-xs font-medium text-white">
                  Trading paused
                </span>
              )}
              {asset.status === "listed" && asset.trading !== true && (
                <span className="rounded-full bg-clay px-2.5 py-0.5 text-xs font-medium text-white">
                  Not trading yet
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
                    <PriceTick
                      value={current}
                      format={fmtPrice}
                      tone="image"
                      armed={fresh}
                    />
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
        <div className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
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
              <TabsList className="w-max min-w-full bg-card shadow-soft sm:w-fit sm:min-w-0">
                {TABS.map((t) => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="px-2.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground sm:px-4"
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
                overlay={landCover?.overlay ?? null}
                landcover={latest.landcover}
                simulated={latest.simulated}
                caption={
                  landCover
                    ? overlayCaption(landCover)
                    : !asset.site_key && NO_OVERLAY_NOTE
                }
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
              <ReportTab versions={versions} live />
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

          <aside className="min-w-0 space-y-6 lg:sticky lg:top-24 lg:self-start">
            <Suspense fallback={null}>
              <TradePanel assetId={asset.id} />
            </Suspense>
            <Suspense fallback={null}>
              <CopilotChat
                key={asset.id}
                assetId={asset.id}
                assetName={asset.name}
              />
            </Suspense>
            <section className="rounded-3xl bg-card p-6 shadow-soft">
              <h2 className="text-base font-semibold">How it was rated</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The Agent Trace shows every step of a rating run: which model or
                tool ran, tokens, time and a summary of its output.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() =>
                  openTrace(
                    asset.latest_report?.run_id ?? asset.latest_run_id ?? null,
                  )
                }
              >
                <Bot aria-hidden="true" />
                How it was rated
              </Button>
            </section>
          </aside>
        </div>
      )}

      <div className="mt-8">
        <VerificationPanel assetId={asset.id} />
      </div>
      <div className="mt-8">
        <FieldEvidencePanel
          assetId={asset.id}
          communityId={asset.community_id ?? null}
        />
      </div>
      <DataAttribution
        facts={latest}
        images={images.data}
        landCover={landCover}
      />
    </>
  );
}

function overlayCaption({ dateWindow, note }: AssetLandCover) {
  return (
    <>
      Overlay: Dynamic World land-cover mode, {dateWindow.start} to{" "}
      {dateWindow.end}.{note && ` ${note}`}
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
      {error ? (
        <LoadError
          title="We couldn't load the price history"
          error={error}
          retry={retry}
        />
      ) : loading ? (
        <PriceChartSkeleton />
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

function DataAttribution({
  facts,
  images,
  landCover,
}: {
  facts: ReportFacts | null;
  images: SiteImages | undefined;
  landCover: AssetLandCover | null;
}) {
  const lines = [
    ...new Set([
      ...(facts?.attributions ?? []),
      ...(landCover?.attributions ?? []),
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
