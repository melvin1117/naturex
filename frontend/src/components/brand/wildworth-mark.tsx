import type { CSSProperties, SVGProps } from "react";
import { cn } from "cn";

import { MASTER_SCORE, SINGLE_W_BELOW_PX, markGeometry } from "@/lib/brand";
import type { Grade } from "@/lib/site-data";

/**
 * What the reading (the last stroke and its dot) is drawn in. The guidelines: lime on dark
 * grounds, lime-ink on light, forest on lime; on a site, that site's grade colour.
 */
export type MarkReading = "lime" | "lime-ink" | "forest" | Grade;

export function readingColor(reading: MarkReading): string {
  if (reading === "forest") return "var(--color-primary)";
  if (reading === "lime" || reading === "lime-ink")
    return `var(--color-${reading})`;
  return `var(--color-grade-${reading.toLowerCase()})`;
}

export interface WildWorthMarkProps extends Omit<
  SVGProps<SVGSVGElement>,
  "children"
> {
  /** The Health score the reading rises to, clamped to 0–100 (the master logo: 77.6). */
  score?: number;
  /** Rendered size in px. Below 24 px the mark is the single W (no dot). */
  size?: number;
  reading?: MarkReading;
  /** Play the draw (the line), then the rise (the reading) and the dot, once. */
  play?: boolean;
  /** The accessible name; "" hides the mark (it sits beside the wordmark). */
  label?: string;
}

/**
 * The WildWorth mark: two Ws drawn as one line, the last stroke rising to the land's Health
 * score (`wwInner()` in the brand guidelines). The line takes the ground's ink (`currentColor`).
 */
export function WildWorthMark({
  score = MASTER_SCORE,
  size,
  reading = "lime-ink",
  play = false,
  label = "WildWorth mark",
  className,
  ...props
}: WildWorthMarkProps) {
  const single = size !== undefined && size < SINGLE_W_BELOW_PX;
  const g = markGeometry(score, single);
  const color = readingColor(reading);
  const read: CSSProperties = { stroke: color };
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      fill="none"
      className={cn(play && "ww-play", className)}
      data-variant={single ? "single" : "double"}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true, focusable: false })}
      {...props}
    >
      <path
        className="ww-ink"
        pathLength={100}
        d={g.line}
        stroke="currentColor"
        strokeWidth={g.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="ww-read"
        pathLength={100}
        d={g.reading}
        style={read}
        strokeWidth={g.strokeWidth}
        strokeLinecap="round"
      />
      {g.dot && (
        <circle
          className="ww-dot"
          cx={g.dot.cx}
          cy={g.dot.cy}
          r={g.dot.r}
          style={{ fill: color }}
        />
      )}
    </svg>
  );
}
