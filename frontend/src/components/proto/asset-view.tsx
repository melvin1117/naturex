"use client";

import {
  ArrowLeft,
  Camera,
  Database,
  FileText,
  HandCoins,
  Link2,
  type LucideIcon,
  MapPin,
  PanelRight,
  ShieldCheck,
} from "lucide-react";
import Link from "@/components/app-link";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { AssetBodySkeleton } from "@/components/page-skeletons";
import { Delta, SiteBackdrop, ValueRange } from "@/components/proto/bits";
import { PriceChart, PriceChartSkeleton } from "@/components/proto/charts";
import { GradeBadge } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import {
  BeforeAfter,
  EvidenceTimelinePanel,
  type SiteRun,
  useSiteRun,
} from "@/components/proto/evidence-timeline";
import { VerdictStrip } from "@/components/trace/verdict-strip";
import { LoadError } from "@/components/proto/load-error";
import { PriceTick } from "@/components/live-number";
import {
  LandCoverView,
  Panel,
  ServicesPanel,
} from "@/components/proto/report-panels";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TradePanel } from "@/components/trade-panel";
import { VerificationHeroBadge } from "@/components/verification/verification-panel";
import { WorldGate } from "@/components/world-provider";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail } from "@/lib/api/types";
import { boundaryLatLngs, chartPrices, newsItems } from "@/lib/asset-detail";
import { outlineRings } from "@/lib/boundary-map";
import {
  assetLandCover,
  NO_OVERLAY_NOTE,
  type AssetLandCover,
} from "@/lib/land-cover-overlay";
import {
  useApiBase,
  useAsset,
  useAssetPrices,
  useAssetReports,
  useRecordedRun,
  useSiteImages,
} from "@/lib/hooks";
import { countryName, siteImageUrl } from "@/lib/market-cards";
import { beforeAfterViews, type BeforeAfterViews } from "@/lib/site-views";
import {
  GRADE_LABEL,
  ha,
  price as fmtPrice,
  quarterLabel,
} from "@/lib/prototype/format";
import { num, reportFacts, type ReportFacts } from "@/lib/report-facts";
import {
  BACK_THIS_SITE,
  isRecordTab,
  RECORD_TAB_LABEL,
  RECORD_TABS,
  type RecordTab,
  SITE_ANCHORS,
  siteAnchor,
  useSiteDrawer,
} from "@/lib/site-drawer";

// The drawers' content (the whole Agent Trace, the report, The Record) loads when one opens.
const TraceDrawer = dynamic(() =>
  import("@/components/trace/trace-drawer").then((m) => m.TraceDrawer),
);
const RecordDrawer = dynamic(() =>
  import("@/components/site/record-drawer").then((m) => m.RecordDrawer),
);

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
  const params = useSearchParams();
  const { drawer, tab, show } = useSiteDrawer();
  const versionParam = Number(params.get("version")) || null;

  const reports = useAssetReports(asset.id);
  const prices = useAssetPrices(asset.id);
  const images = useSiteImages(asset.site_key);
  const apiBase = useApiBase();
  const landCover = assetLandCover(asset, images.data, apiBase);

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
  // A demo site nobody has rated in this world shows its recorded run (free, labelled).
  const recorded = useRecordedRun(
    asset.latest_report?.run_id ? null : asset.site_key,
  );
  const site = useSiteRun(asset.latest_report?.run_id, recorded.data);
  const traceRunId = asset.latest_report?.run_id ?? asset.latest_run_id ?? null;
  const hasTrace = Boolean(traceRunId || recorded.data);
  const views = beforeAfterViews(asset, apiBase);
  const imageUrl = siteImageUrl(asset.site_key, asset.cover_image_url);
  const outline = useMemo(() => outlineRings(asset.outline), [asset.outline]);
  const place = [
    countryName(asset.country ?? null),
    ha(num(asset.area_ha) ?? 0),
  ]
    .filter(Boolean)
    .join(" · ");

  // `?tab=news` and `?tab=price` point at a part of the page, not a drawer: scroll there once
  // what loads above it (the verdict band, the price chart) has settled.
  const anchor = siteAnchor(tab);
  const settled =
    prices.data !== undefined &&
    recorded.status !== "loading" &&
    (site.run !== undefined || !asset.latest_report?.run_id);
  useEffect(() => {
    if (!anchor || !settled) return;
    // Before any trades there's no price chart: the trade panel has the price.
    const target =
      document.getElementById(anchor) ??
      document.getElementById(BACK_THIS_SITE);
    target?.scrollIntoView({ block: "start" });
  }, [anchor, settled]);

  return (
    <>
      <title>{`${asset.name} · WildWorth`}</title>
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
              <VerificationHeroBadge
                assetId={asset.id}
                onOpen={() => show("verification")}
              />
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
              <p className="mt-3 line-clamp-2 max-w-2xl text-white/85">
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
                  <div className="text-sm text-white/75">Price a unit</div>
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
            {(hasTrace || latest) && (
              <div className="mt-8 flex flex-wrap gap-3">
                {latest && (
                  // Phones: the trade panel comes after the page, so the hero leads to it.
                  <Button asChild variant="on-image" className="lg:hidden">
                    <a href={`#${BACK_THIS_SITE}`}>
                      <HandCoins aria-hidden="true" />
                      Back this site
                    </a>
                  </Button>
                )}
                {hasTrace && (
                  <Button
                    variant="on-image"
                    aria-haspopup="dialog"
                    // Phones lead with "Back this site": this one steps back to an outline.
                    className="max-lg:border max-lg:border-card/45 max-lg:bg-machine/30 max-lg:text-card max-lg:backdrop-blur-sm"
                    onClick={() => show("trace")}
                  >
                    <PanelRight aria-hidden="true" />
                    How it was rated
                  </Button>
                )}
                {latest && (
                  <Button
                    variant="on-image-outline"
                    aria-haspopup="dialog"
                    onClick={() => show("report")}
                  >
                    Proof of Life report
                  </Button>
                )}
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
                    Was {prev.grade} in Proof of Life v{prev.version}
                  </p>
                )}
                <p className="mt-1 text-xs text-white/70">
                  Proof of Life v{latest.version}
                  {latest.period && ` · ${quarterLabel(latest.period)}`}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      <VerdictStrip
        report={asset.latest_report}
        recorded={recorded.data}
        trace={site.run}
        onOpen={() => show("trace")}
      />

      {!latest ? (
        <p className="mt-8 rounded-3xl bg-card p-8 text-center text-muted-foreground shadow-soft">
          This site hasn&apos;t been rated yet.
        </p>
      ) : (
        <div className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-6">
            <ServicesPanel facts={latest} headingLevel="h2" />
            <SeenFromAbove
              views={views}
              site={site}
              land={{
                polygon,
                label: asset.name,
                overlay: landCover?.overlay ?? null,
                landcover: latest.landcover,
                simulated: latest.simulated,
                caption: landCover
                  ? overlayCaption(landCover)
                  : !asset.site_key && NO_OVERLAY_NOTE,
              }}
            />
            <EvidenceTimelinePanel
              id={SITE_ANCHORS.news}
              className="scroll-mt-24"
              facts={latest}
              news={news}
              site={site}
            />
            {/* Before a second price there's nothing to chart: the trade panel has the price. */}
            {(points.length > 1 || !prices.data) && (
              <PricePanel
                points={points}
                news={news}
                facts={latest}
                loading={prices.isLoading && !prices.data}
                error={prices.data ? null : prices.error}
                retry={prices.refetch}
              />
            )}
            <MoreAboutRating onOpen={show} />
          </div>

          <aside
            id={BACK_THIS_SITE}
            className="min-w-0 scroll-mt-24 lg:sticky lg:top-24 lg:self-start"
          >
            <Suspense fallback={null}>
              <TradePanel assetId={asset.id} />
            </Suspense>
          </aside>
        </div>
      )}

      <TraceDrawer
        open={drawer === "trace"}
        onOpenChange={(open) => show(open ? "trace" : null)}
        asset={asset}
        runId={traceRunId}
        recorded={recorded.data}
      />
      <RecordDrawer
        tab={isRecordTab(drawer) ? drawer : null}
        onTab={show}
        onClose={() => show(null)}
        asset={asset}
        latest={latest}
        versions={versions}
        versionParam={versionParam}
        reportsError={reports.data ? null : reports.error}
        images={images.data}
        landCover={landCover}
      />
    </>
  );
}

