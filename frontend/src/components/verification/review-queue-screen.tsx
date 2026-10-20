"use client";

import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { LoadError } from "@/components/proto/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CheckResultLabel } from "@/components/verification/parts";
import type { CheckResult, ReviewQueueItem } from "@/lib/api/types";
import { STATUS_LABEL } from "@/lib/community";
import { date } from "@/lib/prototype/format";
import {
  adminReviewHref,
  checkCounts,
  DOC_TYPE_LABEL,
} from "@/lib/verification";
import { useReviewQueue } from "@/lib/verification-hooks";

export const QUEUE_PAGE = 20;

/**
 * The admin review queue (T70, ADR-0006 §3): listings whose current run waits for a decision,
 * oldest first, a page at a time. The backend leaves out the admin's own communities.
 */
export function ReviewQueueScreen() {
  const [offset, setOffset] = useState(0);
  const queue = useReviewQueue(offset, QUEUE_PAGE);
  const items = queue.data;

  return (
    <div className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6">
      <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Verification queue
      </h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Listings whose communities submitted land documents, oldest first. Read
        the documents, the automated checks and the map, then approve or reject
        with a reason. Your own communities&apos; listings never appear here.
      </p>

      <div className="mt-8" aria-busy={queue.isFetching}>
        {items ? (
          items.length === 0 ? (
            <p className="rounded-3xl bg-card p-8 text-center text-muted-foreground shadow-soft">
              {offset === 0
                ? "Nothing is waiting for review."
                : "No more listings on this page."}
            </p>
          ) : (
            <ul className="space-y-3" aria-label="Listings waiting for review">
              {items.map((item) => (
                <QueueRow key={item.asset_id} item={item} />
              ))}
            </ul>
          )
        ) : queue.error ? (
          <LoadError
            title="We couldn't load the queue"
            error={queue.error}
            retry={queue.refetch}
          />
        ) : (
          <p
            role="status"
            className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
          >
            <Spinner aria-hidden="true" role="presentation" />
            Loading the queue…
          </p>
        )}
      </div>

      {(offset > 0 || (items?.length ?? 0) === QUEUE_PAGE) && (
        <nav
          aria-label="Queue pages"
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
    </div>
  );
}

const RESULTS: CheckResult[] = ["fail", "warn", "pass"];

function QueueRow({ item }: { item: ReviewQueueItem }) {
  const { run } = item;
  const counts = checkCounts(run.checklist);
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 rounded-3xl bg-card p-5 shadow-soft">
      <div className="min-w-0 space-y-2">
        <p className="font-serif text-2xl leading-tight break-words">
          {item.asset_name}
        </p>
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
