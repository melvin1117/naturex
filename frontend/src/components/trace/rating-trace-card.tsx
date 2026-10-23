"use client";

import { ArrowRight, PanelRight } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

import { Button } from "@/components/ui/button";

const PRIMARY =
  "bg-lime text-foreground hover:bg-lime/90 focus-visible:ring-lime focus-visible:ring-offset-2 focus-visible:ring-offset-machine";

/**
 * On a site's page, the way into the Agent Trace of its rating. `href` is the full trace page
 * (the latest run's, or a demo site's recorded run); `onOpen` opens the drawer beside the page
 * on the site's own run, so it's only given when there is one. Without either, the card says
 * the trace comes with the first rating.
 */
export function RatingTraceCard({
  href = null,
  recorded = false,
  pending = false,
  onOpen,
  tourAnchor,
}: {
  href?: string | null;
  /** `href` is a recorded run (a demo site nobody has rated in this world). */
  recorded?: boolean;
  /** Still finding out whether there's a recording: hold the actions back, so they don't
   * change under the pointer or keyboard focus. */
  pending?: boolean;
  onOpen?: () => void;
  /** The guided tour's anchor (`data-tour`) on the drawer button. */
  tourAnchor?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      aria-busy={pending || undefined}
      className="rounded-3xl bg-machine p-6 text-machine-ink shadow-soft"
    >
      <h2 id={id} className="text-base font-semibold">
        How the AI rated it
      </h2>
      <p className="mt-1 text-sm text-machine-muted">
        Every step of the rating run: which model or tool ran, what it read and
        concluded, with its tokens, time and cost.
      </p>
      {pending ? (
        <div
          aria-hidden="true"
          className="mt-4 h-8 w-44 animate-pulse rounded-full bg-machine-raised"
        />
      ) : href || onOpen ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {href && (
            <Button asChild size="sm" className={PRIMARY}>
              <Link href={href}>
                {recorded ? "Open the recorded run" : "Open the Agent Trace"}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          )}
          {onOpen && (
            <Button
              variant={href ? "ghost" : "default"}
              size="sm"
              className={
                href
                  ? "text-machine-ink hover:bg-machine-raised hover:text-machine-ink focus-visible:ring-lime"
                  : PRIMARY
              }
              onClick={onOpen}
              data-tour={tourAnchor}
            >
              <PanelRight aria-hidden="true" />
              {href ? "Quick look" : "Open the Agent Trace"}
            </Button>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-machine-muted">
          Its trace appears here after its first rating.
        </p>
      )}
      <Link
        href="/ai"
        className="mt-3 inline-flex text-sm font-medium text-lime underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none"
      >
        Every model at work, with live costs
      </Link>
    </section>
  );
}
