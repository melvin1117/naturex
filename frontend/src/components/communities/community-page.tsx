"use client";

import { ArrowLeft, ArrowRight, Settings } from "lucide-react";
import Link from "@/components/app-link";
import { useEffect, useRef } from "react";
import { cn } from "cn";

import { Figure, Figures } from "@/components/figures";
import {
  BackThisSiteIcon,
  CommunityFundIcon,
  ListLandIcon,
  RatedSitesIcon,
} from "@/components/icons";
import { Delta, SiteThumb } from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { takeJustCreated } from "@/components/shell/steward-community";
import { WithdrawListingDialog } from "@/components/steward/withdraw-listing-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CommunitySummary, ListingSummary } from "@/lib/api/types";
import {
  roleLine,
  shownSites,
  type SiteState,
  type SiteTone,
} from "@/lib/community-sites";
import { countryName, marketCard, siteIcon } from "@/lib/market-cards";
import { withCommunity } from "@/lib/navigation";
import { ha } from "@/lib/format";
import { moneyText, unitPriceText } from "@/lib/trade";

const TONE: Record<SiteTone, string> = {
  live: "bg-primary text-primary-foreground",
  ready: "bg-lime text-foreground",
  working: "bg-sky text-foreground",
  attention: "bg-clay-ink text-white",
  draft: "bg-card text-foreground",
};

/**
 * One community (`/steward?community=<id>`): its name, a sentence on how its land is doing,
 * and its sites, each saying where it stands and leading to its next step.
 */
