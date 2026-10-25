"use client";

import { ArrowLeft } from "lucide-react";
import Link from "@/components/app-link";
import { usePathname } from "@/lib/nav";
import { cn } from "cn";

import { LoadingRegion } from "@/components/loading-region";
import { MarketplaceHeading } from "@/components/proto/marketplace-heading";
import { useOptionalStewardCommunity } from "@/components/shell/steward-community";
import { TimeMachineHeading } from "@/components/time-machine/time-machine-heading";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ReviewQueueHeading } from "@/components/verification/review-queue-heading";
import { skeletonKind, type SkeletonKind } from "@/lib/route-skeleton";

/**
 * Page-shaped loading states (WP4, #216): blocks at the real radii and positions of the page
 * that's coming, so content replaces them without a jump. Fixed headings are the real ones;
 * text that depends on data is a block inside a box of the real line height. Every one is a
 * `LoadingRegion`: one polite status, blocks hidden from assistive tech, still under reduced
 * motion.
 */

/** A text line or block on the page ground, which is darker than a card. */
function Ground({ className }: { className?: string }) {
  return <Skeleton className={cn("bg-lichen", className)} />;
}

/** A line of text still loading: a block centred in a box of the real line's height. */
function Line({ box, className }: { box: string; className: string }) {
  return (
    <div className={cn("flex items-center", box)}>
      <Ground className={className} />
    </div>
  );
}

/** A `Stat` in a card's stat strip: label, value and the line under it, at their heights. */
function StatBones() {
  return (
    <div>
      <div className="flex h-4 items-center">
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="mt-1 flex h-8 items-center">
        <Skeleton className="h-6 w-32" />
      </div>
      <div className="mt-0.5 flex h-4 items-center">
        <Skeleton className="h-3 w-40 max-w-full" />
      </div>
    </div>
  );
}

/** A panel: a still card (only its lines pulse), as `StewardPanel` and `IpoCard` draw it. */
function Panel({
  className,
  lines = 3,
}: {
  className?: string;
  lines?: number;
}) {
  return (
    <div className={cn("rounded-3xl bg-card p-6 shadow-soft", className)}>
      <Skeleton className="h-5 w-40" />
      <div className="mt-5 space-y-3">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton
            key={i}
            className={cn("h-4", i % 3 === 2 ? "w-2/3" : "w-full")}
          />
        ))}
      </div>
    </div>
  );
}

/** A panel that's loading inside a page that has already drawn its heading. */
export function PanelSkeleton({
  label,
  lines = 3,
  className,
}: {
  label: string;
  lines?: number;
  className?: string;
}) {
  return (
    <LoadingRegion name="panel" label={label} className={className}>
      <Panel lines={lines} />
    </LoadingRegion>
  );
}

