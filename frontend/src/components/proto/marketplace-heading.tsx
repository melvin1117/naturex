"use client";

import { Compass } from "lucide-react";
import Link from "next/link";
import { useCallback, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useOptionalDataLayer } from "@/lib/data-layer";

/**
 * The Marketplace's heading row and the invitation to the story (`/judge`), shared by the page
 * and its loading skeleton (#219), so the real text is on screen from the first frame and
 * nothing moves when the sites arrive. `stats` sits beside the heading (the stat strip, or its
 * blocks). A demo session already has the story in its bar, so the invitation hides there.
 */
export function MarketplaceHeading({ stats }: { stats?: ReactNode }) {
  return <Heading stats={stats} inDemo={useInDemo()} />;
}

/** Whether this tab acts in a demo session; false without a data layer (route skeletons). */
function useInDemo(): boolean {
  const layer = useOptionalDataLayer();
  const subscribe = useCallback(
    (listener: () => void) =>
      layer?.session.subscribe(listener) ?? (() => undefined),
    [layer],
  );
  const snapshot = useCallback(
    () => layer?.session.getSnapshot().world ?? null,
    [layer],
  );
  const world = useSyncExternalStore(subscribe, snapshot, () => null);
  return Boolean(world?.me?.persona);
}

function Heading({ stats, inDemo }: { stats?: ReactNode; inDemo: boolean }) {
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

      {!inDemo && (
        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-3xl bg-lichen px-5 py-3.5 text-sm">
          <Compass className="size-4 text-lime-ink" aria-hidden="true" />
          <span>
            <span className="font-medium">New here?</span> See why NatureX
            exists on one real wetland, then try everything in your own sandbox.
            No sign-up.
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" asChild>
              <Link href="/judge">See how it works</Link>
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
