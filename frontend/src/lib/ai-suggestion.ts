/**
 * The AI document check's suggestion for reviewers (T71 API, ADR-0006 §2 and §5): labels and
 * plain-language explanations. Pure. The suggestion is an **untrusted heuristic**: every value,
 * excerpt and reason in it may have been written by whoever made the document, so callers
 * render them as plain text only (`untrustedText`), never as Markdown, links or HTML.
 */
import type {
  AiComparison,
  AiDocumentReading,
  AiSuggestion,
  AiSuggestionStatus,
  DocumentAiCheck,
} from "./api/types";

/** How often the review page asks again while the check is still running. */
export const AI_POLL_MS = 10_000;

/** Longest document-derived string shown; the API already caps them far below this. */
export const UNTRUSTED_MAX_CHARS = 600;

/** Document-derived text made safe to place in a text node: capped, never interpreted. */
export function untrustedText(
  text: string | null | undefined,
  max = UNTRUSTED_MAX_CHARS,
): string | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // By code points, so an emoji or other astral character at the cap is never split in two.
  const chars = Array.from(trimmed);
  return chars.length <= max ? trimmed : `${chars.slice(0, max - 1).join("")}…`;
}

export const STATUS_TEXT: Record<
  Exclude<AiSuggestionStatus, "completed">,
  { title: string; body: string }
> = {
  pending: {
    title: "The AI check is still reading the documents",
    body: "This page updates by itself; it can take a few minutes. You don't need to wait for it to decide.",
  },
  not_run: {
    title: "Not run for this submission",
    body: "The AI check is off in this world, or none of these documents may be sent to a model (a demo world sends only sample documents, and a document without a preview image is never sent). Decide from the documents, the checks and the map.",
  },
  failed: {
    title: "The AI check didn't finish",
    body: "No model answered, the AI budget was spent, or the job was lost. Decide from the documents, the checks and the map.",
  },
};

export const SUGGESTION_TEXT: Record<
  NonNullable<AiSuggestion["suggestion"]>,
  { label: string; body: string }
> = {
  consistent: {
    label: "Consistent with the listing",
    body: "A holder name on a document matched the community. That doesn't make the document authentic: a forged document can copy public details.",
  },
  inconsistent: {
    label: "Inconsistent with the listing",
    body: "A field didn't match the listing, or a document holds text aimed at an AI model. Read the excerpts below.",
  },
  unreadable: {
    label: "Couldn't compare",
    body: "Not enough could be read or compared to suggest either way.",
  },
};

export const FIELD_LABEL: Record<
  AiComparison["field"] | "parcel_id" | "issue_date",
  string
> = {
  holder_name: "Holder name",
  place: "Place",
  area: "Area",
  parcel_id: "Parcel ID",
  issue_date: "Issue date",
};

/** The fields read off each document, in reading order. */
export const READ_FIELDS = [
  "holder_name",
  "parcel_id",
  "place",
  "area",
  "issue_date",
] as const satisfies readonly (keyof AiDocumentReading)[];

export const VERDICT_LABEL: Record<AiComparison["verdict"], string> = {
  match: "Matches",
  mismatch: "Doesn't match",
  unclear: "Unclear",
  not_applicable: "Not compared",
};

export const COMPARED_BY_LABEL: Record<AiComparison["compared_by"], string> = {
  model: "Compared by the AI model",
  code: "Compared by code",
};

export const NOT_SENT_LABEL: Record<
  NonNullable<AiDocumentReading["not_sent_reason"]>,
  string
> = {
  no_preview:
    "Not sent to the model: it has no preview image (a PDF whose first page holds no scan).",
  not_sample:
    "Not sent to the model: a demo world sends only sample documents.",
};

const FLAG_TEXT: Record<string, string> = {
  instruction_like_text:
    "A document holds text aimed at an AI model, a sign of manipulation. Its fields weren't given to a model to compare.",
  listing_instruction_like_text:
    "The listing's community or place name reads like instructions to an AI model, so it wasn't compared.",
  documents_not_sent:
    "At least one document wasn't sent to the model; each document below says why.",
  place_not_geocoded:
    "The listing's place couldn't be looked up on the map, so its stored country was compared instead.",
  reason_withheld:
    "A model's reason was withheld because it cited a number it wasn't given or read like an instruction; that verdict counts as unclear.",
  mock_model:
    "Made by the offline stand-in model (mock mode), not a real AI model: development and tests only.",
};

/** A flag in plain words; an unknown flag is shown by its code rather than dropped. */
export function flagText(flag: string): string {
  return FLAG_TEXT[flag] ?? `Flag: ${flag.replaceAll("_", " ")}`;
}

/** "1 Oct 2026, 14:05 UTC": when the suggestion was made. */
export function suggestionTime(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const text = when.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${text} UTC`;
}

/** ADR-0006 §5's uploader notice, worded for what this world really does with an upload. */
export const UPLOAD_NOTICE: Record<
  DocumentAiCheck | "unknown",
  { title: string; body: string }
> = {
  uploads: {
    title: "An AI model may read your documents",
    body: "When you submit, a preview image of each document (never the original file) may be sent to an AI model on Nebius Token Factory, which compares what it reads with this listing. Its suggestion goes only to the NatureX reviewer, labelled as untrusted; a person decides.",
  },
  samples_only: {
    title: "Your uploads aren't sent to an AI model",
    body: "In this demo world the AI document check reads only NatureX's sample documents, with an AI model on Nebius Token Factory. Files you upload here are checked by code and read by a reviewer.",
  },
  off: {
    title: "Your documents aren't sent to an AI model",
    body: "The AI document check is off here: your documents are checked by code and read by a reviewer. If that changes, this notice will say so before you submit.",
  },
  unknown: {
    title: "An AI model may read your documents",
    body: "Depending on this world's settings, a preview image of each document you submit may be sent to an AI model on Nebius Token Factory to compare it with this listing. A person decides.",
  },
};
