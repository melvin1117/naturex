/**
 * Steward home and community management helpers (T63). Pure: they check what the user typed
 * the way the backend will (so the form can say so before sending), turn the community routes'
 * errors into form messages, map a listing's `next_action` to its link, and say what its
 * verification means for the opening offer (#216). Every number on the Steward home is the
 * API's; nothing here computes one. Steward wording follows docs/design/ux-writing.md §7: no
 * "IPO", "dividends" or "treasury" outside the trade panel.
 */
import type { ApiError } from "./api/errors";
import type {
  AssetCard,
  ListingVerification,
  NextAction,
  VerificationLevel,
} from "./api/types";
import { ipoHref, verifyHref } from "./listing/links";
import { assetHref } from "./trade";

export const NAME_MIN = 2;
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 1000;

export type CommunityField = "name" | "country" | "description";
export type CommunityErrors = Partial<Record<CommunityField, string>>;

export interface CommunityInput {
  name: string;
  country: string;
  description: string;
}

const NAME_CHARS = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} \-'’.,&()]*$/u;

/** The name as the backend stores it: NFKC, trimmed, runs of spaces collapsed. */
export function cleanName(raw: string): string {
  return raw.normalize("NFKC").split(/\s+/).filter(Boolean).join(" ");
}

/** The body for `POST /communities` or `PATCH`: empty country and description mean none. */
export function communityBody(input: CommunityInput) {
  return {
    name: cleanName(input.name),
    country: input.country.trim() ? input.country.trim().toUpperCase() : null,
    description: input.description.trim() ? input.description.trim() : null,
  };
}

/** The backend's rules (`app/communities.py`), checked before sending. */
export function validateCommunity(input: CommunityInput): CommunityErrors {
  const errors: CommunityErrors = {};
  const name = cleanName(input.name);
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    errors.name = `Use ${NAME_MIN}–${NAME_MAX} characters.`;
  } else if (!NAME_CHARS.test(name)) {
    errors.name =
      "Start with a letter or digit; use letters, digits, spaces and - ' . , & ( ) only.";
  }
  const country = input.country.trim();
  if (country && !/^[A-Za-z]{2}$/.test(country)) {
    errors.country = "Use a two-letter country code, like MX or KE.";
  }
  if (input.description.trim().length > DESCRIPTION_MAX) {
    errors.description = `Use at most ${DESCRIPTION_MAX} characters.`;
  }
  return errors;
}

export interface CommunityFailure {
  field: CommunityField | null;
  message: string;
}

const FIELDS: readonly string[] = ["name", "country", "description"];

/** A 422's first field problem, e.g. `{ loc: ["body", "name"], msg: "Value error, Use…" }`. */
function fieldProblem(detail: unknown): CommunityFailure | null {
  if (!Array.isArray(detail)) return null;
  for (const issue of detail as { loc?: unknown[]; msg?: unknown }[]) {
    const field = issue.loc?.find((part) => FIELDS.includes(String(part)));
    if (typeof field === "string" && typeof issue.msg === "string") {
      const message = issue.msg.replace(/^Value error,\s*/, "");
      return {
        field: field as CommunityField,
        message: message.endsWith(".") ? message : `${message}.`,
      };
    }
  }
  return null;
}

/** What to tell the user when creating or editing a community fails. */
export function communityFailure(error: ApiError): CommunityFailure {
  switch (error.code) {
    case "community_name_taken":
      return {
        field: "name",
        message:
          "A community with this name already exists. Choose another name.",
      };
    case "community_limit_reached":
      return {
        field: null,
        message:
          "You already own 5 communities, the most one account can. Manage one of them instead.",
      };
    case "owner_only":
      return {
        field: null,
        message: "Only the community's owner can change its details.",
      };
  }
  if (error.status === 422) {
    return (
      fieldProblem(error.detail) ?? { field: null, message: error.message }
    );
  }
  return { field: null, message: error.message };
}

/** A failed steward add or remove, in words. */
export function memberFailure(error: ApiError): string {
  switch (error.code) {
    case "user_not_found":
      return "No account with that ID here. Check the ID they gave you.";
    case "already_member":
      return "That account is already a member.";
    case "member_has_holdings":
      return "That account holds units of one of your listings. Members can't trade their own land, so they'd need to sell first.";
    case "member_not_eligible":
      return "That account can't be a steward (admins and treasuries can't join a community).";
    case "owner_cannot_be_removed":
      return "The owner can't be removed.";
  }
  if (error.status === 422) return "Enter a valid account ID.";
  return error.message;
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  rating: "Being rated",
  needs_evidence: "Needs evidence",
  ineligible: "Not eligible",
  listed: "Listed",
  suspended: "Trading paused",
  withdrawn: "Withdrawn",
};

