"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { LoadingRegion } from "@/components/loading-region";
import { useOptionalStewardCommunity } from "@/components/shell/steward-community";
import { TimeMachineHeading } from "@/components/time-machine/time-machine-heading";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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

/** Below the portfolio's heading: the stat strip, then stakes beside alerts. */
export function PortfolioBodySkeleton({
  label = "Loading your stakes…",
}: {
  label?: string;
}) {
  return (
    <LoadingRegion name="portfolio" label={label} className="mt-8">
      <div className="grid gap-4 rounded-3xl bg-card p-6 shadow-soft sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-2 h-9 w-36" />
          </div>
        ))}
      </div>
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <Panel lines={5} />
        <Panel lines={3} />
      </div>
    </LoadingRegion>
  );
}

/** The whole portfolio: the real heading, the account line (a block), then the body. */
export function PortfolioSkeleton({ label }: { label?: string }) {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Your stakes
      </h1>
      <Line box="mt-3 h-6" className="h-4 w-72 max-w-full" />
      <PortfolioBodySkeleton label={label} />
    </div>
  );
}

/** The steward home: heading and actions, stats, the featured site, then the side panels. */
export function StewardHomeSkeleton({
  label = "Loading your community…",
}: {
  label?: string;
}) {
  return (
    <LoadingRegion
      name="steward-home"
      label={label}
      className="mx-auto max-w-7xl px-4 pt-10 pb-16 sm:px-6"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="w-full max-w-md min-w-0">
          <Line box="h-5" className="h-3.5 w-40" />
          <Line box="mt-1 h-12 sm:h-15" className="h-10 w-full sm:h-12" />
        </div>
        <div className="flex gap-2">
          <Ground className="h-10 w-36 rounded-full" />
          <Ground className="h-10 w-36 rounded-full" />
        </div>
      </div>
      <div className="mt-8 grid gap-4 rounded-3xl bg-card p-6 shadow-soft sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-2 h-9 w-24" />
            <Skeleton className="mt-2 h-3 w-36" />
          </div>
        ))}
      </div>
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-8">
          <div className="grid gap-6 rounded-[2rem] bg-lichen p-6 shadow-lift sm:p-8 md:grid-cols-[auto_1fr]">
            <Skeleton className="size-40 rounded-full bg-card/70" />
            <div className="min-w-0">
              <Skeleton className="h-8 w-40 rounded-full bg-card/70" />
              <Skeleton className="mt-4 h-10 w-3/4 bg-card/70" />
              <Skeleton className="mt-3 h-4 w-2/3 bg-card/70" />
              <div className="mt-6 flex gap-2">
                <Skeleton className="h-10 w-36 rounded-full bg-card/70" />
                <Skeleton className="h-10 w-32 rounded-full bg-card/70" />
              </div>
            </div>
          </div>
          <Panel lines={2} />
        </div>
        <div className="min-w-0 space-y-6">
          <Panel lines={4} />
          <Panel lines={2} />
        </div>
      </div>
    </LoadingRegion>
  );
}

/**
 * Community settings: the real "Community home" back button, the community's name and role
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
          Community home
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
}: {
  label?: string;
  /** The admin's listing review is wider than the steward's screens. */
  wide?: boolean;
}) {
  return (
    <LoadingRegion
      name={wide ? "review" : "screen"}
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
      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <Panel className="rounded-[1.75rem]" lines={6} />
        <Panel className="rounded-[1.75rem]" lines={4} />
      </div>
    </LoadingRegion>
  );
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

/**
 * The verification queue: its heading (as `ReviewQueueScreen` draws it, owned by #210/#211;
 * extract a shared heading once that lands) and rows of listings.
 */
export function QueueSkeleton({
  label = "Loading the queue…",
}: {
  label?: string;
}) {
  return (
    <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Verification queue
      </h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Listings whose communities submitted land documents, oldest first. Read
        the documents, the automated checks and the map, then approve or reject
        with a reason. Your own communities&apos; listings never appear here.
      </p>
      <LoadingRegion name="queue" label={label} className="mt-8">
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 rounded-3xl bg-card p-5 shadow-soft"
            >
              <div className="min-w-0 flex-1">
                <Skeleton className="h-5 w-48 max-w-full" />
                <Skeleton className="mt-2 h-4 w-72 max-w-full" />
              </div>
              <Skeleton className="h-9 w-24 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </LoadingRegion>
    </div>
  );
}

/** Any other page (the listing form): a back link, a heading, its intro and a panel. */
export function PageSkeleton({ label = "Loading…" }: { label?: string }) {
  return (
    <LoadingRegion
      name="page"
      label={label}
      className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6"
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
  asset: AssetPageSkeleton,
  portfolio: PortfolioSkeleton,
  "steward-home": StewardHomeSkeleton,
  "community-settings": CommunitySettingsSkeleton,
  screen: ScreenSkeleton,
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