export function CommunityPage({
  summary,
  onChanged,
}: {
  summary: CommunitySummary;
  /** A listing was withdrawn, or the list is out of date: load it again. */
  onChanged: () => Promise<unknown>;
}) {
  const { community, listings, role } = summary;
  const sites = shownSites(listings, community.id);
  const listHref = withCommunity("/steward/list", community.id);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const meta = [countryName(community.country ?? null), roleLine(role)]
    .filter(Boolean)
    .join(" · ");
  // Just created from Communities: the form that held focus is gone, so the page takes it.
  useEffect(() => {
    if (takeJustCreated(community.id)) headingRef.current?.focus();
  }, [community.id]);
  // A withdrawn tile is gone, and the dialog leaves focus to the page: the heading takes it.
  const afterWithdraw = async () => {
    await onChanged();
    headingRef.current?.focus();
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pt-8 pb-16 sm:px-6">
      <Link
        href="/steward"
        className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All communities
      </Link>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="max-w-3xl min-w-0">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="font-serif text-5xl leading-[0.95] tracking-tight text-balance break-words outline-none sm:text-6xl"
          >
            {community.name}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">{meta}</p>
          <Lede summary={summary} owner={role === "owner"} />
        </div>
        {role === "owner" && (
          <Button asChild variant="outline">
            <Link href={withCommunity("/steward/community", community.id)}>
              <Settings aria-hidden="true" />
              Edit community
            </Link>
          </Button>
        )}
      </div>

      <h2 className="sr-only">Sites</h2>
      {sites.length === 0 ? (
        <div className="mt-10 grid place-items-center rounded-3xl border border-dashed border-foreground/20 px-6 py-16 text-center">
          <ListLandIcon size={32} aria-hidden="true" />
          <p className="mt-4 max-w-md text-pretty text-muted-foreground">
            Draw your land on the map and WildWorth rates it from satellite data
            and local news.
          </p>
          <Button asChild className="mt-6">
            <Link href={listHref}>List your first site</Link>
          </Button>
        </div>
      ) : (
        <ul
          aria-label={`${community.name}'s sites`}
          className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          {sites.map(({ site, state }) => (
            <SiteTile
              key={site.asset.id}
              site={site}
              state={state}
              canWithdraw={site.manage_actions.includes("withdraw")}
              onWithdrawn={afterWithdraw}
              onStale={() => void onChanged()}
            />
          ))}
          <li>
            <Link
              href={listHref}
              className="flex h-full min-h-48 flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-foreground/20 p-6 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ListLandIcon size={24} aria-hidden="true" />
              List more land
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * Where the community stands. With sites on the Marketplace: its figures (sites, supporters, the
 * community fund); before that, one line on what comes next.
 */
function Lede({
  summary,
  owner,
}: {
  summary: CommunitySummary;
  owner: boolean;
}) {
  const live = summary.listings.filter((l) => l.asset.trading).length;
  const supporters = summary.holder_count;
  if (live > 0)
    return (
      <Figures className="mt-6">
        <Figure
          icon={RatedSitesIcon}
          value={live}
          label={
            live === 1 ? "site on the Marketplace" : "sites on the Marketplace"
          }
        />
        <Figure
          icon={BackThisSiteIcon}
          value={supporters}
          label={supporters === 1 ? "supporter" : "supporters"}
        />
        <Figure
          icon={CommunityFundIcon}
          value={moneyText(summary.wallet.balance)}
          label="in the community fund"
        />
      </Figures>
    );
  return (
    <p className="mt-5 max-w-2xl text-lg text-pretty text-muted-foreground">
      {summary.listings.some((l) => l.ipo_at && l.asset.status === "suspended")
        ? "Trading is paused on its sites for now."
        : summary.listings.some((l) => l.asset.status !== "withdrawn")
          ? owner
            ? "Nothing on the Marketplace yet. Finish a listing and send its offer to the Reviewer."
            : "Nothing on the Marketplace yet. Finish a listing; the owner sends its offer to the Reviewer."
          : "No land listed yet."}
    </p>
  );
}

function SiteTile({
  site,
  state,
  canWithdraw,
  onWithdrawn,
  onStale,
}: {
  site: ListingSummary;
  state: SiteState;
  canWithdraw: boolean;
  onWithdrawn: () => Promise<void>;
  onStale: () => void;
}) {
  const card = marketCard(site.asset);
  const icon = siteIcon(site.asset);
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-3xl bg-card shadow-soft transition-shadow focus-within:shadow-lift hover:shadow-lift">
      <div className="relative">
        {icon ? (
          <SiteThumb
            siteKey={icon.siteKey}
            src={icon.src}
            outline={icon.outline}
            alt=""
            creditHidden
            className="aspect-[16/10]"
          />
        ) : (
          <div className="grid aspect-[16/10] place-items-center bg-lichen">
            <ListLandIcon size={32} aria-hidden="true" />
          </div>
        )}
        {/* The link says it too: read once. */}
        <Badge
          aria-hidden="true"
          className={cn(
            "absolute top-3 left-3 border-transparent shadow-soft",
            TONE[state.tone],
          )}
        >
          {state.label}
        </Badge>
        {card.grade && (
          <div className="absolute right-3 bottom-3">
            <GradeBadge grade={card.grade} />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-5">
        <h3 className="font-serif text-2xl leading-[1.1] tracking-tight text-balance">
          <Link
            href={state.href}
            className="outline-none after:absolute after:inset-0 after:rounded-3xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {site.asset.name}
            <span className="sr-only">
              : {state.label}. {state.cta}
            </span>
          </Link>
        </h3>
        {state.tone === "live" && card.price !== null ? (
          <p className="tabular flex flex-wrap items-baseline gap-x-2 text-sm">
            {unitPriceText(site.asset.price)} a unit
            {card.changePct !== null && (
              <Delta value={card.changePct} className="text-xs" />
            )}
          </p>
        ) : (
          <p className="text-sm text-pretty text-muted-foreground">
            {state.detail ?? ha(card.areaHa)}
          </p>
        )}
        <div className="mt-auto flex items-center justify-between gap-3 pt-3 text-sm">
          <span
            aria-hidden="true"
            className="inline-flex items-center gap-1 font-medium"
          >
            {state.cta}
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </span>
          {canWithdraw && (
            <div className="relative z-10 -my-1">
              <WithdrawListingDialog
                assetId={site.asset.id}
                name={site.asset.name}
                onWithdrawn={onWithdrawn}
                onStale={onStale}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
