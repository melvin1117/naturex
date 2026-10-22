"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { cn } from "cn";

import {
  DURATION,
  easeOut,
  usePrefersReducedMotion,
  useValueTick,
} from "@/lib/motion";

/**
 * Numbers that show they changed (#216 WP2): a count to a newly computed value, and a live
 * price that flashes once per move and keeps its direction arrow. Both land on exactly the
 * API's value, and under reduced motion show it at once (the arrow stays: it's information).
 */

/**
 * `value`, counting to it whenever it changes: from what's on screen (mid-count included), or
 * from `from` on mount, e.g. a stake's units before a fill. Lands on exactly `value`; under
 * reduced motion it shows at once. Assistive tech gets only the final value.
 */
export function CountTo({
  value,
  format,
  from,
  duration = DURATION.tick,
}: {
  value: number;
  format: (value: number) => string;
  /** Count from here on mount; omitted, the first value shows at once. */
  from?: number;
  duration?: number;
}) {
  const shown = useTween(value, from, duration);
  if (shown === value) return <>{format(value)}</>;
  return (
    <>
      <span aria-hidden="true">{format(shown)}</span>
      <span className="sr-only">{format(value)}</span>
    </>
  );
}

type Segment = { from: number; to: number; progress: number };

const at = ({ from, to, progress }: Segment) =>
  progress >= 1 ? to : from + (to - from) * easeOut(progress);

/** A number easing to `value` over `duration`; a new value starts from the one on screen. */
function useTween(value: number, from: number | undefined, duration: number) {
  const reduced = usePrefersReducedMotion();
  const [segment, setSegment] = useState<Segment>(() => ({
    from: from ?? value,
    to: value,
    progress: from === undefined || from === value ? 1 : 0,
  }));
  let current = segment;
  if (value !== segment.to) {
    current = { from: at(segment), to: value, progress: reduced ? 1 : 0 };
    setSegment(current);
  }
  const counting = !reduced && duration > 0 && current.progress < 1;
  useEffect(() => {
    if (!counting) return;
    let frame = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const progress = Math.min(1, (now - start) / duration);
      setSegment((s) => ({ ...s, progress }));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // A new segment (from, to) restarts the clock; progress updates don't.
  }, [counting, current.from, current.to, duration]);
  return counting ? at(current) : value;
}

const FLASH: Record<"land" | "image", Record<"up" | "down", string>> = {
  land: { up: "var(--lime-ink)", down: "var(--clay-ink)" },
  image: { up: "var(--lime)", down: "var(--clay)" },
};

/**
 * A live price: when it moves, the numeral flashes the move's colour for 600 ms and settles
 * back to ink, and an arrow keeps the direction of the last move. Not a live region: price
 * ticks would be noise; the arrow has text for anyone who reads the price.
 */
export function PriceTick({
  value,
  format,
  tone = "land",
  armed = true,
  className,
}: {
  value: number | null;
  format: (value: number) => string;
  /** False until the value is fresh from the API (not a cached one being refreshed). */
  armed?: boolean;
  /** "image" on the photographic hero and feature card (white text). */
  tone?: "land" | "image";
  className?: string;
}) {
  const { direction, moves } = useValueTick(value, { armed });
  const Arrow = direction === "down" ? ArrowDown : ArrowUp;
  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      data-tick={direction ?? undefined}
    >
      <span
        key={moves}
        className={moves > 0 ? "nx-flash" : undefined}
        style={
          direction
            ? ({ "--nx-flash-color": FLASH[tone][direction] } as CSSProperties)
            : undefined
        }
      >
        {value === null ? "—" : format(value)}
      </span>
      {direction && (
        <>
          <Arrow className="size-[0.55em] shrink-0 opacity-70" aria-hidden />
          <span className="sr-only">
            {direction === "up" ? ", up" : ", down"} from the previous price
          </span>
        </>
      )}
    </span>
  );
}
