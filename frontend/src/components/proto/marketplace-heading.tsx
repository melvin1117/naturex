"use client";

import { Compass, FlaskConical } from "lucide-react";
import NextLink from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useInSandbox } from "@/lib/nav";

/**
 * The Marketplace's heading row and the two ways in for a newcomer: the story (`/judge`) and
 * their own sandbox (`/sandbox`). Shared by the page and its loading skeleton (#219), so the
 * real text is on screen from the first frame and nothing moves when the sites arrive. `stats`
 * sits beside the heading (the stat strip, or its blocks). Inside the sandbox its own bar says
 * where the visitor is, so the invitation hides there.
 */
export function MarketplaceHeading({ stats }: { stats?: ReactNode }) {
  const sandbox = useInSandbox();
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

      {!sandbox && (
        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-3xl bg-lichen px-5 py-3.5 text-sm">
          <Compass className="size-4 text-lime-ink" aria-hidden="true" />
          <span>
            <span className="font-medium">New here?</span> See why NatureX
            exists on one real wetland, then try everything in your own sandbox.
            No sign-up.
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" asChild>
              <NextLink href="/judge">See how it works</NextLink>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <NextLink href="/sandbox">
                <FlaskConical aria-hidden="true" />
                Try it yourself
              </NextLink>
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
