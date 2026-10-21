"use client";

import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { IpoConfirmLaunch } from "@/components/ipo-confirm-launch";
import {
  BlockedAlert,
  ErrorAlert,
  IpoCard,
  IpoLoading,
  IpoShell,
  OpeningChecklist,
} from "@/components/ipo-layout";
import { IpoOfferInputs } from "@/components/ipo-offer-inputs";
import { IpoLaunched, IpoOutcome } from "@/components/ipo-outcome";
import { IpoPriceSteps } from "@/components/ipo-preview";
import { ScreenSkeleton } from "@/components/page-skeletons";
import { useOptionalStewardCommunity } from "@/components/shell/steward-community";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toApiError, type ApiError } from "@/lib/api/errors";
import type { IpoPreview } from "@/lib/api/types";
import { isApiAssetId } from "@/lib/asset-detail";
import { openingChecklist } from "@/lib/community";
import { useCommunitySummary } from "@/lib/community-hooks";
import { useAsset, useLaunchIpo } from "@/lib/hooks";
import {
  blockedExplanation,
  ipoRefusal,
  isPageRefusal,
  needsVerification,
  PRICE_CHANGED,
  SANDBOX_NOTE,
  type PageRefusal,
} from "@/lib/ipo";
import { evidenceHref } from "@/lib/field-evidence";
import { verifyHref } from "@/lib/listing/links";
import { GRADE_LABEL, int } from "@/lib/prototype/format";
import { reportFacts } from "@/lib/report-facts";
import { unitPriceText } from "@/lib/trade";
import { useIpoOffer } from "@/lib/use-ipo-offer";

function pageRefusal(error: ApiError | null): PageRefusal | null {
  if (!error) return null;
  const refusal = ipoRefusal(error);
  return isPageRefusal(refusal) ? refusal : null;
}

/**
 * The opening offer (IPO) launch screen (T64, story A7): the owner picks the units to issue
 * and the % the community keeps, reads the backend's price formula step by step, and launches
 * at the previewed price. Every number comes from the API; the backend authorizes the launch.
 * The steps before it come first (#216): while verification blocks the launch, the checklist
 * at the top says so and links to it, and the offer is a preview.
 */
