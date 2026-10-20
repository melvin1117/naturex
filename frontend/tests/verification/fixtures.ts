/** API answers for the verification screens (shapes from the OpenAPI schema, T69). */
import type {
  ListingDocument,
  ReviewQueueItem,
  VerificationPublic,
  VerificationRun,
} from "@/lib/api/types";

export const ASSET_ID = "33333333-3333-4333-8333-333333333333";
export const RUN_ID = "77777777-7777-4777-8777-777777777777";
export const DOC_TITLE = "88888888-8888-4888-8888-888888888881";
export const DOC_MINUTES = "88888888-8888-4888-8888-888888888882";

export const NOT_CHECKED = [
  "Whether a document is authentic or forged",
  "Whether the issuing authority is real and the title is current",
  "Legal validity and signatures",
  "Quorum, language and validity of community consent (FPIC)",
  "Whether the drawn polygon matches the legal parcel",
  "Who the uploader really is",
  "Registry records",
];

export function document(
  overrides: Partial<ListingDocument> = {},
): ListingDocument {
  return {
    id: DOC_TITLE,
    asset_id: ASSET_ID,
    run_id: null,
    doc_type: "title",
    media_type: "application/pdf",
    size_bytes: 1_258_291,
    page_count: 3,
    width: null,
    height: null,
    has_preview: false,
    commitment: "c".repeat(64),
    created_at: "2026-10-18T10:00:00Z",
    ...overrides,
  };
}

export const CHECKLIST: VerificationRun["checklist"] = [
  {
    check: "accepted_format",
    result: "pass",
    found: "2 documents: PDF (3 pages); PNG (1200 × 800 px)",
    source: "Upload inspection: PDF, JPEG or PNG by magic bytes",
  },
  {
    check: "not_reused",
    result: "pass",
    found: "2 of 2 bound to this listing",
    source: "Per-world keyed document fingerprint",
  },
  {
    check: "boundary_free",
    result: "pass",
    found: "no overlap",
    source: "Polygon overlap check",
  },
  {
    check: "consent_document",
    result: "pass",
    found: "1 assembly minutes / consent document(s) attached",
    source: "The steward's label on the upload",
  },
];

export function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    id: RUN_ID,
    asset_id: ASSET_ID,
    level: "documents_submitted",
    effective_level: "documents_submitted",
    is_current: true,
    fingerprint_matches: true,
    input_fingerprint: "f".repeat(64),
    method_version: "naturex-verification-v1",
    mode: "review",
    evidence_kind: "real",
    checklist: CHECKLIST,
    documents: [
      document({ run_id: RUN_ID }),
      document({
        id: DOC_MINUTES,
        run_id: RUN_ID,
        doc_type: "assembly_minutes",
        media_type: "image/png",
        size_bytes: 348_160,
        page_count: null,
        width: 1200,
        height: 800,
        has_preview: true,
      }),
    ],
    created_at: "2026-10-18T11:00:00Z",
    reviewer_role: null,
    reason: null,
    decided_at: null,
    revoke_reason: null,
    revoked_at: null,
    ...overrides,
  };
}

export const verifiedRun = (overrides: Partial<VerificationRun> = {}) =>
  run({
    level: "verified",
    effective_level: "verified",
    reviewer_role: "platform_admin",
    decided_at: "2026-10-19T09:00:00Z",
    ...overrides,
  });

export function panel(
  overrides: Partial<VerificationPublic> = {},
): VerificationPublic {
  return {
    asset_id: ASSET_ID,
    level: "unverified",
    badge: "Self-attested by the community",
    run_id: null,
    submitted_at: null,
    decided_at: null,
    revoked_at: null,
    reviewer_role: null,
    method_version: null,
    checks: [],
    not_checked: NOT_CHECKED,
    ledger_seq: null,
    ...overrides,
  };
}

export const verifiedPanel = (overrides: Partial<VerificationPublic> = {}) =>
  panel({
    level: "verified",
    badge: "Documents reviewed by NatureX (hackathon process)",
    run_id: RUN_ID,
    submitted_at: "2026-10-18T11:00:00Z",
    decided_at: "2026-10-19T09:00:00Z",
    reviewer_role: "platform_admin",
    method_version: "naturex-verification-v1",
    checks: CHECKLIST.map(({ check, result }) => ({ check, result })),
    ledger_seq: 7,
    ...overrides,
  });

export function queueItem(
  overrides: Partial<ReviewQueueItem> = {},
): ReviewQueueItem {
  return {
    asset_id: ASSET_ID,
    asset_name: "Río Claro Forest",
    asset_status: "listed",
    community_id: "66666666-6666-4666-8666-666666666666",
    run: run(),
    ai_suggestion_status: "not_run",
    ...overrides,
  };
}
