"use client";

import { Compass, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";

import { Stat } from "@/components/proto/bits";
import { FeatureSiteCard, SiteCard } from "@/components/proto/site-card";
import { useTour } from "@/components/proto/tour";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { WorldGate } from "@/components/world-provider";
import { useAssets } from "@/lib/hooks";
import {
  GRADE_BANDS,
  isBand,
  isSort,
  marketCard,
  shownCards,
  SORTS,
  type GradeBand,
  type MarketCard,
  type SortKey,
} from "@/lib/market-cards";
import { ha, money } from "@/lib/prototype/format";

function useMarketCards() {
  const query = useAssets();
  const cards = useMemo(
    () => (query.data ? query.data.map(marketCard) : undefined),
    [query.data],
  );
  return { ...query, cards };
}

export function Marketplace() {
  const tour = useTour();
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
            Marketplace
          </h1>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Living land, rated by AI from satellite data and local news. Back a
            site with play money and follow its health every quarter.
          </p>
        </div>
        <MarketStats />
      </div>

      {!tour.active && (
        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-3xl bg-lichen px-5 py-3.5 text-sm">
          <Compass className="size-4 text-lime-ink" aria-hidden="true" />
          <span>
            <span className="font-medium">New here?</span> The guided tour walks
            through listing, rating, backing and monitoring in about seven
            minutes, on a scripted demo world.
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" asChild>
              <Link href="/judge">Judge landing</Link>
            </Button>
            <Button size="sm" onClick={tour.start}>
              Start the tour
            </Button>
          </div>
        </div>
      )}

      <div className="mt-8">
        <WorldGate>
          <MarketBoard />
        </WorldGate>
      </div>
    </div>
  );
}

function MarketStats() {
  const { cards } = useMarketCards();
  if (!cards || cards.length === 0) return null;
  const value = cards.reduce((sum, c) => sum + (c.valueMid ?? 0), 0);
  return (
    <dl className="grid grid-cols-3 gap-6 rounded-3xl bg-card px-6 py-4 shadow-soft">
      <Stat label="Sites listed" value={cards.length} />
      <Stat
        label="Land rated"
        value={ha(cards.reduce((sum, c) => sum + c.areaHa, 0))}
      />
      <Stat label="Nature's value" value={money(value)} sub="a year, mid" />
    </dl>
  );
}

export function MarketBoard() {
  const { cards, error, refetch, isFetching } = useMarketCards();
  const params = useSearchParams();
  const pathname = usePathname();
  const gradeParam = params.get("grade");
  const sortParam = params.get("sort");
  const band: GradeBand = isBand(gradeParam) ? gradeParam : "all";
  const sort: SortKey = isSort(sortParam) ? sortParam : "grade";
  // Filters live in the URL (shareable, survive reload); the History API updates
  // useSearchParams without a server round trip.
  const setParam = (key: "grade" | "sort", value: string, fallback: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    window.history.replaceState(
      null,
      "",
      query ? `${pathname}?${query}` : pathname,
    );
  };
  const setBand = (v: GradeBand) => setParam("grade", v, "all");
  const setSort = (v: SortKey) => setParam("sort", v, "grade");
  const shown = useMemo(
    () => (cards ? shownCards(cards, band, sort) : []),
    [cards, band, sort],
  );

  if (!cards && error)
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>We couldn&apos;t load the marketplace</AlertTitle>
        <AlertDescription>
          <p>{error.message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCwIcon aria-hidden="true" />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );

  if (!cards) return <MarketSkeleton />;

  if (cards.length === 0)
    return (
      <p className="rounded-3xl bg-card px-6 py-10 text-center text-muted-foreground shadow-soft">
        No sites are listed yet. Communities&apos; sites appear here once
        they&apos;re rated.
      </p>
    );

  const featured: MarketCard | undefined = [...cards]
    .filter((c) => c.grade !== null)
    .sort(SORTS.grade.fn)[0];

  return (
    <>
      {featured && <FeatureSiteCard card={featured} />}
      <section aria-labelledby="all-sites" className="mt-12">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 id="all-sites" className="text-xl font-semibold">
            All sites
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              value={band}
              onValueChange={(v) => isBand(v) && setBand(v)}
              className="rounded-full bg-card p-1 shadow-soft"
              aria-label="Filter by grade"
            >
              {(Object.keys(GRADE_BANDS) as GradeBand[]).map((v) => (
                <ToggleGroupItem
                  key={v}
                  value={v}
                  className="rounded-full px-3.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  {GRADE_BANDS[v].label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Select value={sort} onValueChange={(v) => isSort(v) && setSort(v)}>
              <SelectTrigger className="w-44" aria-label="Sort sites">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SORTS) as SortKey[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    Sort: {SORTS[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="sr-only" aria-live="polite">
          {shown.length} of {cards.length} sites shown
        </p>
        {shown.length === 0 ? (
          <p className="mt-6 rounded-3xl bg-card px-6 py-10 text-center text-muted-foreground shadow-soft">
            No sites rated {GRADE_BANDS[band].label} yet.
          </p>
        ) : (
          <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((c) => (
              <SiteCard key={c.id} card={c} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function MarketSkeleton() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading sites…</span>
      <div
        className="h-72 animate-pulse rounded-[2rem] bg-card shadow-soft motion-reduce:animate-none"
        aria-hidden="true"
      />
      <div
        className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        aria-hidden="true"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-96 animate-pulse rounded-3xl bg-card shadow-soft motion-reduce:animate-none"
          />
        ))}
      </div>
    </div>
  );
}
