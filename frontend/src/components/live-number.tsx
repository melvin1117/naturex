"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { cn } from "cn";

import { DURATION, useCountUp, useValueTick } from "@/lib/motion";

/**
 * Numbers that show they changed (#216 WP2): a count to a newly computed value, and a live
 * price that flashes once per move and keeps its direction arrow. Both land on exactly the
 * API's value, and under reduced motion show it at once (the arrow stays: it's information).
 */

/**
 * `value`, counting to it from the previous value whenever it changes (or from `from` on
 * mount, e.g. a stake's units before a fill). Assistive tech gets only the final value.
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
  const [state, setState] = useState({ value, from: from ?? value });
  let current = state;
  if (state.value !== value) {
    current = { value, from: state.value };
    setState(current);
  }
  return (
    <Counting
      key={current.value}
      from={current.from}
      value={value}
      format={format}
      duration={duration}
    />
  );
}

function Counting({
  from,
  value,
  format,
  duration,
}: {
  from: number;
  value: number;
  format: (value: number) => string;
  duration: number;
}) {
  const shown = useCountUp(value, { from, duration });
  if (shown === value) return <>{format(value)}</>;
  return (
    <>
      <span aria-hidden="true">{format(shown)}</span>
      <span className="sr-only">{format(value)}</span>
    </>
  );
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
  className,
}: {
  value: number | null;
  format: (value: number) => string;
  /** "image" on the photographic hero and feature card (white text). */
  tone?: "land" | "image";
  className?: string;
}) {
  const { direction, moves } = useValueTick(value);
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
