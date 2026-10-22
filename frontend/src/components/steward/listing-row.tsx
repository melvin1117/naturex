"use client";

import {
  ArrowRight,
  Archive,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Hourglass,
  Leaf,
  PencilLine,
  Sprout,
} from "lucide-react";
import Link from "next/link";
import { useMemo, type Ref } from "react";
import { cn } from "cn";

import { ICON_FRAME } from "@/components/boundary-map";
import { SiteThumb } from "@/components/proto/bits";
import { WithdrawListingDialog } from "@/components/steward/withdraw-listing-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AssetDetail, ListingSummary } from "@/lib/api/types";
import { siteIcon } from "@/lib/market-cards";
import { ha } from "@/lib/prototype/format";
import {
  listingStatusWords,
  rowActions,
  updatedText,
  type StatusTone,
} from "@/lib/steward-listings";

const TONE: Record<StatusTone, { icon: typeof Leaf; className: string }> = {
  draft: {
    icon: PencilLine,
    className: "bg-secondary text-secondary-foreground",
  },
  working: { icon: Hourglass, className: "bg-sky/25 text-foreground" },
  attention: { icon: CircleAlert, className: "bg-clay/15 text-clay-ink" },
  ready: { icon: CircleCheck, className: "bg-lime/40 text-lime-ink" },
  live: { icon: Sprout, className: "bg-primary text-primary-foreground" },
  closed: { icon: Archive, className: "bg-lichen text-muted-foreground" },
};

/**
 * One listing on the Listings page (#233): its boundary thumbnail, name, status in plain
 * words, when it last changed, and what can be done with it now.
 */
export function ListingRow({
  listing,
  communityId,
  owner,
  member,
  fresh = false,
  headingRef,
  now,
  onWithdrawn,
  onStale,
}: {
  listing: ListingSummary;
  communityId: string;
  owner: boolean;
  member: boolean;
  /** Just withdrawn here: the row washes once and says so. */
  fresh?: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  now: number;
  onWithdrawn: (asset: AssetDetail) => Promise<void> | void;
  onStale: () => void;
}) {
  const { asset } = listing;
  const words = listingStatusWords(listing);
  const actions = rowActions(listing, communityId, { owner, member });
  const tone = TONE[words.tone];
  const external = listing.next_action === "view_on_exchange";

  return (
    <li
      className={cn(
        "-mx-3 flex gap-4 rounded-2xl px-3 py-4",
        fresh && "nx-wash",
      )}
      data-listing={asset.id}
    >
      <Thumb card={asset} />
      <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 sm:max-w-md">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="font-medium break-words outline-none"
          >
            {asset.name}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <Badge className={cn("gap-1.5 border-transparent", tone.className)}>
              <tone.icon aria-hidden="true" />
              {words.label}
            </Badge>
            <span>
              {fresh
                ? "Withdrawn just now"
                : updatedText(listing.updated_at, now)}
            </span>
            <span aria-hidden="true">·</span>
            <span className="tabular">{ha(Number(asset.area_ha))}</span>
          </p>
          {words.detail && (
            <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
              {words.detail}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions.withdraw && (
            <WithdrawListingDialog
              assetId={asset.id}
              name={asset.name}
              onWithdrawn={onWithdrawn}
              onStale={onStale}
            />
          )}
          {actions.edit && (
            <Button asChild variant="outline" size="sm">
              <Link
                href={actions.edit.href}
                aria-label={`${actions.edit.label}: ${asset.name}`}
              >
                <PencilLine aria-hidden="true" />
                {actions.edit.label}
              </Link>
            </Button>
          )}
          {actions.view && (
            <Button asChild variant="outline" size="sm">
              <Link
                href={actions.view.href}
                aria-label={`${actions.view.label}: ${asset.name}`}
              >
                {actions.view.label}
              </Link>
            </Button>
          )}
          {actions.next && (
            <Button
              asChild
              size="sm"
              variant={actions.next.primary ? "default" : "outline"}
            >
              <Link
                href={actions.next.href}
                aria-label={`${actions.next.label}: ${asset.name}`}
              >
                {actions.next.label}
                {external ? (
                  <ExternalLink aria-hidden="true" />
                ) : (
                  <ArrowRight aria-hidden="true" />
                )}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function Thumb({ card }: { card: ListingSummary["asset"] }) {
  const icon = useMemo(() => siteIcon(card), [card]);
  if (!icon)
    return (
      <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-lichen">
        <Leaf className="size-5 text-lime-ink" aria-hidden="true" />
      </span>
    );
  return (
    <SiteThumb
      siteKey={icon.siteKey}
      src={icon.src}
      outline={icon.outline}
      alt=""
      frame={ICON_FRAME}
      credit={false}
      className="size-16 shrink-0 rounded-2xl"
    />
  );
}
