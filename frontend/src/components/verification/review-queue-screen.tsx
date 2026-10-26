"use client";

import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "@/components/app-link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { QueueRowsSkeleton } from "@/components/page-skeletons";
import { LoadError } from "@/components/proto/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CheckResultLabel,
  VerificationBadge,
} from "@/components/verification/parts";
import { OfferList } from "@/components/verification/offer-list";
import { ReviewQueueHeading } from "@/components/verification/review-queue-heading";
import type {
  CheckResult,
  DecidedListingItem,
  ReviewQueueItem,
} from "@/lib/api/types";
import type { ApiError } from "@/lib/api/errors";
import { STATUS_LABEL } from "@/lib/community";
import { date } from "@/lib/format";
import { useReplaceUrl } from "@/lib/nav";
import {
  adminReviewHref,
  checkCounts,
  DOC_TYPE_LABEL,
  LEVEL_LABEL,
  reviewerLabel,
  reviewView,
  reviewViewHref,
  REVIEW_VIEWS,
  type ReviewView,
} from "@/lib/verification";
import {
  useDecidedVerifications,
  useReviewQueue,
  type DecidedLevel,
} from "@/lib/verification-hooks";

export const QUEUE_PAGE = 20;

const VIEW_LABEL: Record<ReviewView, string> = {
  offers: "Offers",
  waiting: "Documents",
  verified: "Verified",
  rejected: "Rejected",
  revoked: "Revoked",
};

/**
 * The admin verification area (T70, #211; ADR-0006 §3): listings waiting for a decision, oldest
 * first, and listings already decided (verified, rejected, revoked), latest decision first, a
 * page at a time. The backend leaves out the admin's own communities.
 */
