"use client";

import { FileText, Send } from "lucide-react";
import { useId } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import type { ListingDocument } from "@/lib/api/types";
import type { ApiError } from "@/lib/api/errors";
import { date } from "@/lib/prototype/format";
import {
  DOC_TYPE_LABEL,
  documentFacts,
  MAX_RUN_DOCUMENTS,
  submitFailure,
} from "@/lib/verification";

const plural = (n: number) => `${n} document${n === 1 ? "" : "s"}`;

/**
 * The listing's documents. Ones not yet submitted can be picked and submitted for review.
 * While a submission waits for a reviewer (`waiting`: its documents), picking adds to it: the
 * new run keeps those documents unless the steward unticks them (#210), and the list shows
 * exactly what the reviewer will see. At most MAX_RUN_DOCUMENTS in all.
 */
export function DocumentSubmitList({
  documents,
  waiting = null,
  selected,
  removed = [],
  onToggle,
  onToggleKeep,
  onSubmit,
  pending,
  error,
  disabled = false,
  afterRejection = false,
}: {
  documents: ListingDocument[];
  /** The waiting run's documents, or null when no run waits for a decision. */
  waiting?: readonly ListingDocument[] | null;
  selected: readonly string[];
  /** Documents of the waiting run the steward chose to leave out. */
  removed?: readonly string[];
  onToggle: (id: string, on: boolean) => void;
  onToggleKeep?: (id: string, keep: boolean) => void;
  onSubmit: () => void;
  pending: boolean;
  error: ApiError | null;
  disabled?: boolean;
  /** The current submission was rejected: the next one needs new uploads. */
  afterRejection?: boolean;
}) {
  const hintId = useId();
  const open = documents.filter((doc) => !doc.submitted);
  const inWaiting = new Set(waiting?.map((doc) => doc.id));
  const earlier = documents.filter(
    (doc) => doc.submitted && !inWaiting.has(doc.id),
  );
  const kept = (waiting ?? []).filter((doc) => !removed.includes(doc.id));
  const picked = open.filter((doc) => selected.includes(doc.id));
  const total = kept.length + picked.length;
  const full = total >= MAX_RUN_DOCUMENTS;
  const hasConsent = [...kept, ...picked].some(
    (doc) => doc.doc_type === "assembly_minutes",
  );
  const adding = waiting !== null;
  // Something to add is what makes a submission; unticking alone changes nothing.
  const canEdit = open.length > 0;

  if (documents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No documents yet. Upload a land title or agrarian certificate and the
        community assembly&apos;s minutes approving the listing.
      </p>
    );
  }

  const hint =
    total > 0 && !hasConsent
      ? "None of these documents is labelled as assembly minutes, so the consent check will fail."
      : adding
        ? "Adding runs the automated checks again over every document above; the reviewer then decides on all of them together."
        : afterRejection
          ? "Submitting sends these for a new review: the automated checks run at once, then a reviewer decides."
          : "Submitting runs the automated checks at once; a reviewer then decides.";

  return (
    <div className="space-y-5">
      {afterRejection && open.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Your last submission wasn&apos;t approved. Upload new documents above,
          then submit them here for a new review.
        </p>
      )}
      {adding && (
        <section aria-labelledby={`${hintId}-submission`}>
          <h3 id={`${hintId}-submission`} className="text-sm font-medium">
            What the reviewer will see{" "}
            <span className="tabular font-normal text-muted-foreground">
              ({total} of {MAX_RUN_DOCUMENTS})
            </span>
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {canEdit
              ? "Your submission is waiting for a reviewer. Documents you add join it. Untick one to leave it out when you add a document."
              : "Your submission is waiting for a reviewer. To add a document, upload it here first."}
          </p>
          <ul
            className="mt-3 space-y-2"
            aria-label="Documents in your submission"
          >
            {(waiting ?? []).map((doc) => {
              const keep = !removed.includes(doc.id);
              const inputId = `${hintId}-keep-${doc.id}`;
              return (
                <li
                  key={doc.id}
                  className="flex items-start gap-3 rounded-2xl bg-secondary/50 p-3"
                >
                  {canEdit ? (
                    <Checkbox
                      id={inputId}
                      checked={keep}
                      disabled={disabled || pending || (!keep && full)}
                      onCheckedChange={(v) =>
                        onToggleKeep?.(doc.id, v === true)
                      }
                      className="mt-0.5"
                    />
                  ) : (
                    <FileText
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <Label
                    htmlFor={canEdit ? inputId : undefined}
                    className="block font-normal"
                  >
                    <span className="block font-medium">
                      {DOC_TYPE_LABEL[doc.doc_type]}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {documentFacts(doc)} ·{" "}
                      {keep ? "already submitted" : "will be left out"}
                    </span>
                  </Label>
                </li>
              );
            })}
            {picked.map((doc) => (
              <li
                key={doc.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-dashed border-border p-3 text-sm"
              >
                <span className="font-medium">
                  {DOC_TYPE_LABEL[doc.doc_type]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {documentFacts(doc)}
                </span>
                <Badge variant="outline">Adding</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {open.length > 0 && (
        <fieldset aria-describedby={hintId} disabled={disabled || pending}>
          <legend className="text-sm font-medium">
            {adding
              ? "Choose documents to add"
              : `Choose up to ${MAX_RUN_DOCUMENTS} to submit together`}
          </legend>
          <ul className="mt-3 space-y-2">
            {open.map((doc) => {
              const checked = selected.includes(doc.id);
              const inputId = `${hintId}-${doc.id}`;
              return (
                <li
                  key={doc.id}
                  className="flex items-start gap-3 rounded-2xl bg-secondary/50 p-3"
                >
                  <Checkbox
                    id={inputId}
                    checked={checked}
                    disabled={!checked && full}
                    onCheckedChange={(v) => onToggle(doc.id, v === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor={inputId} className="block font-normal">
                    <span className="block font-medium">
                      {DOC_TYPE_LABEL[doc.doc_type]}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {documentFacts(doc)} · uploaded {date(doc.created_at)}
                    </span>
                  </Label>
                </li>
              );
            })}
          </ul>
          {adding && full && picked.length === 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Your submission already holds {MAX_RUN_DOCUMENTS} documents, the
              most a reviewer takes at once. Untick one above to make room.
            </p>
          )}
          <p id={hintId} className="mt-3 text-xs text-muted-foreground">
            {hint}
          </p>
          <Button
            type="button"
            className="mt-4"
            onClick={onSubmit}
            disabled={picked.length === 0 || pending || disabled}
          >
            {pending ? (
              <Spinner aria-hidden="true" role="presentation" />
            ) : (
              <Send aria-hidden="true" />
            )}
            {adding
              ? picked.length === 0
                ? "Add to your submission"
                : `Add ${plural(picked.length)} to your submission`
              : picked.length === 0
                ? "Submit for review"
                : `Submit ${plural(picked.length)} for review`}
          </Button>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {submitFailure(error)}
            </p>
          )}
        </fieldset>
      )}

      {earlier.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">
            {adding ? "In earlier submissions" : "Already submitted"}
          </h3>
          <ul className="mt-2 space-y-2">
            {earlier.map((doc) => (
              <li
                key={doc.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
              >
                <FileText
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="font-medium">
                  {DOC_TYPE_LABEL[doc.doc_type]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {documentFacts(doc)}
                </span>
                <Badge variant="secondary">Submitted</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
