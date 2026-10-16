import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Image from "next/image";
import { cn } from "cn";

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
        <span className="text-sm font-medium text-muted-foreground">{app}</span>
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
      <span className="font-medium normal-case opacity-80">· replay</span>
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

/** The site's own Sentinel-2 thumbnail, blurred, as the ground of a card. */
export function SiteBackdrop({
  siteKey,
  blur = "strong",
  className,
}: {
  siteKey: string;
  blur?: "strong" | "soft" | "none";
  className?: string;
}) {
  return (
    <div
      className={cn("absolute inset-0 overflow-hidden", className)}
      aria-hidden="true"
    >
      <Image
        src={`/demo-sites/${siteKey}.thumbnail.webp`}
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
      <div
        className={cn(
          "absolute inset-0",
          blur === "none"
            ? "bg-gradient-to-t from-black/55 via-black/10 to-transparent"
            : "bg-[oklch(0.3_0.06_145/0.38)]",
        )}
      />
    </div>
  );
}

export function SiteThumb({
  siteKey,
  alt,
  className,
}: {
  siteKey: string;
  alt: string;
  className?: string;
}) {
  return (
    <div className={cn("relative overflow-hidden bg-lichen", className)}>
      <Image
        src={`/demo-sites/${siteKey}.thumbnail.webp`}
        alt={alt}
        fill
        sizes="(min-width: 1024px) 33vw, 100vw"
        unoptimized
        className="object-cover"
      />
    </div>
  );
}

export function ValueRange({
  low,
  mid,
  high,
  confidence,
  tone = "light",
  className,
}: {
  low: number;
  mid: number;
  high: number;
  confidence: number;
  tone?: "light" | "dark" | "image";
  className?: string;
}) {
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
          className="absolute inset-y-0 rounded-full bg-lime"
          style={{
            left: `${at(low)}%`,
            width: `${Math.max(at(high) - at(low), 2)}%`,
          }}
        />
        <div
          className={cn(
            "absolute -top-1 h-4 w-1 rounded-full",
            tone === "light" ? "bg-primary" : "bg-white",
          )}
          style={{ left: `calc(${at(mid)}% - 2px)` }}
        />
      </div>
      <p className={cn("text-xs", muted)}>
        {confidence.toFixed(0)}% confidence · screening estimate, not an
        appraisal
      </p>
    </div>
  );
}

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
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tabular mt-1 truncate text-2xl font-light tracking-tight">
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
