/**
 * Steward home and community management helpers (T63). Pure: they check what the user typed
 * the way the backend will (so the form can say so before sending), turn the community routes'
 * errors into form messages, and map a listing's `next_action` to its link. Every number on
 * the Steward home is the API's; nothing here computes one.
 */
import type { ApiError } from "./api/errors";
import type { NextAction } from "./api/types";
import { withCommunity } from "./navigation";
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

export interface ListingAction {
  label: string;
  /** Where the action goes; null when there's nothing to open (an explanation instead). */
  href: string | null;
  /** The listing's main call to action (shown as the primary button). */
  primary: boolean;
}

/**
 * The link for a listing's next step. The listing flow (T33) is `/steward/list?community=`,
 * the IPO screen (T64) `/steward/assets/<id>/ipo`, the public page `/asset/<id>`.
 */
export function listingAction(
  action: NextAction,
  assetId: string,
  communityId: string,
): ListingAction {
  const list = withCommunity("/steward/list", communityId);
  switch (action) {
    case "continue_listing":
      return { label: "Continue listing", href: list, primary: true };
    case "add_evidence":
      return { label: "Add evidence", href: list, primary: true };
    case "rating_in_progress":
      return { label: "Rating in progress", href: null, primary: false };
    case "launch_ipo":
      return {
        label: "Launch IPO",
        href: withCommunity(
          `/steward/assets/${encodeURIComponent(assetId)}/ipo`,
          communityId,
        ),
        primary: true,
      };
    case "awaiting_ipo":
      return {
        label: "Waiting for the owner to launch the IPO",
        href: null,
        primary: false,
      };
    case "view_on_exchange":
      return {
        label: "View on Exchange",
        href: assetHref(assetId),
        primary: false,
      };
    default:
      return { label: "Closed", href: null, primary: false };
  }
}

/** "1,234" for share counts from the API. */
export function units(value: number): string {
  return value.toLocaleString("en-US");
}
