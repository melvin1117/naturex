"use client";

import { RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { useId, useState } from "react";

import { LoadError } from "@/components/proto/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { UntrustedText } from "@/components/verification/ai-suggestion-fields";
import {
  AiSuggestionResult,
  Provenance,
} from "@/components/verification/ai-suggestion-result";
import type {
  AiSuggestion,
  AiSuggestionStatus,
  ReviewQueueItem,
} from "@/lib/api/types";
import { STATUS_TEXT } from "@/lib/ai-suggestion";
import {
  useRefreshVerification,
  useReviewQueueItem,
} from "@/lib/verification-hooks";

/** The fixed label, used when the API's own notice isn't at hand (no stored suggestion). */
const DEFAULT_NOTICE =
  "Untrusted AI heuristic: AI models read the documents and can be wrong or manipulated by them. It never changes the checks or the verification level; you decide.";

/** What the panel's one live region says when the check stops being pending. */
const LEFT_PENDING: Record<Exclude<AiSuggestionStatus, "pending">, string> = {
  completed: "AI suggestion ready.",
  failed: "AI suggestion didn't finish.",
  not_run: "AI suggestion not run.",
};

/**
 * The status shown: a `completed` item always carries a suggestion (the API stores a
 * `completed` row only with one); should one ever lack it, it's shown as not finished.
 */
function shownStatus(item: ReviewQueueItem): AiSuggestionStatus {
  const status = item.ai_suggestion_status;
  return status === "completed" && !item.ai_suggestion?.suggestion
    ? "failed"
    : status;
}

/**
 * One polite announcement per change: the pending notice, then "ready" or "didn't finish" once
 * it leaves pending (a suggestion already there on arrival isn't announced).
 */
function useAnnouncement(status: AiSuggestionStatus | null): string {
  const [seen, setSeen] = useState<{
    status: AiSuggestionStatus | null;
    message: string;
  }>({ status: null, message: "" });
  if (status !== seen.status) {
    let message = "";
    if (status === "pending") message = `${STATUS_TEXT.pending.title}.`;
    else if (status && seen.status === "pending")
      message = LEFT_PENDING[status];
    setSeen({ status, message });
  }
  return seen.message;
}

/**
 * The AI document check for one submission (T71, ADR-0006 §2): an **untrusted heuristic**,
 * labelled as such with the API's notice, next to the excerpts it read. It's never a check
 * result or a decision, and nothing on this page acts on it.
 */
export function AiSuggestionPanel({
  assetId,
  runId,
  waiting,
}: {
  assetId: string;
  runId: string;
  /** The run waits for a decision: only then is it in the queue, with its suggestion. */
  waiting: boolean;
}) {
  const item = useReviewQueueItem(assetId, { enabled: waiting });
  const current =
    waiting && item.data && item.data.run.id === runId ? item.data : null;
  const announcement = useAnnouncement(current ? shownStatus(current) : null);
  let body: React.ReactNode;
  if (!waiting) {
    body = (
      <p className="text-sm text-muted-foreground">
        Shown while a submission waits for a decision; this one doesn&apos;t.
      </p>
    );
  } else if (item.error && item.data === undefined) {
    body = (
      <LoadError
        title="We couldn't load the AI suggestion"
        error={item.error}
        retry={async () => {
          await item.refetch();
        }}
      />
    );
  } else if (item.data === undefined) {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" role="presentation" />
        Loading the AI suggestion…
      </p>
    );
  } else {
    body = (
      <AiSuggestionBody item={item.data} runId={runId} assetId={assetId} />
    );
  }
  return (
    <AiSuggestionFrame
      notice={current?.ai_suggestion?.notice}
      announcement={announcement}
    >
      {body}
    </AiSuggestionFrame>
  );
}

function AiSuggestionFrame({
  notice,
  announcement,
  children,
}: {
  notice: string | undefined;
  announcement: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="min-w-0 rounded-3xl border border-dashed border-border p-6"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={id} className="flex items-center gap-2 text-base font-semibold">
          <Sparkles className="size-4" aria-hidden="true" />
          AI suggestion
        </h2>
        <Badge variant="outline" className="[&>svg]:size-3.5">
          <ShieldAlert aria-hidden="true" />
          Untrusted heuristic
        </Badge>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {notice ?? DEFAULT_NOTICE}
      </p>
      {/* Mounted in every state, so screen readers hear each change. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function AiSuggestionBody({
  item,
  runId,
  assetId,
}: {
  item: ReviewQueueItem | null;
  runId: string;
  assetId: string;
}) {
  if (item === null)
    return (
      <p className="text-sm text-muted-foreground">
        Not available: the AI suggestion is shown while this submission waits in
        your review queue.
      </p>
    );
  if (item.run.id !== runId) return <NewerRun assetId={assetId} />;
  const status = shownStatus(item);
  const suggestion = item.ai_suggestion ?? null;
  if (status === "completed" && suggestion)
    return <AiSuggestionResult suggestion={suggestion} />;
  return <AiSuggestionState status={status} suggestion={suggestion} />;
}

/** The queue holds another run than the page: the steward submitted again meanwhile. */
function NewerRun({ assetId }: { assetId: string }) {
  const refresh = useRefreshVerification(assetId);
  return (
    <div className="rounded-2xl bg-secondary/60 p-4 text-sm">
      <p className="font-medium">A newer submission is waiting for review</p>
      <p className="mt-1 text-muted-foreground">
        This page shows an earlier one. Reload to review the newer documents,
        checks and AI suggestion.
      </p>
      <Button variant="outline" size="sm" className="mt-3" onClick={refresh}>
        <RefreshCw aria-hidden="true" />
        Reload the submission
      </Button>
    </div>
  );
}

/** Pending, not run or failed: why there's nothing to read, in words. */
function AiSuggestionState({
  status,
  suggestion,
}: {
  status: AiSuggestionStatus;
  suggestion: AiSuggestion | null;
}) {
  // `shownStatus` never passes `completed` here; the fallback keeps the type total.
  const text = STATUS_TEXT[status === "completed" ? "failed" : status];
  const pending = status === "pending";
  return (
    <div className="rounded-2xl bg-secondary/60 p-4 text-sm">
      <p className="flex items-center gap-2 font-medium">
        {pending && <Spinner aria-hidden="true" role="presentation" />}
        {text.title}
      </p>
      <p className="mt-1 text-muted-foreground">{text.body}</p>
      {suggestion && suggestion.reasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {suggestion.reasons.map((reason, i) => (
            <li key={i}>
              <UntrustedText text={reason} />
            </li>
          ))}
        </ul>
      )}
      {suggestion && <Provenance suggestion={suggestion} />}
    </div>
  );
}
