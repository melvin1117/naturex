import type { ReactNode } from "react";

/**
 * The Marketplace's heading row. Shared by the page and its loading skeleton (#219), so the
 * real text is on screen from the first frame and nothing moves when the sites arrive. `stats`
 * sits beside the heading (the stat strip, or its blocks).
 */
export function MarketplaceHeading({ stats }: { stats?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div>
        <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
          Marketplace
        </h1>
        <p className="mt-3 max-w-xl text-muted-foreground">
          Living land, rated by AI from satellite data and local news. Back a
          site and follow its health every quarter.
        </p>
      </div>
      {stats}
    </div>
  );
}
