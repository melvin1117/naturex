"use client";

import { ArrowRight, Bot } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ValueRange } from "@/components/proto/bits";
import { GradeStamp } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { VerificationBadge } from "@/components/verification/parts";
import type { AssetDetail, MyCommunity } from "@/lib/api/types";
import {
  listingAction,
  verificationChip,
  type ListingAction,
} from "@/lib/community";
import { useCommunitySummary } from "@/lib/community-hooks";
import { ipoHref, listingOutcome, stewardHomeHref } from "@/lib/listing";
import { DURATION, usePrefersReducedMotion } from "@/lib/motion";
import { GRADE_LABEL, money } from "@/lib/prototype/format";
import { reportFacts, type ReportFacts } from "@/lib/report-facts";
import { assetHref } from "@/lib/trade";

import { MockBadge, StepCard } from "./shared";

/**
 * The beats of the rating reveal (#216), in ms: the dial lights and its numeral counts up, the
 * grade stamp presses in as the count settles, then the value range opens from its centre.
 */
export const REVEAL_AT = {
  dial: 0,
  stamp: DURATION.reveal - 300,
  range: DURATION.reveal - 200,
} as const;

/** What a screen reader hears once when a new rating lands: every number the reveal shows. */
export function revealAnnouncement(name: string, facts: ReportFacts): string {
  const value =
    facts.valueLow !== null &&
    facts.valueMid !== null &&
    facts.valueHigh !== null
      ? ` Estimated value ${money(facts.valueLow)} to ${money(facts.valueHigh)} a year, midpoint ${money(facts.valueMid)}.`
      : "";
  return `${name} is listed. Grade ${facts.grade}, ${GRADE_LABEL[facts.grade]}: health ${facts.health.toFixed(1)} out of 100.${value} ${facts.confidence.toFixed(0)}% confidence.`;
}

/**
 * Step 4: a listed (or suspended) site, and the way to its opening offer (T64). `reveal` (a
 * rating this tab just watched) stages the result: dial, grade, value range. The numbers are the
 * report's from the start; motion only orders them, and reduced motion shows them at once.
 */
