"use client";

import { ArrowRight, Plus, Sprout } from "lucide-react";
import Link from "@/components/app-link";
import { useSearchParams } from "next/navigation";

import { SiteThumb } from "@/components/proto/bits";
import {
  StartCommunity,
  useStewardCommunity,
} from "@/components/shell/steward-community";
import { Button } from "@/components/ui/button";
import type { MyCommunity } from "@/lib/api/types";
import { sitesLine } from "@/lib/community-sites";
import { useCommunitySummary } from "@/lib/community-hooks";
import { countryName, siteIcon } from "@/lib/market-cards";
import { useRouter } from "@/lib/nav";
import { withCommunity } from "@/lib/navigation";

/**
 * `/steward`: the communities you're in, each with a glimpse of its land, and a way to start
 * another (`?new=1`). Opening one shows its sites (`?community=<id>`).
 */
export function CommunitiesIndex() {
  const { communities } = useStewardCommunity();
  const starting = useSearchParams().get("new") === "1";
  const router = useRouter();

  if (starting)
    return (
      <StartCommunity
        back={{ href: "/steward", label: "Back to your communities" }}
        onCreated={(community) =>
          router.replace(withCommunity("/steward", community.id))
        }
      />
    );

  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 pb-16 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
            Communities
          </h1>
          <p className="mt-3 text-pretty text-muted-foreground">
            Each community looks after its own land and lists it here.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/steward?new=1">
            <Plus aria-hidden="true" />
            Start a community
          </Link>
        </Button>
      </div>
      <ul
        aria-label="Your communities"
        className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
      >
        {communities.map((community) => (
          <CommunityCard key={community.id} community={community} />
        ))}
      </ul>
    </div>
  );
}

function CommunityCard({ community }: { community: MyCommunity }) {
  const summary = useCommunitySummary(community.id, { live: "status" });
  const listings = summary.data?.listings ?? [];
  // The land it looks after: its first site with a picture or a boundary to show.
  const icon =
    listings
      .filter((l) => l.asset.status !== "withdrawn")
      .map((l) => siteIcon(l.asset))
      .find((i) => i !== null) ?? null;
  const meta = [
    countryName(community.country ?? null),
    community.role === "owner" ? "You're the owner" : "You're a steward",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <Link
        href={withCommunity("/steward", community.id)}
        className="group flex h-full flex-col overflow-hidden rounded-3xl bg-card shadow-soft transition-shadow hover:shadow-lift focus-visible:shadow-lift focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {icon ? (
          <SiteThumb
            siteKey={icon.siteKey}
            src={icon.src}
            outline={icon.outline}
            alt=""
            creditHidden
            className="aspect-[16/9]"
          />
        ) : (
          <div className="grid aspect-[16/9] place-items-center bg-lichen">
            <Sprout className="size-8 text-lime-ink" aria-hidden="true" />
          </div>
        )}
        <div className="flex flex-1 flex-col gap-1 p-5">
          <h2 className="text-lg leading-tight font-semibold text-balance">
            {community.name}
          </h2>
          <p className="text-sm text-muted-foreground">{meta}</p>
          <p className="mt-auto flex items-center justify-between gap-3 pt-4 text-sm font-medium">
            <span className="tabular">
              {summary.data ? sitesLine(listings) : "\u00a0"}
            </span>
            <ArrowRight
              className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </p>
        </div>
      </Link>
    </li>
  );
}