/** The image hero on the asset page, as a raised ground block. */
function Hero() {
  return (
    <div className="grid gap-8 rounded-[2rem] bg-lichen p-6 shadow-lift sm:p-8 lg:grid-cols-[1fr_auto] lg:p-10">
      <div className="min-w-0">
        <Skeleton className="h-4 w-48 bg-card/70" />
        <Skeleton className="mt-4 h-12 w-3/4 bg-card/70 sm:h-15" />
        <Skeleton className="mt-4 h-4 w-2/3 bg-card/70" />
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:max-w-2xl">
          {[0, 1].map((i) => (
            <div key={i}>
              <Skeleton className="h-4 w-28 bg-card/70" />
              <Skeleton className="mt-2 h-10 w-44 bg-card/70" />
              <Skeleton className="mt-2 h-3 w-32 bg-card/70" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col items-center gap-4 rounded-[1.75rem] bg-card/40 p-6 lg:w-72">
        <Skeleton className="size-[180px] rounded-full bg-card/70" />
        <Skeleton className="h-10 w-16 rounded-full bg-card/70" />
        <Skeleton className="h-4 w-32 bg-card/70" />
      </div>
    </div>
  );
}

/** Below the asset page's back link: hero, then the tabs beside the trade panel. */
export function AssetBodySkeleton({
  label = "Loading the site…",
}: {
  label?: string;
}) {
  return (
    <LoadingRegion name="asset" label={label}>
      <Hero />
      <div className="mt-8 grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <Ground className="h-11 w-full max-w-sm rounded-full" />
          <Panel className="mt-6" lines={6} />
        </div>
        <div className="rounded-3xl bg-card p-6 shadow-soft">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="mt-5 h-10 w-full rounded-full" />
          <Skeleton className="mt-4 h-11 w-full rounded-xl" />
          <Skeleton className="mt-4 h-4 w-2/3" />
          <Skeleton className="mt-6 h-10 w-full rounded-full" />
        </div>
      </div>
    </LoadingRegion>
  );
}

/** The whole asset page, for its route's `loading.tsx`, with the real back link. */
export function AssetPageSkeleton({ label }: { label?: string }) {
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
        <AssetBodySkeleton label={label} />
      </div>
    </div>
  );
}

/** The Marketplace's stat strip beside its heading, while the sites load. */
export function MarketStatsSkeleton() {
  return (
    <div
      className="grid grid-cols-3 gap-6 rounded-3xl bg-card px-6 py-4 shadow-soft"
      aria-hidden="true"
      data-skeleton="market-stats"
    >
      {[0, 1, 2].map((i) => (
        <StatBones key={i} />
      ))}
    </div>
  );
}

/** A site card: the 16:9 image, name and place, the two stats, the sparkline, the footer. */
function SiteCardBones() {
  return (
    <div className="flex flex-col overflow-hidden rounded-3xl bg-card shadow-soft">
      <Skeleton className="aspect-[16/9] w-full rounded-none" />
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <div className="flex h-[1.375rem] items-center">
            <Skeleton className="h-4 w-3/4" />
          </div>
          <div className="mt-1 flex h-5 items-center">
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <div key={i}>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-6 w-24" />
              <Skeleton className="mt-1.5 h-3 w-28 max-w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
    </div>
  );
}

/**
 * The Marketplace below its heading (#219): the top-rated feature card on its photographic
 * ground, the "All sites" row with its filters, then site cards.
 */
export function MarketBoardSkeleton({
  label = "Loading sites…",
}: {
  label?: string;
}) {
  return (
    <LoadingRegion name="marketplace" label={label}>
      <div className="grid gap-8 rounded-[2rem] bg-lichen p-6 shadow-lift sm:p-8 lg:grid-cols-[auto_1fr_auto] lg:items-center lg:gap-10 lg:p-10">
        <Skeleton className="mx-auto size-[188px] rounded-full bg-card/70 lg:mx-0" />
        <div className="min-w-0 space-y-5">
          <div>
            <Skeleton className="h-6 w-56 rounded-full bg-card/70" />
            <Skeleton className="mt-3 h-10 w-3/4 bg-card/70 sm:h-12" />
            <Skeleton className="mt-3 h-4 w-48 bg-card/70" />
          </div>
          <Skeleton className="h-16 w-full max-w-md bg-card/70" />
        </div>
        <div className="flex flex-col gap-4 rounded-3xl bg-card/40 p-5 lg:w-64">
          <Skeleton className="h-10 w-16 rounded-full bg-card/70" />
          <div>
            <Skeleton className="h-3 w-32 bg-card/70" />
            <Skeleton className="mt-2 h-8 w-28 bg-card/70" />
            <Skeleton className="mt-2 h-4 w-36 bg-card/70" />
          </div>
          <Skeleton className="h-9 w-full rounded-full bg-card/70" />
        </div>
      </div>
      <div className="mt-12">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">All sites</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-10 w-72 max-w-full rounded-full bg-card" />
            <Skeleton className="h-9 w-44 rounded-full bg-card" />
          </div>
        </div>
        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <SiteCardBones key={i} />
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}

/** The whole Marketplace, for its route's `loading.tsx`: the real heading, then the board. */
export function MarketplaceSkeleton({ label }: { label?: string }) {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <MarketplaceHeading stats={<MarketStatsSkeleton />} />
      <div className="mt-8">
        <MarketBoardSkeleton label={label} />
      </div>
    </div>
  );
}

/** A site's tile: its picture, its name and a line, as the Communities and Your stakes grids draw it. */
function TileBones() {
  return (
    <div className="overflow-hidden rounded-3xl bg-card shadow-soft">
      <Skeleton className="aspect-[16/10] w-full rounded-none" />
      <div className="p-5">
        <Line box="h-6" className="h-4 w-40 max-w-full" />
        <Line box="mt-1.5 h-5" className="h-3.5 w-56 max-w-full" />
        <Line box="mt-4 h-8" className="h-6 w-24" />
      </div>
    </div>
  );
}

/** A grid of tiles, three to a row on wide screens. */
function TileGrid() {
  return (
    <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <TileBones key={i} />
      ))}
    </div>
  );
}

/** Below the portfolio's heading: its sentence, then the stakes' tiles. */
export function PortfolioBodySkeleton({
  label = "Loading your stakes…",
}: {
  label?: string;
}) {
  return (
    <LoadingRegion name="portfolio" label={label} className="mt-5">
      <Line box="h-8 sm:h-9" className="h-6 w-full max-w-2xl" />
      <Line box="h-8 sm:h-9" className="h-6 w-2/3 max-w-xl" />
      <TileGrid />
    </LoadingRegion>
  );
}

