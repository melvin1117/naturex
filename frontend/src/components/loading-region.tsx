"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "cn";

/** How long a load runs before the region says why it may be slow (ux-writing §6). */
export const SLOW_AFTER_MS = 8000;
export const SLOW_NOTE =
  "Still loading. The NatureX servers may be waking up, which takes about 30 seconds on our free host.";

function useSlow(after: number): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), after);
    return () => window.clearTimeout(timer);
  }, [after]);
  return slow;
}

/**
 * A loading region: skeleton blocks in the shape of the content that's coming, hidden from
 * assistive tech, and one polite status that names what's loading. After `SLOW_AFTER_MS` the
 * same status says why it may be slow, as a visible note over the blocks (no layout shift).
 */
export function LoadingRegion({
  label,
  name,
  children,
  className,
  tone = "land",
}: {
  label: string;
  /** Which page or panel shape this is (`data-skeleton`). */
  name: string;
  children: ReactNode;
  className?: string;
  /** "machine" on the dark agent and Time Machine panels. */
  tone?: "land" | "machine";
}) {
  const slow = useSlow(SLOW_AFTER_MS);
  return (
    <div
      className={cn("relative", className)}
      data-slot="loading-region"
      data-skeleton={name}
    >
      <p
        role="status"
        className={
          slow
            ? cn(
                "absolute top-6 left-1/2 z-10 w-max max-w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 rounded-2xl px-4 py-2.5 text-center text-sm shadow-soft",
                tone === "machine"
                  ? "bg-machine-raised text-machine-ink"
                  : "bg-card text-foreground",
              )
            : "sr-only"
        }
      >
        {slow ? SLOW_NOTE : label}
      </p>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}
