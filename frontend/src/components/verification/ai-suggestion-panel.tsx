"use client";

import { ShieldAlert, Sparkles, TriangleAlert } from "lucide-react";
import { useId } from "react";

import { LoadError } from "@/components/proto/load-error";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Comparisons,
  DocumentReadings,
  UntrustedText,
} from "@/components/verification/ai-suggestion-fields";
import type {
  AiSuggestion,
  AiSuggestionStatus,
  ReviewQueueItem,
} from "@/lib/api/types";
import {
  flagText,
  STATUS_TEXT,
  SUGGESTION_TEXT,
  suggestionTime,
} from "@/lib/ai-suggestion";
import { useReviewQueueItem } from "@/lib/verification-hooks";

/** The fixed label, used when the API's own notice isn't at hand (no stored suggestion). */
const DEFAULT_NOTICE =
  "Untrusted AI heuristic: AI models read the documents and can be wrong or manipulated by them. It never changes the checks or the verification level; you decide.";

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
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Spinner aria-hidden="true" role="presentation" />
        Loading the AI suggestion…
      </p>
    );
  } else {
    body = <AiSuggestionBody item={item.data} runId={runId} />;
  }
  return (
    <AiSuggestionFrame
      notice={waiting ? item.data?.ai_suggestion?.notice : undefined}
    >
      {body}
    </AiSuggestionFrame>
  );
}

function AiSuggestionFrame({
  notice,
  children,
}: {
  notice: string | undefined;
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
      <div className="mt-5">{children}</div>
    </section>
  );
}

function AiSuggestionBody({
  item,
  runId,
}: {
  item: ReviewQueueItem | null;
  runId: string;
}) {
  if (item === null || item.run.id !== runId)
    return (
      <p className="text-sm text-muted-foreground">
        Not available: the AI suggestion is shown while this submission waits in
        your review queue.
      </p>
    );
  const status = item.ai_suggestion_status;
  const suggestion = item.ai_suggestion ?? null;
  if (status === "completed" && suggestion?.suggestion)
    return <AiSuggestionResult suggestion={suggestion} />;
  return <AiSuggestionState status={status} suggestion={suggestion} />;
}

/** Pending, not run or failed: why there's nothing to read, in words. */
export function AiSuggestionState({
  status,
  suggestion,
}: {
  status: AiSuggestionStatus;
  suggestion: AiSuggestion | null;
}) {
  const text = STATUS_TEXT[status === "completed" ? "failed" : status];
  const pending = status === "pending";
  return (
    <div
      role={pending ? "status" : undefined}
      aria-live={pending ? "polite" : undefined}
      className="rounded-2xl bg-secondary/60 p-4 text-sm"
    >
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

/** A completed suggestion: what it suggests and why, its warnings, then its evidence. */
export function AiSuggestionResult({
  suggestion,
}: {
  suggestion: AiSuggestion;
}) {
  const summary = SUGGESTION_TEXT[suggestion.suggestion ?? "unreadable"];
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-secondary/60 p-4">
        <p className="text-xs font-medium text-muted-foreground">
          The AI suggests (not a check result, not a decision)
        </p>
        <p className="mt-1 font-serif text-2xl leading-tight">
          {summary.label}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{summary.body}</p>
      </div>

      <Part title="Why">
        {suggestion.reasons.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {suggestion.reasons.map((reason, i) => (
              <li key={i}>
                <UntrustedText text={reason} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No reason given.</p>
        )}
      </Part>

      {suggestion.flags.length > 0 && (
        <Part title="Warnings">
          <ul aria-label="Warnings" className="space-y-2 text-sm">
            {suggestion.flags.map((flag) => (
              <li key={flag} className="flex items-start gap-2">
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0 text-clay-ink"
                  aria-hidden="true"
                />
                <span>{flagText(flag)}</span>
              </li>
            ))}
          </ul>
        </Part>
      )}

      <Part title="Field by field">
        <Comparisons
          comparisons={suggestion.comparisons}
          documents={suggestion.documents}
        />
      </Part>

      <Part title="What was read from each document">
        <DocumentReadings documents={suggestion.documents} />
      </Part>

      <Provenance suggestion={suggestion} />
    </div>
  );
}

function Part({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="mb-2 text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Provenance({ suggestion }: { suggestion: AiSuggestion }) {
  return (
    <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-[auto_minmax(0,1fr)]">
      <dt>Models</dt>
      <dd translate="no" className="font-mono break-all">
        {suggestion.models.length > 0 ? suggestion.models.join(", ") : "None"}
      </dd>
      <dt>Method</dt>
      <dd translate="no" className="font-mono break-all">
        {suggestion.method_version}
      </dd>
      <dt>Made</dt>
      <dd className="tabular">{suggestionTime(suggestion.created_at)}</dd>
    </dl>
  );
}
