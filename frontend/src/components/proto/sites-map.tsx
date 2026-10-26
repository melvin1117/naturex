"use client";

import { ArrowRight } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { cn } from "cn";

import Link from "@/components/app-link";
import { GradeBadge } from "@/components/proto/grade";
import { Skeleton } from "@/components/ui/skeleton";
import { ha } from "@/lib/format";
import type { MarketCard } from "@/lib/market-cards";
import { useHref, useRouter } from "@/lib/nav";
import { assetHref } from "@/lib/trade";

// Leaflet loads only when the map view opens.
const SitesMapCanvas = dynamic(() => import("./sites-map-canvas"), {
  ssr: false,
  loading: () => <Skeleton className="size-full rounded-none" />,
});

/**
 * The Marketplace's map view: every site's drawn boundary on one satellite map, with the sites
 * listed beside it. A row flies the map to its site; its link (or the map's card) opens it.
 */
export function SitesMap({ cards }: { cards: MarketCard[] }) {
  const [focused, setFocused] = useState<{ id: string; n: number } | null>(
    null,
  );
  const focus = (id: string) => setFocused((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  const router = useRouter();
  const resolve = useHref();
  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      {/* `isolate`: Leaflet's panes and controls (z-index 400–1000) stay under the sticky bar. */}
      <div className="isolate h-[420px] overflow-hidden rounded-3xl shadow-soft lg:h-[600px]">
        <SitesMapCanvas
          cards={cards}
          focused={focused}
          onFocus={focus}
          siteHref={(id) => resolve(assetHref(id))}
          onOpen={(id) => router.push(assetHref(id))}
        />
      </div>
      <ul
        aria-label="Sites on the map"
        className="space-y-2 lg:max-h-[600px] lg:overflow-y-auto"
      >
        {cards.map((card) => (
          <li
            key={card.id}
            className={cn(
              "flex items-center gap-3 rounded-2xl bg-card p-3 shadow-soft transition-shadow",
              focused?.id === card.id && "ring-2 ring-primary",
            )}
          >
            <button
              type="button"
              onClick={() => focus(card.id)}
              aria-pressed={focused?.id === card.id}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {card.grade ? (
                <GradeBadge grade={card.grade} size="sm" />
              ) : (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  Not rated
                </span>
              )}
              <span className="min-w-0">
                <span className="block font-serif text-lg leading-tight break-words">
                  {card.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {ha(card.areaHa)}
                  <span className="sr-only">: show it on the map</span>
                </span>
              </span>
            </button>
            <Link
              href={assetHref(card.id)}
              aria-label={`View ${card.name}`}
              className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
