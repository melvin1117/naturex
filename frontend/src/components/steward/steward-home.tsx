"use client";

import {
  ArrowRight,
  Camera,
  Check,
  ExternalLink,
  ListChecks,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "@/components/app-link";
import { useRef, type ReactNode } from "react";
import { cn } from "cn";

import { AlertsList } from "@/components/alerts-list";
import { Delta, SiteBackdrop, Stat } from "@/components/proto/bits";
import { GradeBadge } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { LoadError } from "@/components/proto/load-error";
import { StewardHomeSkeleton } from "@/components/page-skeletons";
import { StewardPanel } from "@/components/steward/panel";
import { StewardHome as PrototypeStewardHome } from "@/components/proto/steward-home";
import { useStewardCommunity } from "@/components/shell/steward-community";
import { MembersPanel } from "@/components/steward/members-panel";
import {
  useSeenNotices,
  VerificationNotices,
} from "@/components/steward/verification-notices";
import { WalletCard } from "@/components/steward/wallet-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VerificationBadge } from "@/components/verification/parts";
import type { CommunitySummary, ListingSummary } from "@/lib/api/types";
import {
  decisionNotice,
  noticeAlerts,
  type DecisionNotice,
  listingAction,
  listingStatusLine,
  sharePct,
  STATUS_LABEL,
  units,
  unseenNotices,
  verificationChip,
} from "@/lib/community";
import { useCommunitySummary } from "@/lib/community-hooks";
import { payoutsEmptyText, recommendationsEmptyText } from "@/lib/empty-states";
import { useAlerts, useMarkAlertRead, useWorld } from "@/lib/hooks";
import { marketCard } from "@/lib/market-cards";
import { evidenceHref } from "@/lib/field-evidence";
import { listingsHref, verifyHref } from "@/lib/listing/links";
import { COMMUNITY_ROLE_LABEL, withCommunity } from "@/lib/navigation";
import { date, ha, quarterLabel } from "@/lib/prototype/format";
import { inProgressText } from "@/lib/steward-listings";
import { moneyText, unitPriceText } from "@/lib/trade";

/**
 * `/steward`: a signed-in member's community home (T63, story A8), else the scripted
 * prototype for the anonymous demo (until T65).
 */
export function StewardHomeRoute() {
  const { world } = useWorld();
  return world?.me ? <StewardHome /> : <PrototypeStewardHome />;
}

export function StewardHome() {
  const { active } = useStewardCommunity();
  const summary = useCommunitySummary(active?.id);

  if (!active) return null; // StewardGate shows the empty state or the loader.
  if (summary.error && !summary.data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <LoadError
          title="We couldn't load your community home"
          error={summary.error}
          retry={summary.refetch}
        />
      </div>
    );
  }
  if (!summary.data || summary.data.community.id !== active.id) {
    return <StewardHomeSkeleton label={`Loading ${active.name}…`} />;
  }
  return <Home summary={summary.data} />;
}

