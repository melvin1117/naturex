import type { ReactNode } from "react";
import { cn } from "cn";

import { MASTER_SCORE } from "@/lib/brand";

import { WildWorthMark, type MarkReading } from "./wildworth-mark";

/** The wordmark: "Wild" in Gloock, "Worth" in Hanken Grotesk 300, as one word. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline leading-none whitespace-nowrap",
        className,
      )}
    >
      <span className="font-serif font-normal tracking-[-0.025em]">Wild</span>
      <span className="ml-[0.02em] font-sans text-[0.9em] font-light tracking-[-0.045em]">
        Worth
      </span>
    </span>
  );
}

/**
 * The WildWorth lockup: the mark and the wordmark (guidelines chapter 4). Horizontal is the
 * default; stacked is for square and centred frames. `size` is the wordmark's size in px; the
 * mark is 1.05× it (1.5× stacked) and below 24 px becomes the single W. The accessible name is
 * the wordmark's text, "WildWorth".
 */
export function Lockup({
  size = 26,
  stacked = false,
  score = MASTER_SCORE,
  reading = "lime-ink",
  play = false,
  className,
  children,
}: {
  size?: number;
  stacked?: boolean;
  score?: number;
  reading?: MarkReading;
  play?: boolean;
  className?: string;
  /** Beside the wordmark, e.g. the app's name. */
  children?: ReactNode;
}) {
  const mark = Math.round(size * (stacked ? 1.5 : 1.05));
  return (
    <span
      className={cn(
        stacked
          ? "inline-grid justify-items-center gap-[0.24em] leading-none"
          : "inline-flex items-center gap-[0.28em] leading-none",
        className,
      )}
      style={{ fontSize: size }}
    >
      <WildWorthMark
        size={mark}
        score={score}
        reading={reading}
        play={play}
        label=""
        className="block shrink-0"
      />
      <Wordmark />
      {children}
    </span>
  );
}
