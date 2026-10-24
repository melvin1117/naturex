"use client";

import { useEffect, useState } from "react";
import { cn } from "cn";

import { BeaDrawing } from "./bea-drawing";
import {
  BEA_CHARACTER_FROM_PX,
  BEA_DRAWING,
  BEA_STATE_LABEL,
  type BeaState,
} from "./states";

export type { BeaState };

/**
 * Bea, the field guide: ink only, in the logo's line (`currentColor`). When she appears or
 * changes state her wings flutter, she blinks and (drawn in full) bobs, then she rests within
 * 5 s (WCAG 2.2.2); while thinking her antennae wiggle beside three dots until the answer
 * comes. When a grade changes (`react`) she reacts once: a hop up, or a shake down. All of it
 * stops under `prefers-reduced-motion`. Her wings and body are filled with `--bea-ground`, the
 * surface she sits on (set by the surface classes in globals.css).
 */
export function Bea({
  state = "hello",
  size,
  avatar = size < BEA_CHARACTER_FROM_PX,
  label,
  react = null,
  className,
}: {
  state?: BeaState;
  size: number;
  /** A grade just went up or down: she hops or shakes once when this is set. */
  react?: "up" | "down" | null;
  /** The avatar (a ringed medallion); the default below 64 px. */
  avatar?: boolean;
  /** The accessible name; "" when the words next to her already say what she shows. */
  label?: string;
  className?: string;
}) {
  const reacting = useReaction(react);
  const name = label ?? `Bea, ${BEA_STATE_LABEL[state].toLowerCase()}`;
  const a11y = name
    ? { role: "img", "aria-label": name }
    : { "aria-hidden": true as const };
  return (
    <span
      className={cn(
        "bea-anim inline-block shrink-0 leading-none",
        reacting === "up" && "bea-react-up",
        reacting === "down" && "bea-react-down",
        className,
      )}
      style={{ width: size, height: size }}
      data-state={state}
    >
      {avatar ? (
        <svg
          key={state}
          viewBox="0 0 120 120"
          width={size}
          height={size}
          {...a11y}
        >
          <circle
            cx="60"
            cy="60"
            r="56"
            className="bea-ground"
            stroke="currentColor"
            strokeWidth="5"
          />
          <g transform="translate(15 12) scale(.75)">
            <BeaDrawing state={BEA_DRAWING[state]} />
          </g>
        </svg>
      ) : (
        <svg
          key={state}
          viewBox="0 0 120 124"
          width={size}
          height={size}
          className="bea-bob"
          {...a11y}
        >
          <BeaDrawing state={BEA_DRAWING[state]} />
        </svg>
      )}
    </span>
  );
}

/** One reaction per grade change: a hop (750 ms) up, or a shake (600 ms) down. */
function useReaction(react: "up" | "down" | null): "up" | "down" | null {
  const [playing, setPlaying] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    setPlaying(react);
    if (!react) return;
    const timer = window.setTimeout(
      () => setPlaying(null),
      react === "up" ? 750 : 600,
    );
    return () => window.clearTimeout(timer);
  }, [react]);
  return playing;
}