type AssetStatus = AssetCard["status"];

export interface ListingLink {
  label: string;
  href: string;
}

export interface ListingAction {
  label: string;
  /** Where the action goes; null when there's nothing to open (an explanation instead). */
  href: string | null;
  /** The listing's main call to action (shown as the primary button). */
  primary: boolean;
  /** A second way forward beside it: previewing the opening offer while verification waits. */
  secondary?: ListingLink;
}

type VerificationWords = Pick<ListingVerification, "level" | "decision">;

export interface ListingActionOptions {
  /** The caller owns the community: only the owner opens a listing to supporters. */
  owner?: boolean;
  /** Where the listing's verification stands, for the words of the verify step. */
  verification?: VerificationWords;
}

/**
 * The link for a listing's next step: never a door the backend would keep locked (#216). The
 * listing flow (T33) is `/steward/list?community=<id>&asset=<id>` (it resumes that listing), the
 * verification screen (T70) `/steward/assets/<id>/verify`, the opening offer (T64)
 * `/steward/assets/<id>/ipo`, the public page `/asset/<id>`. While verification blocks the offer,
 * verifying is the main action and the owner may preview the offer beside it. With nothing to
 * open, `status` says why (a listing suspended before its opening offer, or a closed one).
 */
export function listingAction(
  action: NextAction,
  assetId: string,
  communityId: string,
  status?: AssetStatus,
  { owner = true, verification }: ListingActionOptions = {},
): ListingAction {
  const list = `/steward/list?${new URLSearchParams({ community: communityId, asset: assetId })}`;
  const verify = verifyHref(assetId, communityId);
  // Only a listing that hasn't opened yet (still `listed`) has an offer to preview.
  const preview =
    owner && status === "listed"
      ? {
          label: "Preview the opening offer",
          href: ipoHref(assetId, communityId),
        }
      : undefined;
  switch (action) {
    case "continue_listing":
      return { label: "Continue listing", href: list, primary: true };
    case "add_evidence":
      return { label: "Add evidence", href: list, primary: true };
    case "rating_in_progress":
      return { label: "Rating in progress", href: null, primary: false };
    case "verify":
      return {
        label:
          verification?.decision === "rejected"
            ? "Submit new documents"
            : verification?.level === "revoked"
              ? "Verify again"
              : "Verify this listing",
        href: verify,
        primary: true,
        secondary: preview,
      };
    case "verification_in_review":
      return {
        label: "See your submission",
        href: verify,
        primary: false,
        secondary: preview,
      };
    case "awaiting_verification":
      return { label: "Waiting for verification", href: null, primary: false };
    case "launch_ipo":
      return {
        label: "Send your offer",
        href: ipoHref(assetId, communityId),
        primary: true,
      };
    case "awaiting_ipo":
      return {
        label: "Waiting for the owner to open it to supporters",
        href: null,
        primary: false,
      };
    case "offer_in_review":
      return {
        label: "Waiting for the Reviewer",
        href: ipoHref(assetId, communityId),
        primary: false,
      };
    case "offer_sent_back":
      return {
        label: "Read the Reviewer's note",
        href: ipoHref(assetId, communityId),
        primary: true,
      };
    case "view_on_exchange":
      return {
        label: "View on Marketplace",
        href: assetHref(assetId),
        primary: false,
      };
    default:
      return {
        label: status === "suspended" ? "Suspended" : "Closed",
        href: null,
        primary: false,
      };
  }
}

const CHIP: Record<VerificationLevel, string> = {
  unverified: "Not verified",
  documents_submitted: "In review",
  verified: "Verified land",
  rejected: "Not approved",
  revoked: "Verification revoked",
};

/** The verification chip on a listing: plain words, beside the level's icon. */
export function verificationChip(
  verification: Pick<ListingVerification, "level" | "in_review">,
): string {
  if (verification.level === "revoked" && verification.in_review)
    return "Revoked · new documents in review";
  return verification.in_review ? "In review" : CHIP[verification.level];
}

/** "1,234" for share counts from the API. */
export function units(value: number): string {
  return value.toLocaleString("en-US");
}
