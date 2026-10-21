import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Image from "next/image";
import { cn } from "cn";

import { BoundaryMap } from "@/components/boundary-map";
import type { LonLatRing } from "@/lib/boundary-map";
import { money, signedPct } from "@/lib/prototype/format";

export function Wordmark({
  className,
  app,
}: {
  className?: string;
  app?: string;
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-2", className)}>
      <span className="font-serif text-[1.65rem] leading-none tracking-tight">
        NatureX
      </span>
      {app && (
        <>
          {/* The space keeps the accessible name "NatureX Exchange" (flex doesn't draw it).
              Below `sm` the app name is only visually hidden, so it stays in that name. */}{" "}
          <span className="text-sm font-medium text-muted-foreground max-sm:sr-only">
            {app}
          </span>
        </>
      )}
    </span>
  );
}

export function Delta({
  value,
  className,
  suffix,
}: {
  /** Percent change. */
  value: number;
  className?: string;
  suffix?: string;
}) {
  const flat = Math.abs(value) < 0.05;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "tabular inline-flex items-center gap-0.5 text-sm font-medium",
        flat
          ? "text-muted-foreground"
          : value > 0
            ? "text-lime-ink"
            : "text-clay-ink",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      <span>
        <span className="sr-only">
          {flat ? "unchanged" : value > 0 ? "up" : "down"}{" "}
        </span>
        {flat ? "0.0%" : signedPct(value)}
        {suffix && (
          <span className="font-normal text-muted-foreground"> {suffix}</span>
        )}
      </span>
    </span>
  );
}

/**
 * Marks a step that calls Nemotron or Tavily live in the full build. The prototype replays a
 * recorded run, so the visible text says so (not just a tooltip).
 */
export function LiveBadge({
  className,
  label = "Live",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-lime/30 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-lime-ink uppercase",
        className,
      )}
      title="In the full build this step calls Nemotron or Tavily live. In this prototype it replays a recorded run."
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-lime-ink/60 motion-reduce:hidden" />
        <span className="relative inline-flex size-1.5 rounded-full bg-lime-ink" />
      </span>
      {label}
      <span className="font-medium normal-case">· replay</span>
    </span>
  );
}

export function SampleTag({
  className,
  children = "Sample",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-dashed border-current/40 px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase",
        className,
      )}
      title="Illustrative content in this prototype"
    >
      {children}
    </span>
  );
}

/** The prototype's static copy of a demo site's thumbnail, unless `src` is given. */
function thumbnailUrl(siteKey?: string | null, src?: string | null) {
  return src ?? (siteKey ? `/demo-sites/${siteKey}.thumbnail.webp` : null);
}

/**
 * The site's own Sentinel-2 thumbnail, blurred, as the ground of a card; without one, its
 * boundary on satellite imagery (unblurred, so the outline reads), else a plain green ground.
 */
export function SiteBackdrop({
  siteKey,
  src,
  outline,
  blur = "strong",
  className,
}: {
  siteKey?: string | null;
  /** Image URL, e.g. the backend's media route; defaults to the prototype's copy. */
  src?: string | null;
  /** The boundary, drawn when there's no image. */
  outline?: readonly LonLatRing[];
  blur?: "strong" | "soft" | "none";
  className?: string;
}) {
  const url = thumbnailUrl(siteKey, src);
  const map = !url && outline !== undefined && outline.length > 0;
  return (
    <div
      className={cn("absolute inset-0 overflow-hidden bg-primary", className)}
      aria-hidden={map ? undefined : true}
    >
      {url && (
        <Image
          src={url}
          alt=""
          fill
          sizes="(min-width: 1024px) 66vw, 100vw"
          unoptimized
          className={cn(
            "object-cover",
            blur === "strong" && "scale-125 blur-2xl saturate-[1.15]",
            blur === "soft" && "scale-110 blur-md",
          )}
        />
      )}
      {map && (
        <BoundaryMap
          rings={outline}
          frame="container"
          creditClassName="right-3 left-auto bottom-2"
        />
      )}
      <div
        aria-hidden="true"
        className={cn(
          "absolute inset-0",
          map
            ? "bg-[oklch(0.24_0.05_145/0.55)]"
            : blur === "none"
              ? "bg-gradient-to-t from-black/55 via-black/10 to-transparent"
              : "bg-[oklch(0.3_0.06_145/0.38)]",
        )}
      />
    </div>
  );
}