function Home({ summary }: { summary: CommunitySummary }) {
  const { world } = useWorld();
  const { community, listings, role } = summary;
  const isOwner = role === "owner";
  const listHref = withCommunity("/steward/list", community.id);
  const settingsHref = withCommunity("/steward/community", community.id);
  const manageHref = listingsHref(community.id);
  const unfinished = inProgressText(listings);
  const featured =
    listings.find((l) => l.asset.status === "listed") ?? listings[0];
  const trading = listings.filter((l) => l.asset.trading).length;
  const { seen, readAt, dismiss } = useSeenNotices(world?.me?.id);
  // A reviewer's decision is for the community's members; an admin reading the home isn't one.
  const notices =
    seen && readAt !== null && role
      ? unseenNotices(
          listings.map((l) =>
            decisionNotice(l, community.id, { owner: isOwner, now: readAt }),
          ),
          seen,
        )
      : [];
  // Dismissing a notice also reads the bell's alert about the same decision.
  const alerts = useAlerts({ communityId: community.id });
  const markRead = useMarkAlertRead();
  const dismissNotice = (notice: DecisionNotice) => {
    dismiss(notice);
    for (const id of noticeAlerts(alerts.data?.alerts ?? [], notice)) {
      void markRead.mutate(id);
    }
  };
  const headingRef = useRef<HTMLHeadingElement>(null);

  return (
    <div className="mx-auto max-w-7xl px-4 pt-10 pb-16 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {world?.me?.name} · {role ? COMMUNITY_ROLE_LABEL[role] : "Admin"}
          </p>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="mt-1 font-serif text-5xl leading-none tracking-tight text-balance break-words outline-none sm:text-6xl"
          >
            {community.name}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {listings.length > 0 && (
            <Button asChild variant="outline">
              <Link href={manageHref}>
                <ListChecks aria-hidden="true" />
                Listings{" "}
                {unfinished && (
                  <span className="tabular rounded-full bg-lime/40 px-2 py-0.5 text-xs text-lime-ink">
                    {unfinished}
                  </span>
                )}
              </Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href={settingsHref}>
              <Settings aria-hidden="true" />
              {isOwner ? "Edit community" : "Community details"}
            </Link>
          </Button>
          {listings.length > 0 && (
            <Button asChild>
              <Link href={listHref}>
                List more land
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          )}
        </div>
      </div>

      <VerificationNotices
        notices={notices}
        onDismiss={dismissNotice}
        focusWhenEmpty={headingRef}
        className="mt-8"
      />

      {listings.length > 0 && (
        <dl className="mt-8 grid gap-4 rounded-3xl bg-card p-6 shadow-soft sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Community fund"
            value={moneyText(summary.wallet.balance)}
            sub="From supporters and quarterly payouts · play money"
          />
          <Stat
            label="Payouts on kept units"
            value={moneyText(summary.wallet.retained_dividends)}
            sub="for the units your community keeps"
          />
          <Stat
            label="Supporters"
            value={units(summary.holder_count)}
            sub="hold units of your sites"
          />
          <Stat
            label="Sites"
            value={units(listings.length)}
            sub={`${units(trading)} open to supporters`}
          />
        </dl>
      )}

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-8">
          {featured ? (
            <FeaturedListing
              listing={featured}
              communityId={community.id}
              owner={isOwner}
            />
          ) : (
            <EmptyHome listHref={listHref} />
          )}
          {listings.length > 1 && (
            <StewardPanel
              title="Your sites"
              action={
                <Link
                  href={manageHref}
                  className="text-sm font-medium underline underline-offset-4"
                >
                  Manage listings
                </Link>
              }
            >
              <ul className="divide-y divide-border">
                {listings.map((listing) => (
                  <ListingRow
                    key={listing.asset.id}
                    listing={listing}
                    communityId={community.id}
                    owner={isOwner}
                  />
                ))}
              </ul>
            </StewardPanel>
          )}
          {listings.length > 0 && <Recommendations listings={listings} />}
          {listings.length > 0 && <Payouts summary={summary} />}
        </div>

        <aside className="min-w-0 space-y-6" aria-label="Community">
          {listings.length > 0 && <WalletCard wallet={summary.wallet} />}
          <StewardPanel title="WildWatch alerts">
            <AlertsList
              key={community.id}
              communityId={community.id}
              empty="No alerts yet. You'll see news and re-ratings about your land here."
            />
          </StewardPanel>
          {listings.length > 0 && <Supporters listings={listings} />}
          <MembersPanel
            communityId={community.id}
            footer={
              <p className="mt-3 text-xs text-muted-foreground">
                Members can&apos;t trade their own sites&apos; units.{" "}
                {isOwner && (
                  <Link
                    href={settingsHref}
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    Manage members
                  </Link>
                )}
              </p>
            }
          />
        </aside>
      </div>
    </div>
  );
}

function EmptyHome({ listHref }: { listHref: string }) {
  return (
    <section
      aria-labelledby="empty-home-title"
      className="relative isolate overflow-hidden rounded-[2rem] bg-primary p-8 text-primary-foreground shadow-lift sm:p-10"
    >
      <div className="max-w-lg">
        <h2
          id="empty-home-title"
          className="font-serif text-4xl tracking-tight text-balance"
        >
          List your land
        </h2>
        <p className="mt-3 text-pretty text-primary-foreground/85">
          Draw the boundary of the land your community protects. WildWorth rates
          it from satellite data in a few minutes, and you decide afterwards
          whether to open it to supporters.
        </p>
        <Button
          asChild
          size="lg"
          className="mt-6 bg-lime text-foreground hover:bg-lime/90"
        >
          <Link href={listHref}>
            List your land
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </section>
  );
}

function ActionButton({
  listing,
  communityId,
  owner,
  tone,
}: {
  listing: ListingSummary;
  communityId: string;
  owner: boolean;
  tone: "image" | "plain";
}) {
  const action = listingAction(
    listing.next_action,
    listing.asset.id,
    communityId,
    listing.asset.status,
    { owner, verification: listing.verification },
  );
  const secondary = action.secondary && (
    <ListingLink
      href={action.secondary.href}
      label={`${action.secondary.label}: ${listing.asset.name}`}
      tone={tone}
    >
      {action.secondary.label}
    </ListingLink>
  );
  if (!action.href) {
    return (
      <>
        <span
          className={
            tone === "image"
              ? "inline-flex items-center rounded-full bg-white/15 px-3 py-1.5 text-sm"
              : "text-sm text-muted-foreground"
          }
        >
          {action.label}
        </span>
        {secondary}
      </>
    );
  }
  const external = listing.next_action === "view_on_exchange";
  const lime = tone === "image" && action.primary;
  return (
    <>
      <Button
        asChild
        size={tone === "image" ? "default" : "sm"}
        variant={action.primary ? "default" : "outline"}
        className={cn(
          lime && "bg-lime text-foreground hover:bg-lime/90",
          tone === "image" &&
            !action.primary &&
            "border-white/40 bg-transparent text-white hover:bg-white/15 hover:text-white",
        )}
      >
        <Link
          href={action.href}
          aria-label={
            tone === "plain"
              ? `${action.label}: ${listing.asset.name}`
              : undefined
          }
        >
          {action.label}
          {external ? (
            <ExternalLink aria-hidden="true" />
          ) : (
            <ArrowRight aria-hidden="true" />
          )}
        </Link>
      </Button>
      {secondary}
    </>
  );
}

/** A withdrawn or ineligible listing has no verification or field evidence to open. */
function closed(listing: ListingSummary): boolean {
  const status = listing.asset.status;
  return status === "withdrawn" || status === "ineligible";
}

/** A listing's secondary screen (verification, field photos) beside its next action. */
function ListingLink({
  href,
  label,
  tone,
  children,
}: {
  href: string;
  label: string;
  tone: "image" | "plain";
  children: ReactNode;
}) {
  return (
    <Button
      asChild
      size={tone === "image" ? "default" : "sm"}
      variant="ghost"
      className={
        tone === "image"
          ? "bg-white/15 text-white hover:bg-white/25 hover:text-white"
          : ""
      }
    >
      <Link href={href} aria-label={label}>
        {children}
      </Link>
    </Button>
  );
}

/** The listing's verification screen (T70), unless the next step already leads there. */
function VerifyLink({
  listing,
  communityId,
  tone,
}: {
  listing: ListingSummary;
  communityId: string;
  tone: "image" | "plain";
}) {
  // The next step already leads to the verification screen: no second link to it.
  const next = listing.next_action;
  if (closed(listing) || next === "verify" || next === "verification_in_review")
    return null;
  return (
    <ListingLink
      href={verifyHref(listing.asset.id, communityId)}
      label={`Verification of ${listing.asset.name}`}
      tone={tone}
    >
      <ShieldCheck aria-hidden="true" />
      Verification
    </ListingLink>
  );
}

/** The listing's field evidence screen (T40, #214): photos that can raise its confidence. */
function EvidenceLink({
  listing,
  communityId,
  tone,
}: {
  listing: ListingSummary;
  communityId: string;
  tone: "image" | "plain";
}) {
  if (closed(listing)) return null;
  return (
    <ListingLink
      href={evidenceHref(listing.asset.id, communityId)}
      label={`Field photos of ${listing.asset.name}`}
      tone={tone}
    >
      <Camera aria-hidden="true" />
      Field photos
    </ListingLink>
  );
}

/** The listing's verification, shown once it's listed: what the opening offer waits for. */
function VerificationChip({
  listing,
  tone,
}: {
  listing: ListingSummary;
  tone: "image" | "light";
}) {
  const status = listing.asset.status;
  if (status !== "listed" && status !== "suspended") return null;
  const level = listing.verification.level;
  return (
    <VerificationBadge level={level} tone={tone}>
      {verificationChip(listing.verification)}
    </VerificationBadge>
  );
}

function FeaturedListing({
  listing,
  communityId,
  owner,
}: {
  listing: ListingSummary;
  communityId: string;
  owner: boolean;
}) {
  const card = marketCard(listing.asset);
  return (
    <section
      aria-labelledby="featured-title"
      className="relative isolate overflow-hidden rounded-[2rem] text-white shadow-lift"
    >
      <SiteBackdrop src={card.imageUrl} outline={card.outline} />
      <div className="relative grid gap-6 p-6 sm:p-8 md:grid-cols-[auto_1fr]">
        {card.health !== null && (
          <HealthRing value={card.health} tone="dark" size={160} />
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {card.grade && <GradeBadge grade={card.grade} size="lg" />}
            <span className="rounded-full bg-white/15 px-2.5 py-1 text-xs">
              {STATUS_LABEL[card.status] ?? card.status}
            </span>
            <VerificationChip listing={listing} tone="image" />
            {listing.asset.mock && (
              <span className="rounded-full bg-white/15 px-2.5 py-1 text-xs">
                Mock data
              </span>
            )}
          </div>
          <h2
            id="featured-title"
            className="mt-3 font-serif text-4xl break-words"
          >
            {card.name}
          </h2>
          <p className="mt-2 text-white/85">
            {ha(card.areaHa)} ·{" "}
            {listingStatusLine(listing, card.status, card.trading)}
          </p>
          {card.trading && card.price !== null && (
            <p className="mt-1 text-white/85">
              Stake price{" "}
              <span className="tabular">
                {unitPriceText(listing.asset.price)}
              </span>{" "}
              <span className="text-xs">(play money)</span>{" "}
              {card.changePct !== null && (
                <Delta
                  value={card.changePct}
                  suffix="since opening"
                  className="text-white [&_span]:text-white/90"
                />
              )}
            </p>
          )}
          {listing.shares && (
            <p className="mt-1 text-sm text-white/80">
              {units(listing.shares.shares_sold)} of{" "}
              {units(listing.shares.shares_offered)} units taken by supporters ·
              community keeps {units(listing.shares.retained_shares)}
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <ActionButton
              listing={listing}
              communityId={communityId}
              owner={owner}
              tone="image"
            />
            <VerifyLink
              listing={listing}
              communityId={communityId}
              tone="image"
            />
            <EvidenceLink
              listing={listing}
              communityId={communityId}
              tone="image"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function ListingRow({
  listing,
  communityId,
  owner,
}: {
  listing: ListingSummary;
  communityId: string;
  owner: boolean;
}) {
  const card = marketCard(listing.asset);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate font-medium">{card.name}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">
            {STATUS_LABEL[card.status] ?? card.status}
          </Badge>
          <VerificationChip listing={listing} tone="light" />
          {card.grade && <span>Grade {card.grade}</span>}
          <span>{ha(card.areaHa)}</span>
          {card.trading && (
            <span className="tabular">
              {moneyText(listing.wallet.balance)} to the fund
            </span>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <VerifyLink listing={listing} communityId={communityId} tone="plain" />
        <EvidenceLink
          listing={listing}
          communityId={communityId}
          tone="plain"
        />
        <ActionButton
          listing={listing}
          communityId={communityId}
          owner={owner}
          tone="plain"
        />
      </div>
    </li>
  );
}

function Recommendations({ listings }: { listings: ListingSummary[] }) {
  const rated = listings.filter((l) => l.recommendations.length > 0);
  return (
    <StewardPanel title="Recovery plan">
      {rated.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {recommendationsEmptyText(listings)}
        </p>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Concrete steps from the latest report that would strengthen the
            rating.
          </p>
          {rated.map((listing) => (
            <div key={listing.asset.id}>
              {rated.length > 1 && (
                <h3 className="mb-2 text-sm font-medium">
                  {listing.asset.name}
                </h3>
              )}
              <ul className="space-y-2">
                {listing.recommendations.map((text) => (
                  <li
                    key={text}
                    className="flex gap-3 rounded-2xl bg-secondary/50 p-3 text-sm"
                  >
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-lime-ink"
                      aria-hidden="true"
                    />
                    {text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </StewardPanel>
  );
}

function Payouts({ summary }: { summary: CommunitySummary }) {
  return (
    <StewardPanel title="Quarterly payouts">
      {summary.payouts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {payoutsEmptyText(summary.listings)}
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground sm:hidden">
            Scroll sideways to see every column.
          </p>
          <div
            className="overflow-x-auto"
            role="region"
            aria-label="Quarterly payouts table"
            tabIndex={0}
          >
            <table className="w-full min-w-[34rem] text-sm">
              <caption className="sr-only">
                The latest quarterly payouts, play money
              </caption>
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="pb-2 font-normal">
                    Quarter
                  </th>
                  <th scope="col" className="pb-2 pl-4 font-normal">
                    Site
                  </th>
                  <th scope="col" className="pb-2 pl-4 text-right font-normal">
                    Revenue
                  </th>
                  <th scope="col" className="pb-2 pl-4 text-right font-normal">
                    To the fund
                  </th>
                  <th scope="col" className="pb-2 pl-4 text-right font-normal">
                    On kept units
                  </th>
                </tr>
              </thead>
              <tbody className="tabular divide-y divide-border">
                {summary.payouts.map((p) => (
                  <tr key={`${p.asset_id}:${p.quarter_label}`}>
                    <td className="py-2">
                      {/^\d{4}Q[1-4]$/.test(p.quarter_label)
                        ? quarterLabel(p.quarter_label)
                        : p.quarter_label}
                      <span className="block text-xs text-muted-foreground">
                        {date(p.paid_at)}
                      </span>
                    </td>
                    <td className="py-2 pl-4">{p.asset_name}</td>
                    <td className="py-2 pl-4 text-right">
                      {moneyText(p.revenue)}
                    </td>
                    <td className="py-2 pl-4 text-right">
                      {moneyText(p.community_fund)}
                    </td>
                    <td className="py-2 pl-4 text-right">
                      {moneyText(p.retained_dividend)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {summary.payouts_count > summary.payouts.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the latest {summary.payouts.length} of{" "}
                {summary.payouts_count}.
              </p>
            )}
          </div>
        </>
      )}
    </StewardPanel>
  );
}

function Supporters({ listings }: { listings: ListingSummary[] }) {
  const launched = listings.filter((l) => l.shares !== null);
  return (
    <StewardPanel title="Supporters">
      {launched.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Supporters appear after the opening offer.
        </p>
      ) : (
        <div className="space-y-4">
          {launched.map((listing) => (
            <div key={listing.asset.id}>
              {launched.length > 1 && (
                <h3 className="mb-1 text-sm font-medium">
                  {listing.asset.name}
                </h3>
              )}
              {listing.holders.count === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No supporters yet. Share your public page.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {units(listing.holders.count)}{" "}
                    {listing.holders.count === 1
                      ? "supporter holds"
                      : "supporters hold"}{" "}
                    {units(listing.holders.shares_held)}{" "}
                    {listing.holders.shares_held === 1 ? "unit" : "units"}
                  </p>
                  <ol className="mt-2 space-y-1.5 text-sm">
                    {listing.holders.top.map((holder) => (
                      <li
                        key={holder.rank}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Users
                            className="size-4 text-muted-foreground"
                            aria-hidden="true"
                          />
                          Supporter {holder.rank}
                        </span>
                        <span className="tabular text-muted-foreground">
                          {units(holder.shares)} units ·{" "}
                          {sharePct(holder.pct_of_shares)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Supporters are shown without names.
          </p>
        </div>
      )}
    </StewardPanel>
  );
}
