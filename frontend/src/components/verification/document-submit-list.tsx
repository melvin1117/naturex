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

/**
 * The listing's documents. Ones not yet submitted can be picked (1–3) and submitted for
 * review; submitted ones stay listed with their run.
 */
export function DocumentSubmitList({
  documents,
  selected,
  onToggle,
  onSubmit,
  pending,
  error,
  disabled = false,
}: {
  documents: ListingDocument[];
  selected: readonly string[];
  onToggle: (id: string, on: boolean) => void;
  onSubmit: () => void;
  pending: boolean;
  error: ApiError | null;
  disabled?: boolean;
}) {
  const hintId = useId();
  const open = documents.filter((doc) => doc.run_id == null);
  const submitted = documents.filter((doc) => doc.run_id != null);
  const full = selected.length >= MAX_RUN_DOCUMENTS;
  const hasConsent = open.some(
    (doc) => selected.includes(doc.id) && doc.doc_type === "assembly_minutes",
  );

  if (documents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No documents yet. Upload a land title or agrarian certificate and the
        community assembly&apos;s minutes approving the listing.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {open.length > 0 && (
        <fieldset aria-describedby={hintId} disabled={disabled || pending}>
          <legend className="text-sm font-medium">
            Choose up to {MAX_RUN_DOCUMENTS} to submit together
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
          <p id={hintId} className="mt-3 text-xs text-muted-foreground">
            {selected.length > 0 && !hasConsent
              ? "None of the chosen documents is labelled as assembly minutes, so the consent check will fail."
              : "Submitting runs the automated checks at once; a reviewer then decides."}
          </p>
          <Button
            type="button"
            className="mt-4"
            onClick={onSubmit}
            disabled={selected.length === 0 || pending || disabled}
          >
            {pending ? (
              <Spinner aria-hidden="true" role="presentation" />
            ) : (
              <Send aria-hidden="true" />
            )}
            {selected.length === 0
              ? "Submit for review"
              : `Submit ${selected.length} document${selected.length === 1 ? "" : "s"} for review`}
          </Button>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {submitFailure(error)}
            </p>
          )}
        </fieldset>
      )}

      {submitted.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">Already submitted</h3>
          <ul className="mt-2 space-y-2">
            {submitted.map((doc) => (
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
