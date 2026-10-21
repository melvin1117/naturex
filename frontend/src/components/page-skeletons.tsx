"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { LoadingRegion } from "@/components/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { skeletonKind } from "@/lib/route-skeleton";

/**
 * Page-shaped loading states (WP4, #216): blocks at the real radii and positions of the page
 * that's coming, so content replaces them without a jump. Every one is a `LoadingRegion`:
 * one polite status, blocks hidden from assistive tech, still under reduced motion.
 */

/** A text line or block on the page ground, which is darker than a card. */
function Ground({ className }: { className?: string }) {
  return <Skeleton className={cn("bg-lichen", className)} />;
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

/** A page heading: an optional line above, the serif title and a line of intro. */
function Heading({ intro = true }: { intro?: boolean }) {
  return (
    <div>
      <Ground className="h-4 w-44" />
      <Ground className="mt-3 h-12 w-full max-w-md sm:h-[3.75rem]" />
      {intro && <Ground className="mt-4 h-4 w-full max-w-xl" />}
    </div>
  );
}

/** The image hero on the asset page and the steward home, as a raised ground block. */
function Hero({ ring = 180 }: { ring?: number }) {
  return (
    <div className="grid gap-8 rounded-[2rem] bg-lichen p-6 shadow-lift sm:p-8 lg:grid-cols-[1fr_auto] lg:p-10">
      <div className="min-w-0">
        <Skeleton className="h-4 w-48 bg-card/70" />
        <Skeleton className="mt-4 h-12 w-3/4 bg-card/70 sm:h-[3.75rem]" />
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
        <Skeleton
          className="rounded-full bg-card/70"
          style={{ width: ring, height: ring }}
        />
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
          <Ground className="h-9 w-full max-w-sm rounded-full" />
          <Panel className="mt-4" lines={6} />
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

/** The whole asset page, for its route's `loading.tsx`. */
export function AssetPageSkeleton() {
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
        <AssetBodySkeleton />
      </div>
    </div>
  );
}

/** Below the portfolio's heading: the stat strip, then holdings beside alerts. */
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

export function PortfolioSkeleton({ label }: { label?: string }) {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 sm:px-6">
      <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Your stakes
      </h1>
      <Ground className="mt-4 h-4 w-72 max-w-full" />
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
          <Ground className="h-4 w-40" />
          <Ground className="mt-3 h-12 w-full sm:h-[3.75rem]" />
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

/** A focused screen (opening offer, verification, field photos, a review): two columns. */
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
      <Heading />
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

export function TimeMachineSkeleton({ label }: { label?: string }) {
  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 pb-16 sm:px-6">
      <Heading />
      <TimeMachineBodySkeleton label={label} />
    </div>
  );
}

/** Rows of a list on a card, such as the verification queue. */
export function ListRowsSkeleton({
  label,
  rows = 3,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}) {
  return (
    <LoadingRegion name="list" label={label} className={className}>
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
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
  );
}

export function AdminListSkeleton({
  label = "Loading the queue…",
}: {
  label?: string;
}) {
  return (
    <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <Heading />
      <ListRowsSkeleton label={label} className="mt-8" />
    </div>
  );
}

/** Any other page: a heading and a panel. */
export function PageSkeleton({ label = "Loading…" }: { label?: string }) {
  return (
    <LoadingRegion
      name="page"
      label={label}
      className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6"
    >
      <Heading />
      <Panel className="mt-8" lines={5} />
    </LoadingRegion>
  );
}

/** Rows on the dark machine layer: the Agent Trace's runs and model calls. */
export function MachineRowsSkeleton({
  label,
  rows = 4,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <LoadingRegion
      name="machine-rows"
      label={label}
      tone="machine"
      className="mt-4"
    >
      <div className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
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

/**
 * The current route's page skeleton, for gates in a layout (session, community) that don't
 * know which page they wrap: the same shape the route's `loading.tsx` showed.
 */
export function RouteSkeleton({ label }: { label: string }) {
  const kind = skeletonKind(usePathname() ?? "/");
  switch (kind) {
    case "asset":
      return <AssetPageSkeleton />;
    case "portfolio":
      return <PortfolioSkeleton label={label} />;
    case "steward-home":
      return <StewardHomeSkeleton label={label} />;
    case "screen":
      return <ScreenSkeleton label={label} />;
    case "time-machine":
      return <TimeMachineSkeleton label={label} />;
    case "review":
      return <ScreenSkeleton label={label} wide />;
    case "admin-list":
      return <AdminListSkeleton label={label} />;
    default:
      return <PageSkeleton label={label} />;
  }
}
