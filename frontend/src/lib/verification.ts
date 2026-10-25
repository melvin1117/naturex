/**
 * Listing verification (ADR-0006; API from T69, screens T70): labels, client-side file checks
 * that mirror the backend's, and refusals in words. Pure. Every level, badge, check result and
 * decision shown comes from the API (badges from `GET /assets/{id}/verification`, which also
 * knows whether a revocation still stands); nothing here decides one.
 */
import type { ApiError } from "./api/errors";
import { formatWait } from "./api/errors";
import type {
  CheckResult,
  DocumentType,
  ListingDocument,
  ReviewerRole,
  VerificationCheck,
  VerificationLevel,
  VerificationRun,
} from "./api/types";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_RUN_DOCUMENTS = 3;
export const ACCEPTED_MEDIA_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
export const ACCEPT_ATTRIBUTE = ACCEPTED_MEDIA_TYPES.join(",");

export const LEVEL_LABEL: Record<VerificationLevel, string> = {
  unverified: "Not verified",
  documents_submitted: "Waiting for a reviewer",
  verified: "Verified land",
  rejected: "Rejected",
  revoked: "Revoked",
};

const CHECK_LABEL: Record<string, string> = {
  accepted_format: "Accepted file format",
  not_reused: "Not reused by another listing",
  boundary_free: "Boundary doesn't overlap another listing",
  consent_document: "Consent-labelled document attached",
};

/** What a passing check does and doesn't show, where a reader could over-read it. */
export const CHECK_NOTE: Record<string, string> = {
  consent_document:
    "Shows a document labelled as assembly minutes or consent was attached, not that consent exists.",
};

