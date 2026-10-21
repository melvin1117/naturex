"use client";

import { Camera, RefreshCwIcon, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { GradeBadge } from "@/components/proto/grade";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { ApiError } from "@/lib/api/errors";
import type { AssetDetail, MyCommunity, RatingRun } from "@/lib/api/types";
import {
  useLeaveReview,
  useLiveEvent,
  useRatingRun,
  useRefreshListing,
  useSubmitListing,
} from "@/lib/hooks";
import {
  listingFailure,
  listingHref,
  listingOutcome,
  pipelineView,
  type ListingFailure,
  type PipelineView,
} from "@/lib/listing";
import { evidenceHref } from "@/lib/field-evidence";
import { focusIfLost, useRestoreFocusAfterPending } from "@/lib/focus";
import {
  finishedSteps,
  isActive,
  pacedView,
  PIPELINE_SETTLE_MS,
  PIPELINE_STEP_MS,
} from "@/lib/listing/pacing";
import { usePacedCount, usePrefersReducedMotion } from "@/lib/motion";
import { ha } from "@/lib/prototype/format";
import { num, reportFacts } from "@/lib/report-facts";

import { RatingProgress } from "./rating-progress";
import { FailureAlert, MockBadge, StepCard } from "./shared";

const ACTIVE = new Set<RatingRun["status"]>(["queued", "running"]);
/** While a listing waits for its run, re-read it this often even without events. */
const LISTING_POLL_MS = 10_000;

/**
 * The listing's rating run: the one just submitted, else the listing's `latest_run_id`. Live
 * events only trigger refetches (`GET /runs/{id}` rebuilds the steps), so duplicates, replays
 * and their order can't corrupt the pipeline. The listing is re-read when its run ends, when
 * an event shows another run of it, and every 10 s while it waits, so a run that finishes or
 * dies without a `listing_status` event reaching this tab never leaves it "in progress".
 */
function useListingRun(
  asset: AssetDetail,
  submittedRunId: string | null,
  forgetSubmitted: () => void,
) {
  const refresh = useRefreshListing();
  // A draft (a revised listing too) waits for its next run: it shows no earlier one.
  const runId =
    submittedRunId ??
    (asset.status === "draft" ? null : (asset.latest_run_id ?? null));
  const run = useRatingRun(runId);
  const watching = asset.status !== "draft" || submittedRunId !== null;

  useLiveEvent(
    "rating_progress",
    ({ payload }) => {
      if (payload.asset_id !== asset.id || payload.run_id === runId) return;
      forgetSubmitted();
      refresh(asset.id);
    },
    { enabled: watching },
  );

  const phase = run.data?.status;
  const previous = useRef(phase);
  useEffect(() => {
    const was = previous.current;
    previous.current = phase;
    if (was && ACTIVE.has(was) && phase && !ACTIVE.has(phase))
      refresh(asset.id);
  }, [phase, asset.id, refresh]);

  const waiting = asset.status === "rating" && !asset.status_reason;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => refresh(asset.id), LISTING_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, asset.id, refresh]);

  return {
    runId,
    view: runId ? pipelineView(run.data) : null,
    loaded: run.data !== undefined,
  };
}

/** Below Tailwind's `lg`, where the pipeline stacks with the step card. */
const STACKED = "(max-width: 1023.98px)";

/**
 * The run as the screen shows it (#216). A run this tab watched (submitted here, or found still
 * going) replays its finished steps one at a time; a run that had already ended shows as it is.
 * `holding` lasts from the first sight of a watched run until its last step has shown and
 * settled, so the listed step doesn't cut it short. Reduced motion: no pacing, no hold.
 */