export function ReviewQueueScreen() {
  // The address is the state: Back and Forward, a reload and a shared link all land on the
  // view in it. Next.js keeps useSearchParams in step with history.replaceState.
  const view = reviewView(useSearchParams().get("view"));
  const replaceUrl = useReplaceUrl();

  return (
    <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <ReviewQueueHeading />

      <Tabs
        value={view}
        // The History API keeps the address shareable without a server round trip.
        onValueChange={(v) => replaceUrl(reviewViewHref(reviewView(v)))}
        className="mt-8 gap-6"
      >
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList
            aria-label="What to review"
            className="w-max min-w-full bg-card shadow-soft sm:w-fit sm:min-w-0"
          >
            {REVIEW_VIEWS.map((v) => (
              <TabsTrigger
                key={v}
                value={v}
                className="px-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground sm:px-4"
              >
                {VIEW_LABEL[v]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="offers">
          {view === "offers" && <OfferList />}
        </TabsContent>
        <TabsContent value="waiting">
          {view === "waiting" && <WaitingList />}
        </TabsContent>
        {(["verified", "rejected", "revoked"] as const).map((level) => (
          <TabsContent key={level} value={level}>
            {view === level && <DecidedList level={level} />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function WaitingList() {
  const [offset, setOffset] = useState(0);
  const queue = useReviewQueue(offset, QUEUE_PAGE);
  return (
    <Paged
      label="Listings waiting for review"
      view="Waiting"
      items={queue.data}
      error={queue.error}
      retry={queue.refetch}
      fetching={queue.isFetching}
      offset={offset}
      setOffset={setOffset}
      empty="Nothing is waiting for review."
      loading="Loading the queue…"
      errorTitle="We couldn't load the queue"
      row={(item) => <QueueRow key={item.asset_id} item={item} />}
    />
  );
}

const DECIDED_EMPTY: Record<DecidedLevel, string> = {
  verified: "No listing is verified yet.",
  rejected: "No listing has been rejected.",
  revoked: "No verification has been revoked.",
};

function DecidedList({ level }: { level: DecidedLevel }) {
  const [offset, setOffset] = useState(0);
  const decided = useDecidedVerifications(level, offset, QUEUE_PAGE);
  const label = VIEW_LABEL[level].toLowerCase();
  return (
    <Paged
      label={`Listings ${label}, latest decision first`}
      view={LEVEL_LABEL[level]}
      items={decided.data}
      error={decided.error}
      retry={decided.refetch}
      fetching={decided.isFetching}
      offset={offset}
      setOffset={setOffset}
      empty={DECIDED_EMPTY[level]}
      loading={`Loading ${label} listings…`}
      errorTitle={`We couldn't load the ${label} listings`}
      row={(item) => <DecidedRow key={item.asset_id} item={item} />}
    />
  );
}

function Paged<T>({
  label,
  view,
  items,
  error,
  retry,
  fetching,
  offset,
  setOffset,
  empty,
  loading,
  errorTitle,
  row,
}: {
  label: string;
  /** The view's name, for its page navigation. */
  view: string;
  items: T[] | undefined;
  error: ApiError | null;
  retry: () => Promise<void>;
  fetching: boolean;
  offset: number;
  setOffset: (offset: number) => void;
  empty: string;
  loading: string;
  errorTitle: string;
  row: (item: T) => React.ReactNode;
}) {
  return (
    <>
      <div aria-busy={fetching}>
        {items ? (
          items.length === 0 ? (
            <p className="rounded-3xl bg-card p-8 text-center text-muted-foreground shadow-soft">
              {offset === 0 ? empty : "No more listings on this page."}
            </p>
          ) : (
            <ul className="space-y-3" aria-label={label}>
              {items.map(row)}
            </ul>
          )
        ) : error ? (
          <LoadError title={errorTitle} error={error} retry={retry} />
        ) : (
          <QueueRowsSkeleton label={loading} />
        )}
      </div>

      {(offset > 0 || (items?.length ?? 0) === QUEUE_PAGE) && (
        <nav
          aria-label={`${view} pages`}
          className="mt-6 flex items-center justify-between gap-3"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - QUEUE_PAGE))}
          >
            <ChevronLeft aria-hidden="true" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={(items?.length ?? 0) < QUEUE_PAGE}
            onClick={() => setOffset(offset + QUEUE_PAGE)}
          >
            Next
            <ChevronRight aria-hidden="true" />
          </Button>
        </nav>
      )}
    </>
  );
}

const RESULTS: CheckResult[] = ["fail", "warn", "pass"];

function QueueRow({ item }: { item: ReviewQueueItem }) {
  const { run } = item;
  const counts = checkCounts(run.checklist);
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-card p-5 shadow-soft">
      <div className="min-w-0 space-y-2">
        <h2 className="font-serif text-2xl leading-tight break-words">
          {item.asset_name}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Submitted {date(run.created_at)}</span>
          <Badge variant="secondary">
            {STATUS_LABEL[item.asset_status] ?? item.asset_status}
          </Badge>
          <Badge variant="outline">
            {run.evidence_kind === "sample"
              ? "Sample documents (demo)"
              : "Real documents"}
          </Badge>
          {!run.fingerprint_matches && (
            <Badge variant="outline">Listing changed since</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {run.documents.map((d) => DOC_TYPE_LABEL[d.doc_type]).join(", ")}
        </p>
        <ul
          className="flex flex-wrap gap-x-4 gap-y-1"
          aria-label="Check results"
        >
          {RESULTS.filter((r) => counts[r] > 0).map((r) => (
            <li key={r} className="flex items-center gap-1 text-sm">
              <span className="tabular">{counts[r]}</span>
              <CheckResultLabel result={r} />
            </li>
          ))}
        </ul>
      </div>
      <Button asChild>
        <Link
          href={adminReviewHref(item.asset_id)}
          aria-label={`Review ${item.asset_name}`}
        >
          Review
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </li>
  );
}

function DecidedRow({ item }: { item: DecidedListingItem }) {
  const { run } = item;
  const reviewer = reviewerLabel(run.reviewer_role);
  const reason = run.revoke_reason ?? run.reason;
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-card p-5 shadow-soft">
      <div className="min-w-0 space-y-2">
        <h2 className="font-serif text-2xl leading-tight break-words">
          {item.asset_name}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <VerificationBadge level={run.level}>
            {LEVEL_LABEL[run.level]}
          </VerificationBadge>
          <span className="tabular">
            {run.level === "revoked" ? "Revoked" : "Decided"}{" "}
            {date(item.last_decision_at)}
          </span>
          {reviewer && <span>by {reviewer}</span>}
          <Badge variant="secondary">
            {STATUS_LABEL[item.asset_status] ?? item.asset_status}
          </Badge>
          {!run.fingerprint_matches && (
            <Badge variant="outline">Listing changed since</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {run.documents.map((d) => DOC_TYPE_LABEL[d.doc_type]).join(", ")}
        </p>
        {reason && (
          <p className="line-clamp-2 max-w-prose text-sm break-words">
            <span className="text-muted-foreground">
              {run.revoke_reason ? "Reason for revoking: " : "Reason: "}
            </span>
            {reason}
          </p>
        )}
      </div>
      <Button asChild variant="outline">
        <Link
          href={adminReviewHref(item.asset_id)}
          aria-label={`Open ${item.asset_name}`}
        >
          Open
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </li>
  );
}
