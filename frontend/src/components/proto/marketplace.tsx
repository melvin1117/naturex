"use client";

import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { usePathname, useReplaceUrl } from "@/lib/nav";
import { useMemo } from "react";

import {
  MarketBoardSkeleton,
  MarketFiguresSkeleton,
} from "@/components/page-skeletons";
import { Figure, Figures } from "@/components/figures";
import {
  HabitatIcon,
  RatedSitesIcon,
  WorthRangeIcon,
} from "@/components/icons";
import { MarketplaceHeading } from "@/components/proto/marketplace-heading";
import { FeatureSiteCard, SiteCard } from "@/components/proto/site-card";
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
import { ha, money } from "@/lib/format";

function useMarketCards() {
  const query = useAssets();
  const cards = useMemo(
    () => (query.data ? query.data.map(marketCard) : undefined),
    [query.data],
  );
  return { ...query, cards };
}

export function Marketplace() {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <MarketplaceHeading figures={<MarketFigures />} />
      <div className="mt-8">
        <WorldGate
          fallback={<MarketBoardSkeleton label="Opening your demo world…" />}
        >
          <MarketBoard />
        </WorldGate>
      </div>
    </div>
  );
}

/**
 * The board in three figures, with the brand's icons: the sites rated, their living land, and
 * what their nature is worth a year as a range (never a single value).
 */
function MarketFigures() {
  const { cards, error } = useMarketCards();
  if (!cards) return error ? null : <MarketFiguresSkeleton />;
  const rated = cards.filter((c) => c.grade !== null);
  if (rated.length === 0) return null;
  const valued = rated.filter(
    (c) => c.valueLow !== null && c.valueHigh !== null,
  );
  const low = valued.reduce((sum, c) => sum + (c.valueLow ?? 0), 0);
  const high = valued.reduce((sum, c) => sum + (c.valueHigh ?? 0), 0);
  return (
    <Figures>
      <Figure
        icon={RatedSitesIcon}
        value={String(rated.length)}
        label={rated.length === 1 ? "site rated" : "sites rated"}
      />
      <Figure
        icon={HabitatIcon}
        value={ha(rated.reduce((sum, c) => sum + c.areaHa, 0))}
        label="of living land"
      />
      {valued.length > 0 && (
        <Figure
          icon={WorthRangeIcon}
          value={`${money(low)}–${money(high)}`}
          label="a year in nature's services"
        />
      )}
    </Figures>
  );
}

export function MarketBoard() {
  const { cards, error, refetch, isFetching } = useMarketCards();
  const params = useSearchParams();
  const pathname = usePathname();
  const replaceUrl = useReplaceUrl();
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
    replaceUrl(query ? `${pathname}?${query}` : pathname);
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

  if (!cards) return <MarketBoardSkeleton />;

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
              {/* Its name is what it shows, so speech and sight agree (axe: label in name). */}
              <SelectTrigger
                className="w-44"
                aria-label={`Sort: ${SORTS[sort].label}`}
              >
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