/** The whole portfolio: the real heading, then the body. */
export function PortfolioSkeleton({ label }: { label?: string }) {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Your stakes
      </h1>
      <PortfolioBodySkeleton label={label} />
    </div>
  );
}

/** Communities and a community's page: the back link, the name, its sentence, then its tiles. */
export function StewardHomeSkeleton({
  label = "Loading your community…",
}: {
  label?: string;
}) {
  return (
    <LoadingRegion
      name="steward-home"
      label={label}
      className="mx-auto max-w-7xl px-4 pt-8 pb-16 sm:px-6"
    >
      <Line box="h-5" className="h-3.5 w-32" />
      <Line box="mt-5 h-12 sm:h-15" className="h-10 w-full max-w-xl sm:h-12" />
      <Line box="mt-5 h-7" className="h-5 w-full max-w-2xl" />
      <TileGrid />
    </LoadingRegion>
  );
}

/**
 * Community settings: the real "Your community" back button, the community's name and role
 * (blocks), then the form beside the members.
 */
export function CommunitySettingsSkeleton({
  label = "Loading your community…",
}: {
  label?: string;
}) {
  const steward = useOptionalStewardCommunity();
  return (
    <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href={steward?.href("/steward") ?? "/steward"}>
          <ArrowLeft aria-hidden="true" />
          Your community
        </Link>
      </Button>
      <LoadingRegion name="community-settings" label={label}>
        <Line box="mt-2 h-12" className="h-10 w-full max-w-md" />
        <Line box="mt-2 h-5" className="h-3.5 w-36" />
        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Panel lines={5} />
          <Panel lines={3} />
        </div>
      </LoadingRegion>
    </div>
  );
}

/**
 * A focused screen (opening offer, verification, field photos, a review): the back button,
 * a line above the site's name, its intro, then two columns.
 */
export function ScreenSkeleton({
  label = "Loading…",
  wide = false,
  checklist = false,
}: {
  label?: string;
  /** The admin's listing review is wider than the steward's screens. */
  wide?: boolean;
  /** The opening offer's "Before you open to supporters" band between header and columns. */
  checklist?: boolean;
}) {
  return (
    <LoadingRegion
      name={checklist ? "ipo" : wide ? "review" : "screen"}
      label={label}
      className={cn(
        "mx-auto px-4 pt-8 pb-16 sm:px-6",
        wide ? "max-w-7xl" : "max-w-6xl",
      )}
    >
      <Ground className="mb-4 h-8 w-40 rounded-full" />
      <Line box="h-5" className="h-3.5 w-40" />
      <Line box="mt-1 h-[2.8125rem] sm:h-15" className="h-9 w-full max-w-md" />
      <Line box="mt-2 h-6" className="h-4 w-full max-w-2xl" />
      <Line box="h-6" className="h-4 w-2/3 max-w-xl" />
      {checklist && <ChecklistBand />}
      <div
        className={cn(
          "grid lg:grid-cols-2",
          checklist ? "mt-6 gap-6" : "mt-8 gap-8",
        )}
      >
        <Panel className="rounded-[1.75rem]" lines={6} />
        <Panel className="rounded-[1.75rem]" lines={4} />
      </div>
    </LoadingRegion>
  );
}

/** The opening offer's checklist band, as `OpeningChecklist` draws it: a heading, three steps. */
function ChecklistBand() {
  return (
    <div className="mt-8 rounded-[1.75rem] bg-card p-5 shadow-soft sm:p-6">
      <div className="flex h-7 items-center">
        <Skeleton className="h-5 w-64 max-w-full" />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-3 md:gap-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3 p-3 md:flex-col md:gap-2">
            <Skeleton className="size-5 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3.5 w-full max-w-56" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The opening offer: the focused screen with its checklist band. */
export function IpoSkeleton({
  label = "Checking this site…",
}: {
  label?: string;
}) {
  return <ScreenSkeleton label={label} checklist />;
}

/** The Time Machine's dark panel: the quarter, the timeline and the run button. */
export function TimeMachineBodySkeleton({
  label = "Loading the Time Machine…",
}: {
  label?: string;
}) {
  return (
    <LoadingRegion
      name="time-machine"
      label={label}
      tone="machine"
      className="mt-8"
    >
      <div className="rounded-[2rem] bg-machine p-6 shadow-lift sm:p-8">
        <Skeleton className="h-9 w-56 bg-machine-raised" />
        <Skeleton className="mt-2 h-4 w-44 bg-machine-raised" />
        <div className="mt-8 grid gap-4 sm:grid-cols-3 sm:gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="h-1.5 rounded-full bg-machine-line" />
              <Skeleton className="mt-3 h-4 w-24 bg-machine-raised" />
              <Skeleton className="mt-1.5 h-3 w-40 bg-machine-raised" />
            </div>
          ))}
        </div>
        <Skeleton className="mt-8 h-10 w-60 rounded-full bg-machine-raised" />
      </div>
      <Panel className="mt-8" lines={3} />
    </LoadingRegion>
  );
}