function humanize(code: string): string {
  const text = code.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function checkLabel(check: string): string {
  return CHECK_LABEL[check] ?? humanize(check);
}

export const RESULT_LABEL: Record<CheckResult, string> = {
  pass: "Passed",
  warn: "Warning",
  fail: "Failed",
};

const REVIEWER_LABEL: Record<ReviewerRole, string> = {
  platform_admin: "WildWorth platform admin",
  partner_reviewer: "Partner reviewer",
};

export function reviewerLabel(role: string | null | undefined): string | null {
  if (!role) return null;
  return REVIEWER_LABEL[role as ReviewerRole] ?? humanize(role);
}

export const DOC_TYPE_LABEL: Record<DocumentType, string> = {
  title: "Land title",
  agrarian_certificate: "Agrarian certificate",
  assembly_minutes: "Assembly minutes (consent)",
  entity_registration: "Cooperative or ejido registration",
  other: "Other document",
};

export const DOC_TYPES = Object.keys(DOC_TYPE_LABEL) as DocumentType[];

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "PDF · 3 pages · 1.2 MB" or "PNG · 1200 × 800 px · 340 KB". */
export function documentFacts(doc: ListingDocument): string {
  const parts: string[] = [];
  if (doc.media_type === "application/pdf") {
    parts.push("PDF");
    if (doc.page_count != null)
      parts.push(`${doc.page_count} page${doc.page_count === 1 ? "" : "s"}`);
  } else {
    parts.push(doc.media_type === "image/png" ? "PNG" : "JPEG");
    if (doc.width != null && doc.height != null)
      parts.push(`${doc.width} × ${doc.height} px`);
  }
  parts.push(fileSize(doc.size_bytes));
  return parts.join(" · ");
}

/** Why a picked file won't be accepted, checked before uploading; null if it may be. */
export function fileProblem(
  file: Pick<File, "size" | "type"> | null,
): string | null {
  if (!file) return "Choose a file to upload.";
  if (!(ACCEPTED_MEDIA_TYPES as readonly string[]).includes(file.type))
    return "Choose a PDF, JPEG or PNG file.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_DOCUMENT_BYTES)
    return `That file is ${fileSize(file.size)}; the limit is 5 MB.`;
  return null;
}

export function checkCounts(
  checklist: readonly Pick<VerificationCheck, "result">[],
): Record<CheckResult, number> {
  const counts: Record<CheckResult, number> = { pass: 0, warn: 0, fail: 0 };
  for (const item of checklist) counts[item.result] += 1;
  return counts;
}

/**
 * The current run while it still waits for a decision: a new submission adds to it, keeping
 * its documents (#210). Null when there's none, or once it's decided.
 */
export function waitingRun(
  runs: readonly VerificationRun[] | undefined,
): VerificationRun | null {
  const run = currentRun(runs);
  return run?.level === "documents_submitted" ? run : null;
}

export function currentRun(
  runs: readonly VerificationRun[] | undefined,
): VerificationRun | null {
  return runs?.find((run) => run.is_current) ?? null;
}

export type Tone = "neutral" | "pending" | "positive" | "negative";

export interface Status {
  title: string;
  body: string;
  tone: Tone;
}

/** Where a listing stands, for its steward, from its current run (null: none yet). */
export function stewardStatus(run: VerificationRun | null): Status {
  if (!run) {
    return {
      title: "Not verified yet",
      body: "Exchange visitors see this listing as self-attested by the community. Upload your land documents and submit them for review. On the live Exchange, the opening offer needs a verified listing.",
      tone: "neutral",
    };
  }
  if (!run.fingerprint_matches && run.level !== "revoked") {
    return {
      title: "The listing changed since its last review",
      body: "Its name, area, boundary or community changed after these documents were submitted, so it counts as unverified again. Submit documents for a new review.",
      tone: "neutral",
    };
  }
  switch (run.level) {
    case "documents_submitted":
      return {
        title: "Waiting for a reviewer",
        body: "The automated checks have run. A WildWorth reviewer reads them with your documents and approves or rejects the listing; you'll see the decision here.",
        tone: "pending",
      };
    case "verified":
      return {
        title: "Verified by a reviewer",
        body: "A reviewer approved this listing after reading the checks. If its name, area, boundary or community changes, it needs a new review.",
        tone: "positive",
      };
    case "rejected":
      return {
        title: "The reviewer rejected these documents",
        body: "Read the reason below, then upload new documents and submit them for a new review. The documents you sent stay in this listing's record but can't be sent twice: to use one again, upload the file again.",
        tone: "negative",
      };
    case "revoked":
      return {
        title: "Verification revoked",
        body: "An approved verification was withdrawn, so trading is paused. Only a reviewer's approval of a new submission resumes it.",
        tone: "negative",
      };
    default:
      return {
        title: "Not verified yet",
        body: "Upload your land documents and submit them for review.",
        tone: "neutral",
      };
  }
}

const waitText = (error: ApiError) =>
  error.retryAfterSeconds === null
    ? "a moment"
    : formatWait(error.retryAfterSeconds);

/** A refused upload, in words (`POST /assets/{id}/documents`). */
export function uploadFailure(error: ApiError): string {
  switch (error.code) {
    case "file_too_large":
      return "That file is over 5 MB. Upload a smaller scan or photo.";
    case "unsupported_media_type":
    case "unsupported_format":
    case "media_type_mismatch":
      return "Only PDF, JPEG and PNG files are accepted, and the file's contents must match its type.";
    case "empty_file":
      return "That file is empty.";
    case "image_too_large":
      return "That image is too large to inspect (at most 40 megapixels and 12,000 px a side). Scale it down and try again.";
    case "image_malformed":
      return "That image couldn't be read. Save it again as JPEG or PNG.";
    case "trailing_data":
    case "embedded_signature":
      return "That file carries extra hidden data, so it can't be accepted. Scan or export it again.";
    case "pdf_encrypted":
      return "That PDF is password-protected or encrypted. Upload an unprotected copy.";
    case "pdf_malformed":
      return "That PDF couldn't be read. Scan or export it again.";
    case "pdf_too_many_pages":
      return "That PDF has more than 50 pages. Upload only the pages that matter.";
    case "pdf_too_many_objects":
      return "That PDF is too complex to inspect safely. Print it to a new PDF or scan it, then try again.";
    case "pdf_active_content":
      return "That PDF contains scripts, forms or attachments, which aren't accepted. Print it to a new PDF and try again.";
    case "inspection_timeout":
    case "inspection_failed":
      return "We couldn't finish checking that file. Try a smaller or simpler file.";
    case "inspection_busy":
      return `Document checks are busy right now. Try again in ${waitText(error)}.`;
    case "upload_rate_limited":
      return `You've uploaded many documents in the last hour. Try again in ${waitText(error)}.`;
    case "length_required":
      return "Your browser didn't say how big the file is. Try again.";
    case "listing_closed":
      return "This listing is withdrawn or not eligible, so it can't take documents.";
    case "document_limit_reached":
      return "This listing already holds 20 documents, the most it can.";
    case "storage_quota_exceeded":
      return "Your community has used all of its document storage.";
    case "document_reused":
      return "That exact file already backs another listing. A document can support only one listing.";
    case "members_only":
      return "Only this community's owner and stewards can upload documents.";
  }
  return error.message;
}

/** A refused submission (`POST /assets/{id}/verification/runs`). */
export function submitFailure(error: ApiError): string {
  switch (error.code) {
    case "document_not_found":
      return "One of those documents isn't on this listing any more. Choose again.";
    case "document_already_submitted":
      return "One of those documents was already submitted. Choose again.";
    case "submission_full":
      return `A submission holds at most ${MAX_RUN_DOCUMENTS} documents. Remove one from your submission to make room, or add fewer.`;
    case "document_not_in_submission":
      return "Your submission changed since you opened this page. Reload and choose again.";
    case "listing_closed":
      return "This listing is withdrawn or not eligible, so it can't be verified.";
    case "members_only":
      return "Only this community's owner and stewards can submit documents.";
  }
  return error.message;
}

/** A refused approve, reject or revoke (`POST /admin/assets/{id}/verification/{run}/…`). */
export function decisionFailure(error: ApiError): string {
  switch (error.code) {
    case "run_superseded":
      return "The steward submitted newer documents, so this run is no longer current. Open the listing again.";
    case "run_already_decided":
      return "This run has already been decided. Reload to see the decision.";
    case "stale_run":
      return "The listing changed after these documents were submitted (name, area, boundary or community). The steward needs to submit again.";
    case "checks_failed":
      return "A check failed, so this run can't be approved. Reject it with a reason instead.";
    case "overlap":
      return "The boundary now overlaps another listing, so it can't be approved.";
    case "listing_closed":
      return "This listing is withdrawn or not eligible, so it can't be approved.";
    case "not_verified":
      return "Only a verified run can be revoked.";
    case "conflict_of_interest":
      return "You belong to this listing's community, so another admin has to review it.";
    case "run_not_found":
      return "That run isn't one of this listing's. Reload and try again.";
  }
  return error.message;
}

/** The Exchange asset page's ledger tab, scrolled to one entry. */
export function ledgerEntryHref(assetId: string, seq: number): string {
  return `/asset/${assetId}?tab=ledger#${ledgerEntryId(seq)}`;
}

export function ledgerEntryId(seq: number): string {
  return `ledger-entry-${seq}`;
}

/** The Reviewer's views: opening offers (ADR-0008 §5), the documents queue, then each decision. */
export const REVIEW_VIEWS = [
  "offers",
  "waiting",
  "verified",
  "rejected",
  "revoked",
] as const;
export type ReviewView = (typeof REVIEW_VIEWS)[number];

export function reviewView(value: string | null | undefined): ReviewView {
  return (REVIEW_VIEWS as readonly string[]).includes(value ?? "")
    ? (value as ReviewView)
    : "offers";
}

/** The Reviews page on one view: `/admin/verifications?view=…`. */
export function reviewViewHref(view: ReviewView): string {
  return view === "offers"
    ? "/admin/verifications"
    : `/admin/verifications?view=${view}`;
}

export function adminReviewHref(assetId: string): string {
  return `/admin/verifications/${assetId}`;
}

/** The original file, always served as a download (same-origin `/api` proxy, or `/api/sandbox`
 * in the sandbox, cookie sent). */
export function documentDownloadUrl(
  assetId: string,
  documentId: string,
  apiBase = "/api",
): string {
  return `${apiBase}/assets/${assetId}/documents/${documentId}`;
}
