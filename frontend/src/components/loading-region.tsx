"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "cn";

import { beginLoading, endLoading } from "@/lib/loading-chain";

/** How long a wait runs before the region says why it may be slow (ux-writing §8). */
export const SLOW_AFTER_MS = 8000;
export const SLOW_NOTE =
  "Still loading. The WildWorth servers may be waking up, which can take about 30 seconds.";

/**
 * The region's one status. It mounts empty and gets its text after mount, so screen readers
 * announce it (a live region inserted with its text often isn't). A label the same wait
 * already announced is shown with the live region off, so it isn't announced twice; the slow
 * note turns it back on first, then appears.
 */
function useLoadingStatus(label: string) {
  const [text, setText] = useState("");
  const [muted, setMuted] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const now = Date.now();
    const chain = beginLoading(now);
    setMuted(chain.announced.has(label));
    chain.announced.add(label);
    setText(label);
    setSlow(false);
    const timer = window.setTimeout(
      () => {
        setMuted(chain.slowAnnounced);
        chain.slowAnnounced = true;
        setSlow(true);
      },
      Math.max(0, chain.since + SLOW_AFTER_MS - now),
    );
    return () => {
      window.clearTimeout(timer);
      endLoading(Date.now());
    };
  }, [label]);

  useEffect(() => {
    if (slow) setText(SLOW_NOTE);
  }, [slow]);

  return { text, muted, slow: slow && text === SLOW_NOTE };
}

/**
 * A loading region: skeleton blocks in the shape of the content that's coming, hidden from
 * assistive tech, and one polite status that names what's loading. After `SLOW_AFTER_MS` of
 * the same wait, the status says why it may be slow, as a visible note over the blocks (no
 * layout shift).
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
  const { text, muted, slow } = useLoadingStatus(label);
  return (
    <div
      className={cn("relative", className)}
      data-slot="loading-region"
      data-skeleton={name}
    >
      <p
        role="status"
        aria-live={muted ? "off" : undefined}
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
        {text}
      </p>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}