export function IpoLaunchScreen({ assetId }: { assetId: string }) {
  const validId = isApiAssetId(assetId);
  const asset = useAsset(validId ? assetId : undefined);
  const launch = useLaunchIpo(assetId);
  const steward = useOptionalStewardCommunity();
  const communityId = steward?.active?.id ?? null;
  const homeHref = steward ? steward.href("/steward") : "/steward";
  // Where verification stands, from the Steward home's summary (cached when coming from it).
  const summary = useCommunitySummary(communityId ?? undefined);
  const listing =
    summary.data?.listings.find((l) => l.asset.id === assetId) ?? null;
  const verifyLink = verifyHref(assetId, steward?.active?.id ?? null);
  const verifyAction = (code: string | null | undefined) =>
    needsVerification(code) ? (
      <Button asChild size="sm">
        <Link href={verifyLink}>
          <ShieldCheck aria-hidden="true" />
          Verify this listing
        </Link>
      </Button>
    ) : undefined;

  // A refused launch is about the offer as it was: editing it clears the refusal.
  const resetLaunch = launch.reset;
  const hasLaunchError = launch.error !== null;
  // Always asked, even for a launched or unlisted site: the backend's answer (403 before 409)
  // decides what the page says, so a steward learns the launch is the owner's.
  const offer = useIpoOffer(validId ? assetId : undefined, {
    enabled: !launch.data,
    launching: launch.isPending,
    onEdit: () => {
      if (hasLaunchError) resetLaunch();
    },
  });
  const { preview, shown, current } = offer;

  // The preview a refusal answered; a newer one (a refetch, a live update) supersedes it.
  const [refusedAgainst, setRefusedAgainst] = useState<
    IpoPreview | undefined
  >();
  const latestPreview = useRef(preview.data);
  useEffect(() => {
    latestPreview.current = preview.data;
  });
  const inFlight = useRef(false);
  const [focusRefusal, setFocusRefusal] = useState(false);
  const refusalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusRefusal) return;
    refusalRef.current?.focus();
    setFocusRefusal(false);
  }, [focusRefusal]);

  const name = asset.data?.name ?? "This site";

  if (launch.data) {
    return (
      <IpoLaunched
        assetId={assetId}
        name={name}
        ipo={launch.data}
        homeHref={homeHref}
      />
    );
  }

  const launchPage = pageRefusal(launch.error);
  const page: PageRefusal | null = !validId
    ? { kind: "not_found" }
    : (launchPage ??
      pageRefusal(preview.error) ??
      (asset.error?.status === 404 ? { kind: "not_found" } : null));

  if (page) {
    return (
      <IpoOutcome
        kind={page.kind}
        asset={asset.data}
        assetId={assetId}
        homeHref={homeHref}
        focus={launchPage !== null}
      />
    );
  }

  if (asset.error) {
    return (
      <IpoShell homeHref={homeHref}>
        <ErrorAlert
          title="We couldn't load this site"
          message={asset.error.message}
          onRetry={() => void asset.refetch()}
        />
      </IpoShell>
    );
  }

  // Until the first preview answers, the page doesn't know whether this account may launch.
  const firstPreview =
    !shown && (preview.status === "idle" || preview.status === "loading");
  if (!asset.data || firstPreview) {
    return <ScreenSkeleton label="Checking this site…" />;
  }

  const previewRefusal = preview.error ? ipoRefusal(preview.error) : null;
  const launchRefusal = launch.error ? ipoRefusal(launch.error) : null;
  const supersededRefusal = preview.data !== refusedAgainst;
  // A blocked or failed launch stays until a newer preview answers (or the offer changes).
  const launchBlocked =
    launchRefusal?.kind === "blocked" &&
    !supersededRefusal &&
    current?.blocked_reason !== launchRefusal.code
      ? launchRefusal
      : null;
  const launchFailed =
    launchRefusal?.kind === "error" && !supersededRefusal
      ? launchRefusal
      : null;

  const facts = asset.data.latest_report
    ? reportFacts(asset.data.latest_report)
    : null;
  const blockedReason =
    current?.blocked_reason ??
    (previewRefusal?.kind === "blocked" ? previewRefusal.code : null);
  // Verification is the blocker: the checklist above says so, and the offer is a preview.
  const awaitingVerification =
    listing?.verification.required ?? needsVerification(blockedReason);
  const steps = openingChecklist({
    assetId,
    communityId,
    rating: facts
      ? `Grade ${facts.grade} · ${facts.health.toFixed(1)} · ${GRADE_LABEL[facts.grade]}`
      : null,
    verification: listing?.verification ?? null,
    launchable: current?.launchable,
    blockedReason,
  });

  const confirm = async (snapshot: IpoPreview) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await launch.mutateAsync({
        total_shares: snapshot.total_shares,
        retained_pct: snapshot.retained_pct,
        expected_price: snapshot.ipo_price,
      });
    } catch (error) {
      setRefusedAgainst(latestPreview.current);
      setFocusRefusal(true);
      // A newer report moved the price: show it, for the owner to confirm again.
      if (ipoRefusal(toApiError(error)).kind === "price_changed") {
        void preview.refetch();
      }
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <IpoShell homeHref={homeHref}>
      <header>
        <p className="text-sm text-muted-foreground">Opening offer</p>
        <h1 className="mt-1 font-serif text-4xl leading-tight tracking-tight sm:text-5xl">
          {asset.data.name}
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Choose how many units to issue and how much of the stake your
          community keeps. The rest opens to supporters at the fair price from
          the latest rating; what they pay goes to your community fund.
        </p>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Geotagged field photos of the land can raise the next rating&apos;s
          confidence, which sets part of this price.{" "}
          <Link
            href={evidenceHref(assetId, steward?.active?.id ?? null)}
            className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
          >
            Add field photos
          </Link>
        </p>
      </header>
      <OpeningChecklist steps={steps} className="mt-8" />
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <IpoCard aria-labelledby="offer-heading">
          <h2 id="offer-heading" className="text-lg font-semibold">
            Your offer
          </h2>
          <IpoOfferInputs offer={offer} disabled={launch.isPending} />
        </IpoCard>
        <IpoCard aria-labelledby="price-heading">
          <h2
            id="price-heading"
            className="flex flex-wrap items-center gap-2 text-lg font-semibold"
          >
            Opening price{" "}
            {awaitingVerification && (
              <Badge variant="secondary" className="font-medium">
                Preview
              </Badge>
            )}
          </h2>
          <p role="status" className="sr-only">
            {current
              ? `Opening price ${unitPriceText(current.ipo_price)} per unit, ${int(current.shares_offered)} units offered.`
              : ""}
          </p>
          <div className="mt-4" aria-busy={preview.isFetching}>
            {previewRefusal?.kind === "blocked" ? (
              <BlockedAlert
                explanation={previewRefusal.explanation}
                action={verifyAction(previewRefusal.code)}
                onRetry={() => void preview.refetch()}
              />
            ) : previewRefusal?.kind === "error" ? (
              <ErrorAlert
                title="We couldn't price this offer"
                message={previewRefusal.message}
                onRetry={() => void preview.refetch()}
              />
            ) : offer.totalShares === null || offer.retainedPct === null ? (
              <p className="text-sm text-muted-foreground">
                Enter a valid offer to see its price.
              </p>
            ) : shown ? (
              <>
                {!current && (
                  <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner aria-hidden="true" role="presentation" />
                    Updating the preview…
                  </p>
                )}
                <IpoPriceSteps
                  preview={shown}
                  className={cn(!current && "opacity-50 transition-opacity")}
                />
              </>
            ) : (
              <IpoLoading>Pricing your offer…</IpoLoading>
            )}
          </div>
          {current &&
            !current.launchable &&
            current.blocked_reason &&
            !needsVerification(current.blocked_reason) && (
              <BlockedAlert
                className="mt-4"
                explanation={blockedExplanation(current.blocked_reason)}
                action={verifyAction(current.blocked_reason)}
                onRetry={() => void preview.refetch()}
              />
            )}
          {launchRefusal?.kind === "price_changed" && (
            <BlockedAlert
              ref={refusalRef}
              className="mt-4"
              explanation={PRICE_CHANGED}
            />
          )}
          {launchBlocked && (
            <BlockedAlert
              ref={refusalRef}
              className="mt-4"
              explanation={launchBlocked.explanation}
              action={verifyAction(launchBlocked.code)}
              onRetry={() => void preview.refetch()}
            />
          )}
          {launchFailed && (
            <ErrorAlert
              ref={refusalRef}
              className="mt-4"
              title="The opening offer didn't launch"
              message={launchFailed.message}
            />
          )}
          <IpoConfirmLaunch
            name={asset.data.name}
            offer={current}
            disabled={!offer.canLaunch || launchBlocked !== null}
            pending={launch.isPending}
            onConfirm={(snapshot) => void confirm(snapshot)}
          />
          {awaitingVerification && !launchBlocked && (
            <p className="mt-3 text-sm text-muted-foreground">
              You can open it once the land documents are verified (step 2
              above).
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{SANDBOX_NOTE}</p>
        </IpoCard>
      </div>
    </IpoShell>
  );
}
