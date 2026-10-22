"use client";

import { Compass } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { useTour } from "@/components/proto/tour";
import { Button } from "@/components/ui/button";

/**
 * The Marketplace's heading row and tour invitation, shared by the page and its loading
 * skeleton (#219), so the real text is on screen from the first frame and nothing moves when
 * the sites arrive. `stats` sits beside the heading (the stat strip, or its blocks).
 */
export function MarketplaceHeading({ stats }: { stats?: ReactNode }) {
  const tour = useTour();
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
            Marketplace
          </h1>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Living land, rated by AI from satellite data and local news. Back a
            site with play money and follow its health every quarter.
          </p>
        </div>
        {stats}
      </div>

      {!tour.active && (
        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-3xl bg-lichen px-5 py-3.5 text-sm">
          <Compass className="size-4 text-lime-ink" aria-hidden="true" />
          <span>
            <span className="font-medium">New here?</span> The guided tour walks
            through listing, rating, backing and monitoring in about seven
            minutes, on a scripted demo world.
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" asChild>
              <Link href="/judge">Judge landing</Link>
            </Button>
            <Button size="sm" onClick={tour.start}>
              Start the tour
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