/** The whole Time Machine page: its real heading, then the panel. */
export function TimeMachineSkeleton({ label }: { label?: string }) {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 pb-16 sm:px-6">
      <TimeMachineHeading />
      <TimeMachineBodySkeleton label={label} />
    </div>
  );
}

/** Rows of listings in the verification area, as `QueueRow` and `DecidedRow` draw them. */
export function QueueRowsSkeleton({
  label = "Loading the queue…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <LoadingRegion name="queue" label={label} className={className}>
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-card p-5 shadow-soft"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-7 w-56 max-w-full" />
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-28 rounded-full" />
              </div>
              <Skeleton className="h-3 w-48 max-w-full" />
              <Skeleton className="h-4 w-40 max-w-full" />
            </div>
            <Skeleton className="h-9 w-28 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

/**
 * The verification area: its heading (the screen's own, shared), the views' tab bar, then rows
 * of listings, where `ReviewQueueScreen` draws them.
 */
export function QueueSkeleton({
  label = "Loading the queue…",
}: {
  label?: string;
}) {
  return (
    <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <ReviewQueueHeading />
      <div
        aria-hidden="true"
        className="mt-8 flex h-11 w-full items-center rounded-full bg-card p-1 shadow-soft sm:w-[21.5rem]"
      >
        <Skeleton className="h-full w-20 rounded-full" />
      </div>
      <QueueRowsSkeleton label={label} className="mt-6" />
    </div>
  );
}

/** Any other page (the listing form): a back link, a heading, its intro and a panel. */
export function PageSkeleton({ label = "Loading…" }: { label?: string }) {
  return (
    <LoadingRegion
      name="page"
      label={label}
      className="mx-auto max-w-6xl px-4 pt-10 pb-16 sm:px-6"
    >
      <Line box="h-5" className="h-3.5 w-36" />
      <Line box="mt-3 h-12 sm:h-15" className="h-10 w-full max-w-md sm:h-12" />
      <Line box="mt-3 h-6" className="h-4 w-full max-w-xl" />
      <Panel className="mt-8" lines={5} />
    </LoadingRegion>
  );
}

/**
 * Rows on the dark machine layer: the Agent Trace's runs and model calls. `intro` adds the
 * line the world's model calls open with, so the rows sit where the list will.
 */
export function MachineRowsSkeleton({
  label,
  intro = false,
  className,
}: {
  label: string;
  intro?: boolean;
  className?: string;
}) {
  return (
    <LoadingRegion
      name="machine-rows"
      label={label}
      tone="machine"
      className={className}
    >
      {intro && (
        <>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-full bg-machine-raised" />
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-2/3 bg-machine-raised" />
          </div>
        </>
      )}
      <div className={cn("space-y-2", intro && "mt-4")}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl bg-machine-raised px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <Skeleton className="h-4 w-32 bg-machine-line" />
              <Skeleton className="h-3 w-16 bg-machine-line" />
            </div>
            <Skeleton className="mt-2 h-3 w-48 max-w-full bg-machine-line" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

const ROUTE_SKELETON: Record<
  SkeletonKind,
  (props: { label: string }) => React.ReactNode
> = {
  marketplace: MarketplaceSkeleton,
  asset: AssetPageSkeleton,
  portfolio: PortfolioSkeleton,
  "steward-home": StewardHomeSkeleton,
  "community-settings": CommunitySettingsSkeleton,
  screen: ScreenSkeleton,
  ipo: IpoSkeleton,
  review: (props) => <ScreenSkeleton {...props} wide />,
  "time-machine": TimeMachineSkeleton,
  queue: QueueSkeleton,
  page: PageSkeleton,
};

/**
 * The current route's page skeleton, for gates in a layout (session, community) that don't
 * know which page they wrap: the same shape the route's `loading.tsx` showed.
 */
export function RouteSkeleton({ label }: { label: string }) {
  const Shape = ROUTE_SKELETON[skeletonKind(usePathname() ?? "/")];
  return <Shape label={label} />;
}
