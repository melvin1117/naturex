import {
  CircleHelp,
  Equal,
  EqualNot,
  Minus,
  TriangleAlert,
} from "lucide-react";
import { cn } from "cn";

import type {
  AiComparison,
  AiDocumentReading,
  AiExtractedField,
} from "@/lib/api/types";
import {
  COMPARED_BY_LABEL,
  FIELD_LABEL,
  NOT_SENT_LABEL,
  READ_FIELDS,
  untrustedText,
  VERDICT_LABEL,
} from "@/lib/ai-suggestion";
import { DOC_TYPE_LABEL } from "@/lib/verification";

/**
 * Text that came out of a document (or a model reading one): attacker-written. React puts it
 * in a text node, so it's never HTML, Markdown or a link; `<bdi>` keeps its direction from
 * spilling into the page, and it wraps anywhere so a long token can't break the layout.
 */
export function UntrustedText({
  text,
  empty = "Nothing read",
  className,
}: {
  text: string | null | undefined;
  empty?: string;
  className?: string;
}) {
  const shown = untrustedText(text);
  if (shown === null)
    return <span className="text-muted-foreground italic">{empty}</span>;
  return (
    <bdi
      data-untrusted=""
      className={cn("[overflow-wrap:anywhere] whitespace-normal", className)}
    >
      {shown}
    </bdi>
  );
}

function Excerpt({ text }: { text: string | null | undefined }) {
  if (untrustedText(text) === null) return null;
  return (
    <blockquote className="mt-2 border-l-2 border-border pl-3 text-xs text-muted-foreground">
      <span className="sr-only">Excerpt from the document: </span>
      <UntrustedText text={text} className="font-mono" />
    </blockquote>
  );
}

const VERDICT_ICON = {
  match: Equal,
  mismatch: EqualNot,
  unclear: CircleHelp,
  not_applicable: Minus,
} satisfies Record<AiComparison["verdict"], unknown>;

/** A document's place in the suggestion: "Document 1 · Land title", as its reasons count. */
export function documentName(
  documents: readonly AiDocumentReading[],
  documentId: string,
): string {
  const index = documents.findIndex((d) => d.document_id === documentId);
  if (index < 0) return "A document";
  return `Document ${index + 1} · ${DOC_TYPE_LABEL[documents[index]!.doc_type]}`;
}

/** Each field compared with the listing: both values, the excerpt, the verdict and why. */
export function Comparisons({
  comparisons,
  documents,
}: {
  comparisons: readonly AiComparison[];
  documents: readonly AiDocumentReading[];
}) {
  if (comparisons.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No field was compared with the listing.
      </p>
    );
  return (
    <ul aria-label="Field comparisons" className="space-y-3">
      {comparisons.map((c) => {
        const Icon = VERDICT_ICON[c.verdict];
        return (
          <li
            key={`${c.document_id}:${c.field}`}
            className="rounded-2xl border border-border p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
              <p className="min-w-0 text-sm">
                <span className="font-medium">{FIELD_LABEL[c.field]}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {documentName(documents, c.document_id)}
                </span>
              </p>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 text-sm font-medium",
                  c.verdict === "mismatch" && "text-clay-ink",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {VERDICT_LABEL[c.verdict]}
              </span>
            </div>
            <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Listing</dt>
                <dd>
                  <UntrustedText text={c.listing_value} empty="None" />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Document</dt>
                <dd>
                  <UntrustedText text={c.document_value} />
                </dd>
              </div>
            </dl>
            <Excerpt text={c.excerpt} />
            <p className="mt-2 text-sm">
              <UntrustedText text={c.reason} empty="No reason given" />
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {COMPARED_BY_LABEL[c.compared_by]}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function sentText(doc: AiDocumentReading): string {
  if (!doc.sent_to_model)
    return doc.not_sent_reason
      ? NOT_SENT_LABEL[doc.not_sent_reason]
      : "Not sent to the model.";
  return doc.readable
    ? "Sent to the model as a preview image; it could read it."
    : "Sent to the model as a preview image; it couldn't read it.";
}

function hasText(field: AiExtractedField): boolean {
  return (
    untrustedText(field.value) !== null || untrustedText(field.excerpt) !== null
  );
}

/** What the model read off each document, with the excerpt around each value. */
export function DocumentReadings({
  documents,
}: {
  documents: readonly AiDocumentReading[];
}) {
  if (documents.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No document was read.</p>
    );
  return (
    <ol aria-label="Documents read" className="space-y-3">
      {documents.map((doc) => {
        const fields = READ_FIELDS.filter((name) => hasText(doc[name]));
        return (
          <li
            key={doc.document_id}
            className="rounded-2xl border border-border p-4"
          >
            <p className="text-sm font-medium">
              {documentName(documents, doc.document_id)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {sentText(doc)}
            </p>
            {doc.instruction_like_text && (
              <p className="mt-2 flex items-start gap-1.5 text-sm font-medium text-clay-ink">
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                Holds text aimed at an AI model: a sign of manipulation.
              </p>
            )}
            {fields.length > 0 && (
              <dl className="mt-3 space-y-3 text-sm">
                {fields.map((name) => (
                  <div key={name} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      {FIELD_LABEL[name]}
                    </dt>
                    <dd>
                      <UntrustedText text={doc[name].value} />
                      {name === "area" && doc.area_ha !== null && (
                        <span className="text-muted-foreground">
                          {" "}
                          (= {doc.area_ha} ha, converted by code)
                        </span>
                      )}
                      <Excerpt text={doc[name].excerpt} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ol>
  );
}
