"use client";

import { ChevronDown, Plus } from "lucide-react";
import Link from "@/components/app-link";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { LoadError } from "@/components/proto/load-error";
import { ListingsSkeleton } from "@/components/page-skeletons";
import { useStewardCommunity } from "@/components/shell/steward-community";
import { ListingRow } from "@/components/steward/listing-row";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { CommunitySummary, ListingSummary } from "@/lib/api/types";
import { useCommunitySummary, useMeId } from "@/lib/community-hooks";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
import { listingHref } from "@/lib/listing/links";
import { siteIcon } from "@/lib/market-cards";
import {
  GROUP_TITLE,
  groupListings,
  type ListingGroup,
} from "@/lib/steward-listings";

/**
 * `/steward/listings` (#233): the community's listings by where they stand, In progress, Live
 * and Closed, each with its status in plain words and what a member can do with it now.
 */
export function ListingsRoute() {
  const meId = useMeId();
  if (!meId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <Alert>
          <AlertTitle>Sign in to manage listings</AlertTitle>
          <AlertDescription>
            <p>The scripted demo has no listings to manage.</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/login?next=%2Fsteward%2Flistings">Sign in</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return <StewardListings />;
}

function StewardListings() {
  const { active } = useStewardCommunity();
  const summary = useCommunitySummary(active?.id, { live: "status" });
  if (!active) return null; // StewardGate shows the empty state or the loader.
  if (summary.error && !summary.data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <LoadError
          title="We couldn't load your listings"
          error={summary.error}
          retry={summary.refetch}
        />
      </div>
    );
  }
  if (!summary.data || summary.data.community.id !== active.id) {
    return <ListingsSkeleton label={`Loading ${active.name}'s listings…`} />;
  }
  return <ListingsView summary={summary.data} refresh={summary.refetch} />;
}

export function ListingsView({
  summary,
  refresh,
}: {
  summary: CommunitySummary;
  refresh: () => Promise<void>;
}) {
  const { community, listings, role } = summary;
  const groups = groupListings(listings);
  const [closedOpen, setClosedOpen] = useState(false);
  const [withdrawn, setWithdrawn] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const withdrawnRef = useRef<HTMLHeadingElement>(null);
  const [now] = useState(() => Date.now());
  const listHref = listingHref(community.id);

  // The withdrawn row now sits under Closed: focus it there, since its button is gone.
  const withdrawnId = withdrawn?.id;
  const landed = groups.closed.some((l) => l.asset.id === withdrawnId);
  // Keyed on the ID too: a second withdrawal in the same visit lands while `landed` stays true.
  useEffect(() => {
    if (landed) withdrawnRef.current?.focus();
  }, [landed, withdrawnId]);

  async function afterWithdraw(id: string, name: string) {
    await refresh();
    setClosedOpen(true);
    setWithdrawn({ id, name });
  }

  const rows = (items: ListingSummary[]) => (
    <ul className="divide-y divide-border">
      {items.map((listing) => (
        <ListingRow
          key={listing.asset.id}
          listing={listing}
          communityId={community.id}
          owner={role === "owner"}
          member={role !== null}
          fresh={listing.asset.id === withdrawn?.id}
          headingRef={
            listing.asset.id === withdrawn?.id ? withdrawnRef : undefined
          }
          now={now}
          onWithdrawn={() =>
            afterWithdraw(listing.asset.id, listing.asset.name)
          }
          onStale={() => void refresh()}
        />
      ))}
    </ul>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{community.name}</p>
          <h1 className="mt-1 font-serif text-5xl leading-none tracking-tight sm:text-6xl">
            Listings
          </h1>
        </div>
        <Button asChild>
          <Link href={listHref}>
            <Plus aria-hidden="true" />
            List land
          </Link>
        </Button>
      </div>
      <p className="mt-3 max-w-2xl text-pretty text-muted-foreground">
        Every site your community has listed or started to list. Drafts stay
        private until they&apos;re rated; withdrawing keeps the record.
      </p>
      <p role="status" className="sr-only">
        {withdrawn && landed
          ? `${withdrawn.name} was withdrawn. It's under Closed now.`
          : ""}
      </p>

      {listings.length === 0 ? (
        <EmptyListings listHref={listHref} />
      ) : (
        <div className="mt-8 space-y-6">
          <Group group="in_progress" count={groups.in_progress.length}>
            {groups.in_progress.length ? (
              rows(groups.in_progress)
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing in progress. Drafts, ratings and sites waiting for
                verification or their opening offer show here.
              </p>
            )}
          </Group>
          <Group group="live" count={groups.live.length}>
            {groups.live.length ? (
              rows(groups.live)
            ) : (
              <p className="text-sm text-muted-foreground">
                No live sites yet. A site goes live when it opens to supporters.
              </p>
            )}
          </Group>
          {groups.closed.length > 0 && (
            <Collapsible open={closedOpen} onOpenChange={setClosedOpen}>
              <section
                aria-labelledby="closed-title"
                className="rounded-3xl bg-card p-6 shadow-soft"
              >
                <h2 id="closed-title" className="text-base font-semibold">
                  <CollapsibleTrigger className="-m-2 flex items-center gap-2 rounded-xl p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {GROUP_TITLE.closed}
                    <span className="tabular text-sm font-normal text-muted-foreground">
                      {groups.closed.length}
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        "size-4 text-muted-foreground transition-transform motion-reduce:transition-none",
                        closedOpen && "rotate-180",
                      )}
                    />
                  </CollapsibleTrigger>
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Withdrawn or not eligible. They keep their record and free
                  their land for a new listing.
                </p>
                <CollapsibleContent className="mt-4">
                  {rows(groups.closed)}
                </CollapsibleContent>
              </section>
            </Collapsible>
          )}
          {listings.some((l) => {
            const icon = siteIcon(l.asset);
            return icon !== null && !icon.siteKey && !icon.src;
          }) && (
            <p className="text-[11px] text-muted-foreground">
              Site maps: {IMAGERY_ATTRIBUTION}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Group({
  group,
  count,
  children,
}: {
  group: ListingGroup;
  count: number;
  children: React.ReactNode;
}) {
  const id = `${group}-title`;
  return (
    <section
      aria-labelledby={id}
      className="rounded-3xl bg-card p-6 shadow-soft"
    >
      <h2
        id={id}
        className="mb-2 flex items-center gap-2 text-base font-semibold"
      >
        {GROUP_TITLE[group]}
        <span className="tabular text-sm font-normal text-muted-foreground">
          {count}
        </span>
      </h2>
      {children}
    </section>
  );
}

function EmptyListings({ listHref }: { listHref: string }) {
  return (
    <section
      aria-labelledby="empty-listings-title"
      className="mt-8 rounded-3xl bg-card p-8 shadow-soft sm:p-10"
    >
      <h2
        id="empty-listings-title"
        className="font-serif text-3xl tracking-tight"
      >
        No listings yet
      </h2>
      <p className="mt-2 max-w-lg text-pretty text-muted-foreground">
        Draw the boundary of the land your community protects. Your draft
        appears here, then follows its rating, verification and opening offer.
      </p>
      <Button asChild className="mt-5">
        <Link href={listHref}>
          List your land
          <Plus aria-hidden="true" />
        </Link>
      </Button>
    </section>
  );
}
