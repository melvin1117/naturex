import type { ReactNode } from "react";

/**
 * The Marketplace's heading: the serif title and one line on what's here, then the board's
 * figures (`figures`). Shared by the page and its loading skeleton (#219), so the title is on
 * screen from the first frame.
 */
export function MarketplaceHeading({ figures }: { figures?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
      <div className="max-w-xl">
        <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
          Marketplace
        </h1>
        <p className="mt-4 text-xl leading-snug text-pretty text-muted-foreground sm:text-2xl">
          Rated from space and the local news. Back a site, watch it stay alive.
        </p>
      </div>
      {figures}
    </div>
  );
}