/** The site from above: its views five years apart, or its land cover, one at a time. */
function SeenFromAbove({
  views,
  site,
  land,
}: {
  views: BeforeAfterViews | null;
  site: SiteRun;
  land: Parameters<typeof LandCoverView>[0];
}) {
  const [view, setView] = useState<"years" | "cover">(
    views ? "years" : "cover",
  );
  return (
    <Panel
      title="Seen from above"
      headingLevel="h2"
      action={
        views && (
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(v) => v && setView(v as "years" | "cover")}
            aria-label="What to show"
            className="rounded-full bg-secondary p-1"
          >
            <ToggleGroupItem
              value="years"
              className="rounded-full px-3 text-sm data-[state=on]:bg-card data-[state=on]:shadow-soft"
            >
              Five years apart
            </ToggleGroupItem>
            <ToggleGroupItem
              value="cover"
              className="rounded-full px-3 text-sm data-[state=on]:bg-card data-[state=on]:shadow-soft"
            >
              Land cover
            </ToggleGroupItem>
          </ToggleGroup>
        )
      }
    >
      {view === "years" && views ? (
        <BeforeAfter views={views} site={site} />
      ) : (
        <LandCoverView {...land} />
      )}
    </Panel>
  );
}

const MORE_ICON: Record<RecordTab, LucideIcon> = {
  report: FileText,
  ledger: Link2,
  verification: ShieldCheck,
  photos: Camera,
  sources: Database,
};

/** The way into everything behind the rating, without leaving the page. */
function MoreAboutRating({ onOpen }: { onOpen: (tab: RecordTab) => void }) {
  return (
    <nav
      aria-label="More about this rating"
      className="flex flex-wrap items-center gap-2 pt-2"
    >
      {RECORD_TABS.map((t) => {
        const Icon = MORE_ICON[t];
        return (
          <Button
            key={t}
            variant="outline"
            size="sm"
            className="rounded-full"
            aria-haspopup="dialog"
            onClick={() => onOpen(t)}
          >
            <Icon aria-hidden="true" />
            {RECORD_TAB_LABEL[t]}
          </Button>
        );
      })}
    </nav>
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
      id={SITE_ANCHORS.price}
      className="scroll-mt-24"
      title="Price a unit"
      headingLevel="h2"
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
      ) : (
        <PriceChart prices={points} events={news} perDay={false} />
      )}
      {facts.fairValuePerUnit !== null && (
        <p className="mt-4 text-xs text-muted-foreground">
          The price moves with orders and drifts toward the fair price set by
          each rating ({fmtPrice(facts.fairValuePerUnit)} now); a re-rate moves
          it part of the way there at once.
        </p>
      )}
    </Panel>
  );
}