export function ListedStep({
  community,
  asset,
  reveal = false,
  onOpenTrace,
}: {
  community: MyCommunity;
  asset: AssetDetail;
  reveal?: boolean;
  /** Opens the Agent Trace on a run: here, the one that produced this rating. */
  onOpenTrace: (runId: string) => void;
}) {
  // A listed site's run is its report's (`latest_run_id` is only set while under review).
  const runId = asset.latest_report?.run_id ?? asset.latest_run_id ?? null;
  const facts = asset.latest_report ? reportFacts(asset.latest_report) : null;
  const outcome = listingOutcome(asset);
  const staged = reveal && facts !== null && outcome.kind === "listed";
  const reduced = usePrefersReducedMotion();
  const animate = staged && !reduced;
  // The next step as the Steward home computes it (#216): verify first when the opening offer
  // waits for it, never a locked door. Only once the summary has caught up with this status.
  const summary = useCommunitySummary(community.id);
  const listing = summary.data?.listings.find(
    (l) => l.asset.id === asset.id && l.asset.status === asset.status,
  );
  const next = listing
    ? listingAction(listing.next_action, asset.id, community.id, asset.status, {
        owner: community.role === "owner",
        verification: listing.verification,
      })
    : null;
  // Announced once, after the live region is in the page; later refetches don't repeat it.
  const [announcement, setAnnouncement] = useState("");
  const [toAnnounce] = useState(() =>
    staged && facts ? revealAnnouncement(asset.name, facts) : "",
  );
  useEffect(() => {
    if (!toAnnounce) return;
    const timer = setTimeout(() => setAnnouncement(toAnnounce), 100);
    return () => clearTimeout(timer);
  }, [toAnnounce]);
  return (
    <StepCard className="relative overflow-hidden">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {facts
              ? `Ecological Performance Report · v${facts.version}`
              : "Listing"}
            {asset.mock && <MockBadge />}
          </p>
          <h2 className="mt-1 font-serif text-4xl leading-tight">
            {outcome.kind === "listed"
              ? `${asset.name} is listed`
              : `${asset.name}: ${outcome.title.toLowerCase()}`}
          </h2>
          {facts && (
            <p className="mt-1 text-sm text-muted-foreground">
              {GRADE_LABEL[facts.grade]}
            </p>
          )}
          {listing && outcome.kind === "listed" && (
            <VerificationBadge
              level={listing.verification.level}
              className="mt-3"
            >
              {verificationChip(listing.verification)}
            </VerificationBadge>
          )}
        </div>
        {facts && (
          <GradeStamp
            grade={facts.grade}
            animate={animate}
            delay={REVEAL_AT.stamp}
          />
        )}
      </div>
      {facts && (
        <div className="mt-6 flex flex-wrap items-center gap-6">
          <HealthRing
            value={facts.health}
            size={150}
            animateFrom={staged ? 0 : undefined}
            delay={REVEAL_AT.dial}
          />
          {facts.valueLow !== null &&
            facts.valueMid !== null &&
            facts.valueHigh !== null && (
              <ValueRange
                low={facts.valueLow}
                mid={facts.valueMid}
                high={facts.valueHigh}
                confidence={facts.confidence}
                revealDelay={animate ? REVEAL_AT.range : undefined}
                className="min-w-0 flex-1"
              />
            )}
        </div>
      )}
      <p className="mt-6 max-w-prose text-muted-foreground">
        {outcome.message}
      </p>
      {asset.mock && (
        <p className="mt-2 max-w-prose text-xs text-muted-foreground">
          Mock data: this rating used placeholder metrics because live satellite
          data isn&apos;t connected here. Don&apos;t read it as an observation
          of the land.
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        {outcome.kind === "listed" && !asset.trading && (
          <NextStep
            next={next}
            pending={
              !listing &&
              !summary.error &&
              (!summary.data || summary.isFetching)
            }
            fallbackHref={ipoHref(asset.id, community.id)}
          />
        )}
        <Button asChild variant="outline">
          <Link href={assetHref(asset.id)}>
            {asset.ipo_at ? "See the public page" : "Preview the site page"}
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href={stewardHomeHref(community.id)}>Community home</Link>
        </Button>
        {runId && (
          <Button variant="ghost" onClick={() => onOpenTrace(runId)}>
            <Bot aria-hidden="true" />
            See every step in the Agent Trace
          </Button>
        )}
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Sandbox: play money, not a real security. Supporters get a stake in the
        rating&apos;s sandbox market, never the land.
      </p>
    </StepCard>
  );
}

/**
 * The listing's next step: the Steward home's (verify first while the opening offer waits for
 * it), a placeholder while that loads, else the way to the opening offer, which explains
 * whatever still blocks it.
 */
function NextStep({
  next,
  pending,
  fallbackHref,
}: {
  next: ListingAction | null;
  pending: boolean;
  fallbackHref: string;
}) {
  if (!next && pending) {
    return <Skeleton aria-hidden="true" className="h-12 w-56 rounded-full" />;
  }
  if (!next) {
    return (
      <Button asChild size="lg">
        <Link href={fallbackHref}>
          Set up the opening offer
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    );
  }
  return (
    <>
      {next.href ? (
        <Button
          asChild
          size="lg"
          variant={next.primary ? "default" : "outline"}
        >
          <Link href={next.href}>
            {next.label}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      ) : (
        <p className="self-center text-sm text-muted-foreground">
          {next.label}
        </p>
      )}
      {next.secondary && (
        <Button asChild size="lg" variant="outline">
          <Link href={next.secondary.href}>{next.secondary.label}</Link>
        </Button>
      )}
    </>
  );
}