function usePacedRun(
  runId: string | null,
  view: PipelineView | null,
  loaded: boolean,
  submitted: boolean,
) {
  const reduced = usePrefersReducedMotion();
  const [watched, setWatched] = useState<{
    runId: string;
    live: boolean;
  } | null>(null);
  // Decided on the run's first read; used in this very render, so a run that is already
  // finished when first read (a fast mock run) still replays from its first step.
  let decided = watched?.runId === runId ? watched : null;
  if (runId && view && loaded && !decided) {
    decided = { runId, live: submitted || isActive(view) };
    setWatched(decided);
  }
  const live = decided?.live ?? false;
  const target = view ? finishedSteps(view) : 0;
  const shown = usePacedCount(target, PIPELINE_STEP_MS, live);
  const ended = view !== null && !isActive(view) && shown >= target;
  const [released, setReleased] = useState<string | null>(null);
  useEffect(() => {
    if (!live || !ended || !runId || reduced) return;
    const timer = setTimeout(() => setReleased(runId), PIPELINE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [live, ended, runId, reduced]);
  return {
    view: view && live ? pacedView(view, shown) : view,
    live,
    holding: live && !reduced && released !== runId,
  };
}

export function RatingStep({
  community,
  asset,
  onEdit,
  onRevised,
  onWatch,
}: {
  community: MyCommunity;
  asset: AssetDetail;
  onEdit: (step: 0 | 1) => void;
  onRevised: (asset: AssetDetail) => void;
  /**
   * Called while this step follows a run live: `holding` asks the screen to keep this step up
   * until the paced pipeline has caught up (false again on unmount). Must be stable.
   */
  onWatch?: (holding: boolean) => void;
}) {
  const submit = useSubmitListing();
  const refresh = useRefreshListing();
  const reduced = usePrefersReducedMotion();
  const [submittedRunId, setSubmittedRunId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ListingFailure | null>(null);
  const run = useListingRun(asset, submittedRunId, () =>
    setSubmittedRunId(null),
  );
  const { view, live, holding } = usePacedRun(
    run.runId,
    run.view,
    run.loaded,
    submittedRunId !== null,
  );
  useEffect(() => {
    if (!live) return;
    onWatch?.(holding);
    return () => onWatch?.(false);
  }, [live, holding, onWatch]);
  // While the pipeline catches up, the card still reads as rating: the outcome lands after
  // the last step, not before it.
  const shownAsset: AssetDetail =
    holding && asset.status !== "rating"
      ? { ...asset, status: "rating", status_reason: null }
      : asset;
  const outcome = listingOutcome(shownAsset);
  const draft = asset.status === "draft";
  const pipelineRef = useRef<HTMLElement>(null);
  const pipelineFirst = view !== null && (holding || isActive(view));
  // "Rate this site" disables while it submits. If the listing leaves draft, the run replaces
  // the button: focus its card's title. If the submit fails, focus returns to the button.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const rateRef = useRef<HTMLButtonElement>(null);
  const busy = submit.isPending || submittedRunId !== null;
  useRestoreFocusAfterPending(draft && busy, rateRef);
  const wasDraft = useRef(draft);
  useEffect(() => {
    if (wasDraft.current && !draft) focusIfLost(titleRef.current);
    wasDraft.current = draft;
  }, [draft]);
  // Stacked (phones, tablets), a run this person started leads the step: bring it into view.
  const scrollToRun = useRef(false);
  useEffect(() => {
    if (!scrollToRun.current || draft || !pipelineFirst) return;
    scrollToRun.current = false;
    if (window.matchMedia?.(STACKED).matches)
      pipelineRef.current?.scrollIntoView({
        block: "start",
        behavior: reduced ? "auto" : "smooth",
      });
  }, [draft, pipelineFirst, reduced]);

  async function rate() {
    setFailure(null);
    try {
      const accepted = await submit.mutateAsync(asset.id);
      scrollToRun.current = true;
      setSubmittedRunId(accepted.run_id);
    } catch (error) {
      const apiError = error as ApiError;
      // Another run is already going (a teammate, or another tab): follow that one.
      if (apiError.code === "run_in_progress") {
        setSubmittedRunId(null);
        refresh(asset.id);
      }
      setFailure(listingFailure(apiError));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <StepCard aria-labelledby="listing-state-title">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            ref={titleRef}
            id="listing-state-title"
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
          >
            {draft ? "Ready to rate" : outcome.title}
          </h2>
          {asset.mock && <MockBadge />}
        </div>
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div className="rounded-2xl bg-secondary p-4">
            <dt className="text-xs text-muted-foreground">Community</dt>
            <dd className="font-medium">{community.name}</dd>
          </div>
          <div className="rounded-2xl bg-secondary p-4">
            <dt className="text-xs text-muted-foreground">Area</dt>
            <dd className="tabular font-medium">
              {ha(num(asset.area_ha) ?? 0)}
            </dd>
          </div>
        </dl>
        {draft ? (
          <>
            <p className="mt-5 text-sm text-muted-foreground">
              The rating reads five years of satellite data, values what the
              land does, checks local news, and has an AI auditor cross-check it
              all. Every number comes from a tested formula; the AI explains and
              audits.
            </p>
            {failure && (
              <FailureAlert
                failure={failure}
                community={community}
                className="mt-5"
              />
            )}
            <div className="mt-6 flex flex-wrap justify-between gap-2">
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => onEdit(0)}>
                  Edit details
                </Button>
                <Button variant="ghost" onClick={() => onEdit(1)}>
                  Edit boundary
                </Button>
              </div>
              <Button
                ref={rateRef}
                size="lg"
                onClick={() => void rate()}
                disabled={submit.isPending || submittedRunId !== null}
              >
                <Sparkles aria-hidden="true" />
                {submit.isPending ? "Submitting…" : "Rate this site"}
              </Button>
            </div>
            <WithdrawAction asset={asset} community={community} />
          </>
        ) : (
          <Outcome
            asset={shownAsset}
            community={community}
            onRetry={() => void rate()}
            retrying={submit.isPending}
            failure={failure}
            onRevised={onRevised}
          />
        )}
      </StepCard>
      <RatingProgress
        ref={pipelineRef}
        view={view}
        className={cn(pipelineFirst && "order-first lg:order-none")}
      />
    </div>
  );
}

function Outcome({
  asset,
  community,
  onRetry,
  retrying,
  failure,
  onRevised,
}: {
  asset: AssetDetail;
  community: MyCommunity;
  onRetry: () => void;
  retrying: boolean;
  failure: ListingFailure | null;
  onRevised: (asset: AssetDetail) => void;
}) {
  const outcome = listingOutcome(asset);
  const revise = useLeaveReview("revise");
  const [reviseFailure, setReviseFailure] = useState<ListingFailure | null>(
    null,
  );
  const facts = asset.latest_report ? reportFacts(asset.latest_report) : null;
  const shown = reviseFailure ?? failure;

  async function backToDraft() {
    setReviseFailure(null);
    try {
      onRevised(await revise.mutateAsync(asset.id));
    } catch (error) {
      setReviseFailure(listingFailure(error as ApiError));
    }
  }

  return (
    <div className="mt-5 space-y-4">
      <p
        className={cn(
          "text-sm",
          outcome.kind === "ineligible"
            ? "text-clay-ink"
            : "text-muted-foreground",
        )}
      >
        {outcome.message}
      </p>
      {outcome.kind === "rating" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" role="presentation" />
          Watching the agents work…
        </p>
      )}
      {facts &&
        (outcome.kind === "needs_evidence" ||
          outcome.kind === "ineligible") && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-secondary p-4 text-sm">
            <GradeBadge grade={facts.grade} health={facts.health} showLabel />
            <span className="tabular text-muted-foreground">
              {facts.confidence.toFixed(0)}% confidence
            </span>
          </div>
        )}
      {shown && <FailureAlert failure={shown} community={community} />}
      <div className="flex flex-wrap gap-2">
        {outcome.canRetry && (
          <Button onClick={onRetry} disabled={retrying}>
            <RefreshCwIcon aria-hidden="true" />
            {retrying ? "Submitting…" : "Try the rating again"}
          </Button>
        )}
        {outcome.kind === "needs_evidence" && (
          <Button asChild>
            <Link href={evidenceHref(asset.id, community.id)}>
              <Camera aria-hidden="true" />
              Add field photos
            </Link>
          </Button>
        )}
        {outcome.canRevise && (
          <Button
            variant="outline"
            onClick={() => void backToDraft()}
            disabled={revise.isPending}
          >
            {revise.isPending ? "Reopening…" : "Revise the listing"}
          </Button>
        )}
        {(outcome.kind === "ineligible" || outcome.kind === "withdrawn") && (
          <Button asChild variant="outline">
            <Link href={listingHref(community.id)}>Start a new listing</Link>
          </Button>
        )}
      </div>
      {outcome.canWithdraw && (
        <WithdrawAction asset={asset} community={community} />
      )}
    </div>
  );
}

function WithdrawAction({
  asset,
  community,
}: {
  asset: AssetDetail;
  community: MyCommunity;
}) {
  const withdraw = useLeaveReview("withdraw");
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<ListingFailure | null>(null);

  async function confirm() {
    setFailure(null);
    try {
      await withdraw.mutateAsync(asset.id);
      setOpen(false);
    } catch (error) {
      setFailure(listingFailure(error as ApiError));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="link" size="sm" className="mt-4 h-auto px-0">
          Withdraw this listing
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw {asset.name}?</DialogTitle>
          <DialogDescription>
            Withdrawing is final. The land and your community&apos;s listing
            slot become free for a new listing.
          </DialogDescription>
        </DialogHeader>
        {failure && <FailureAlert failure={failure} community={community} />}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Keep it</Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => void confirm()}
            disabled={withdraw.isPending}
          >
            {withdraw.isPending ? "Withdrawing…" : "Withdraw"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
