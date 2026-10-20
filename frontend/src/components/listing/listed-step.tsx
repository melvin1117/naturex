"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { ValueRange } from "@/components/proto/bits";
import { GradeStamp } from "@/components/proto/grade";
import { HealthRing } from "@/components/proto/health-ring";
import { Button } from "@/components/ui/button";
import type { AssetDetail, MyCommunity } from "@/lib/api/types";
import { ipoHref, listingOutcome, stewardHomeHref } from "@/lib/listing";
import { GRADE_LABEL } from "@/lib/prototype/format";
import { reportFacts } from "@/lib/report-facts";
import { assetHref } from "@/lib/trade";

import { MockBadge, StepCard } from "./shared";

/** Step 4: a listed (or suspended) site, and the way to its opening offer (T64). */
export function ListedStep({
  community,
  asset,
}: {
  community: MyCommunity;
  asset: AssetDetail;
}) {
  const facts = asset.latest_report ? reportFacts(asset.latest_report) : null;
  const outcome = listingOutcome(asset);
  return (
    <StepCard className="relative overflow-hidden">
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
        </div>
        {facts && <GradeStamp grade={facts.grade} animate />}
      </div>
      {facts && (
        <div className="mt-6 flex flex-wrap items-center gap-6">
          <HealthRing value={facts.health} size={150} />
          {facts.valueLow !== null &&
            facts.valueMid !== null &&
            facts.valueHigh !== null && (
              <ValueRange
                low={facts.valueLow}
                mid={facts.valueMid}
                high={facts.valueHigh}
                confidence={facts.confidence}
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
          <Button asChild size="lg">
            <Link href={ipoHref(asset.id, community.id)}>
              Set up the opening offer
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href={assetHref(asset.id)}>See the public page</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href={stewardHomeHref(community.id)}>Community home</Link>
        </Button>
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Sandbox: play money, not a real security. Supporters get a stake in the
        rating&apos;s sandbox market, never the land.
      </p>
    </StepCard>
  );
}