/** The site's thumbnail; without one, its boundary on satellite imagery, else a plain ground. */
export function SiteThumb({
  siteKey,
  src,
  outline,
  alt,
  creditHidden,
  className,
}: {
  siteKey?: string | null;
  /** Image URL, e.g. the backend's media route; defaults to the prototype's copy. */
  src?: string | null;
  /** The boundary, drawn when there's no image. */
  outline?: readonly LonLatRing[];
  alt: string;
  /** Inside a link: keep the map's credit out of the link's name (it stays visible). */
  creditHidden?: boolean;
  className?: string;
}) {
  const url = thumbnailUrl(siteKey, src);
  return (
    <div className={cn("relative overflow-hidden bg-lichen", className)}>
      {!url && outline && (
        <BoundaryMap rings={outline} label={alt} creditHidden={creditHidden} />
      )}
      {url && (
        <Image
          src={url}
          alt={alt}
          fill
          sizes="(min-width: 1024px) 33vw, 100vw"
          unoptimized
          className="object-cover"
        />
      )}
    </div>
  );
}

export function ValueRange({
  low,
  mid,
  high,
  confidence,
  tone = "light",
  revealDelay,
  className,
}: {
  low: number;
  mid: number;
  high: number;
  confidence: number;
  tone?: "light" | "dark" | "image";
  /** A newly computed range: after this many ms the bar opens from its centre, then the
   * midpoint and the confidence settle in (#216). */
  revealDelay?: number;
  className?: string;
}) {
  const reveal = (offset: number) =>
    revealDelay === undefined
      ? undefined
      : { animationDelay: `${revealDelay + offset}ms` };
  const span = Math.max(high - low, 1);
  const scaleMax = high + span * 0.25;
  const scaleMin = Math.max(0, low - span * 0.25);
  const at = (v: number) => ((v - scaleMin) / (scaleMax - scaleMin)) * 100;
  const muted =
    tone === "light"
      ? "text-muted-foreground"
      : tone === "dark"
        ? "text-machine-muted"
        : "text-white/75";
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="tabular text-2xl font-light tracking-tight">
          {money(low)}–{money(high)}
        </span>
        <span className={cn("text-sm", muted)}>a year · mid {money(mid)}</span>
      </div>
      <div
        className={cn(
          "relative h-2 rounded-full",
          tone === "light" ? "bg-foreground/8" : "bg-white/15",
        )}
        role="img"
        aria-label={`Estimated value between ${money(low)} and ${money(high)} a year, midpoint ${money(mid)}`}
      >
        <div
          className={cn(
            "absolute inset-y-0 rounded-full bg-lime",
            revealDelay !== undefined && "nx-grow-x",
          )}
          style={{
            left: `${at(low)}%`,
            width: `${Math.max(at(high) - at(low), 2)}%`,
            ...reveal(0),
          }}
        />
        <div
          className={cn(
            "absolute -top-1 h-4 w-1 rounded-full",
            tone === "light" ? "bg-primary" : "bg-white",
            revealDelay !== undefined && "nx-fade",
          )}
          style={{ left: `calc(${at(mid)}% - 2px)`, ...reveal(160) }}
        />
      </div>
      <p
        className={cn("text-xs", muted, revealDelay !== undefined && "nx-fade")}
        style={reveal(220)}
      >
        {confidence.toFixed(0)}% confidence · screening estimate, not an
        appraisal
      </p>
    </div>
  );
}

/** One term of a `<dl>`: always render it inside one. */
export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-1 truncate text-2xl font-light tracking-tight">
        {value}
      </dd>
      {sub && <dd className="mt-0.5 text-xs text-muted-foreground">{sub}</dd>}
    </div>
  );
}
