"use client";

import type { CSSProperties, ReactNode } from "react";
import { cn } from "cn";

import {
  DURATION,
  easeOutInverse,
  useCountUp,
  usePrefersReducedMotion,
} from "@/lib/motion";

const COLUMNS = 100;
const RINGS = 5;

export interface DotRingSegment {
  /** How many of the 100 columns this segment lights, after the segments before it. */
  columns: number;
  /** The fill of its lit dots (`fill-primary`, `fill-lime`…). */
  className: string;
}

export interface DotRingReveal {
  /** Columns already lit when the reveal starts. */
  from?: number;
  delay?: number;
  duration?: number;
}

/**
 * The dotted radial instrument: 100 radial columns of dots, lit in order by `segments`. With
 * `reveal`, the columns light one after another (opacity only, on the same ease-out as
 * `useCountUp`, so a numeral in the centre keeps pace); under reduced motion they're lit at once.
 */
export function DotRing({
  segments,
  size,
  tone = "light",
  reveal,
  label,
  unlitClassName,
  className,
  children,
}: {
  segments: DotRingSegment[];
  size: number;
  tone?: "light" | "dark";
  reveal?: DotRingReveal;
  /** The fill of unlit dots, when the ground is neither paper nor the machine layer. */
  unlitClassName?: string;
  /** What the ring says, for assistive tech (the dots themselves are hidden). */
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const animate = Boolean(reveal) && !reduced;
  const cx = size / 2;
  const outer = size / 2 - 4;
  const inner = outer * 0.72;
  const fills: (string | null)[] = [];
  for (const segment of segments)
    for (let i = 0; i < Math.round(segment.columns); i++)
      fills.push(segment.className);
  const lit = Math.min(fills.length, COLUMNS);
  const from = Math.min(Math.round(reveal?.from ?? 0), lit);
  const delay = reveal?.delay ?? 0;
  const duration = reveal?.duration ?? DURATION.reveal;
  // One group per column: it carries the fill and, in a reveal, the column's light-up delay.
  const columns: {
    fill: string | null;
    at: number | null;
    dots: { x: number; y: number; r: number; key: string }[];
  }[] = [];
  for (let c = 0; c < COLUMNS; c++) {
    const angle = (c / COLUMNS) * Math.PI * 2 - Math.PI / 2;
    const fill = c < lit ? fills[c] : null;
    // When this column lights: in step with a count-up from `from` to `lit`.
    const at =
      animate && fill && c >= from
        ? Math.round(
            delay + duration * easeOutInverse((c + 1 - from) / (lit - from)),
          )
        : null;
    const dots = [];
    for (let r = 0; r < RINGS; r++) {
      const radius = inner + ((outer - inner) * r) / (RINGS - 1);
      // Thin the dots slightly on outer rings so the edge reads as a soft boundary.
      const skip = (c * 7 + r * 13) % 11 === 0 && r > 2;
      if (skip) continue;
      dots.push({
        // Rounded so server and client render identical attributes.
        x: Math.round((cx + Math.cos(angle) * radius) * 100) / 100,
        y: Math.round((cx + Math.sin(angle) * radius) * 100) / 100,
        r: Math.round((size / 210 + (r === 2 ? 0.25 : 0)) * 100) / 100,
        key: `${c}-${r}`,
      });
    }
    columns.push({ fill, at, dots });
  }
  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        aria-hidden="true"
      >
        {columns.map((column, c) => (
          <g
            key={c}
            className={cn(
              column.fill ??
                unlitClassName ??
                (tone === "dark" ? "fill-machine-line" : "fill-foreground/12"),
              column.at !== null && "nx-dot-on",
            )}
            style={
              column.at !== null
                ? { animationDelay: `${column.at}ms` }
                : undefined
            }
          >
            {column.dots.map((d) => (
              <circle key={d.key} cx={d.x} cy={d.y} r={d.r} />
            ))}
          </g>
        ))}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        {children}
      </div>
    </div>
  );
}

/**
 * Dotted radial instrument for the health score: radial columns of dots, lit up to the score.
 * Each column is one point of health out of 100, so the reading is literal, not decorative.
 * `animateFrom` makes it a newly computed score: the dots light and the numeral counts up from
 * there to `value`, landing exactly on it.
 */
export function HealthRing({
  value,
  label = "Health",
  size = 168,
  tone = "light",
  animateFrom,
  delay = 0,
  className,
}: {
  value: number;
  label?: string;
  size?: number;
  tone?: "light" | "dark";
  animateFrom?: number;
  /** With `animateFrom`: wait this long before lighting up. */
  delay?: number;
  className?: string;
}) {
  const reveal = animateFrom !== undefined;
  return (
    <DotRing
      segments={[
        {
          columns: Math.round(value),
          className: tone === "dark" ? "fill-lime" : "fill-primary",
        },
      ]}
      size={size}
      tone={tone}
      reveal={reveal ? { from: animateFrom, delay } : undefined}
      label={`${label} ${value.toFixed(1)} out of 100`}
      className={className}
    >
      <div>
        <CountUpNumeral
          value={value}
          from={animateFrom}
          delay={delay}
          className={cn(
            "tabular font-light tracking-tight",
            tone === "dark" ? "text-machine-ink" : "text-foreground",
          )}
          style={{ fontSize: size * 0.24, lineHeight: 1 }}
        />
        <div
          className={cn(
            "mt-1 text-xs",
            tone === "dark" ? "text-machine-muted" : "text-muted-foreground",
          )}
        >
          {label} / 100
        </div>
      </div>
    </DotRing>
  );
}

/**
 * The ring's numeral, on its own so a count-up re-renders only this, not the ring's dots.
 * `from` undefined: the value as it is.
 */
function CountUpNumeral({
  value,
  from,
  delay,
  className,
  style,
}: {
  value: number;
  from: number | undefined;
  delay: number;
  className: string;
  style: CSSProperties;
}) {
  const shown = useCountUp(value, {
    from: from ?? value,
    delay,
    duration: DURATION.reveal,
    enabled: from !== undefined,
  });
  return (
    <div className={className} style={style}>
      {shown.toFixed(1)}
    </div>
  );
}
