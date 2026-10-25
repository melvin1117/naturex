/**
 * The Steward app's Listings page (#233): which group a listing belongs in, its status in plain
 * words, when it last changed, and what a member can do with it. Pure, so the rules are unit
 * tested. What a member may change comes from the API (`manage_actions`, the lifecycle's own
 * rules), never guessed here; the page only words it.
 */
import type { ApiError } from "./api/errors";
import type { ListingSummary } from "./api/types";
import { listingAction, type ListingLink } from "./community";
import { listingFailure } from "./listing/errors";
import { listingHref } from "./listing/links";
import { date } from "./prototype/format";

export type ListingGroup = "in_progress" | "live" | "closed";

export const GROUP_TITLE: Record<ListingGroup, string> = {
  in_progress: "In progress",
  live: "Live",
  closed: "Closed",
};

type Listing = Pick<
  ListingSummary,
  | "asset"
  | "next_action"
  | "verification"
  | "ipo_at"
  | "updated_at"
  | "manage_actions"
>;

/**
 * In progress: drafts, ratings, listings waiting for evidence, and listed ones still waiting
 * for verification or their opening offer. Live: opened to supporters, or paused. Closed:
 * withdrawn or not eligible (final).
 */
export function listingGroup(
  listing: Pick<Listing, "asset" | "ipo_at">,
): ListingGroup {
  switch (listing.asset.status) {
    case "withdrawn":
    case "ineligible":
      return "closed";
    case "suspended":
      return "live";
    case "listed":
      return listing.ipo_at ? "live" : "in_progress";
    default:
      return "in_progress";
  }
}

export type StatusTone =
  "draft" | "working" | "attention" | "ready" | "live" | "closed";

export interface StatusWords {
  label: string;
  /** One sentence on what it waits for, or null when the label says it all. */
  detail: string | null;
  tone: StatusTone;
}

/** A listing's status as the Listings page says it. */
export function listingStatusWords(listing: Listing): StatusWords {
  const { status, status_reason: reason } = listing.asset;
  switch (status) {
    case "draft":
      return {
        label: "Draft: not submitted yet",
        detail: "Finish the details and boundary, then submit it for rating.",
        tone: "draft",
      };
    case "rating":
      if (reason === "no_satellite_metrics")
        return {
          label: "Waiting for satellite data",
          detail:
            "There's no satellite data for this boundary yet. Try the rating again later.",
          tone: "attention",
        };
      if (reason?.startsWith("rating_failed") || reason === "rating_stale")
        return {
          label: "Rating didn't finish",
          detail: "Open it to try the rating again.",
          tone: "attention",
        };
      return {
        label: "Being rated",
        detail: "The AI agents are reading the satellite data and local news.",
        tone: "working",
      };
    case "needs_evidence":
      return {
        label: "Needs more evidence",
        detail:
          "The rating's confidence is too low to list it. Field photos can raise it.",
        tone: "attention",
      };
    case "ineligible":
      return {
        label: "Not eligible",
        detail:
          "The rating found too much damage or too low a grade to list it.",
        tone: "closed",
      };
    case "withdrawn":
      return { label: "Withdrawn", detail: null, tone: "closed" };
    case "suspended":
      return {
        label: "Trading paused",
        detail:
          listing.verification.level === "revoked"
            ? "Its verification was revoked. Trading resumes once new documents are approved."
            : "WildWorth paused trading on this site.",
        tone: "attention",
      };
    case "listed":
      break;
  }
  if (listing.ipo_at)
    return { label: "Live", detail: "Open to supporters.", tone: "live" };
  switch (listing.next_action) {
    case "verify":
      return listing.verification.decision === "rejected"
        ? {
            label: "Documents not approved",
            detail: "Upload corrected land documents and submit them again.",
            tone: "attention",
          }
        : {
            label: "Waiting for verification",
            detail:
              "Upload the land documents so a WildWorth reviewer can check them.",
            tone: "attention",
          };
    case "verification_in_review":
      return {
        label: "Documents in review",
        detail: "A WildWorth reviewer is checking the land documents.",
        tone: "working",
      };
    case "awaiting_verification":
      return {
        label: "Waiting for verification",
        detail: "It opens to supporters once its land documents are verified.",
        tone: "working",
      };
    case "offer_in_review":
      return {
        label: "Offer in review",
        detail: "A WildWorth reviewer is checking the offer.",
        tone: "working",
      };
    case "offer_sent_back":
      return {
        label: "Offer sent back",
        detail: "Read the Reviewer's note, then send it again.",
        tone: "attention",
      };
    case "awaiting_ipo":
      return {
        label: "Ready for its opening offer",
        detail: "The community's owner opens it to supporters.",
        tone: "ready",
      };
    default:
      return {
        label: "Ready for its opening offer",
        detail: "Rated and listed. Open it to supporters when you're ready.",
        tone: "ready",
      };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "Updated just now", "Updated 5 min ago", "Updated 3 h ago", else "Updated 12 Sep 2026". */
export function updatedText(iso: string, now: number = Date.now()): string {
  const age = now - Date.parse(iso);
  if (Number.isNaN(age)) return "";
  if (age < MINUTE) return "Updated just now";
  if (age < HOUR) return `Updated ${Math.floor(age / MINUTE)} min ago`;
  if (age < 24 * HOUR) return `Updated ${Math.floor(age / HOUR)} h ago`;
  return `Updated ${date(iso)}`;
}

export type GroupedListings<T> = Record<ListingGroup, T[]>;

/** The listings in their groups, the most recently changed first. */
export function groupListings<T extends Listing>(
  listings: readonly T[],
): GroupedListings<T> {
  const groups: GroupedListings<T> = { in_progress: [], live: [], closed: [] };
  const newest = [...listings].sort(
    (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
  );
  for (const listing of newest) groups[listingGroup(listing)].push(listing);
  return groups;
}

/**
 * The Community home's line about unfinished listings: "2 drafts", "1 draft and 2 more in
 * progress", "3 in progress"; null when there are none.
 */
export function inProgressText(listings: readonly Listing[]): string | null {
  const open = listings.filter((l) => listingGroup(l) === "in_progress");
  const drafts = open.filter((l) => l.asset.status === "draft").length;
  const others = open.length - drafts;
  const draftWords = `${drafts} ${drafts === 1 ? "draft" : "drafts"}`;
  if (drafts && others) return `${draftWords} and ${others} more in progress`;
  if (drafts) return draftWords;
  if (others) return `${others} in progress`;
  return null;
}

/** "View progress" while it's rated, "Try again" when the rating stopped and can be retried. */
function viewLabel({ asset }: Listing): string {
  if (asset.status !== "rating") return "View";
  const reason = asset.status_reason ?? "";
  if (reason.startsWith("rating_failed") || reason === "rating_stale")
    return "Try again";
  return reason === "no_satellite_metrics" ? "View" : "View progress";
}

export interface RowActions {
  /** The next step, as on the Community home; null when it has nothing to open. */
  next: (ListingLink & { primary: boolean }) | null;
  /** Edit a draft's details (opens the listing flow on its details). */
  edit: ListingLink | null;
  /** The API allows withdrawing it now. */
  withdraw: boolean;
  /** Open the listing when no step leads anywhere (being rated, paused, closed). */
  view: ListingLink | null;
}

/**
 * What a listing's row offers. A member continues or edits a draft, withdraws a listing the
 * API says may be withdrawn, and takes the next step; anyone else (a same-world admin) only
 * views. Nothing the backend would refuse is offered.
 */
export function rowActions(
  listing: Listing,
  communityId: string,
  { owner = false, member = true }: { owner?: boolean; member?: boolean } = {},
): RowActions {
  const { asset } = listing;
  const manage = member ? listing.manage_actions : [];
  const action = listingAction(
    listing.next_action,
    asset.id,
    communityId,
    asset.status,
    {
      owner,
      verification: listing.verification,
    },
  );
  const flow = listingHref(communityId, asset.id);
  const editable = manage.includes("edit");
  const next =
    action.href && (member || listing.next_action === "view_on_exchange")
      ? {
          label: editable ? "Continue" : action.label,
          href: action.href,
          primary: action.primary,
        }
      : null;
  return {
    next,
    edit: editable
      ? { label: "Edit details", href: `${flow}&step=details` }
      : null,
    withdraw: manage.includes("withdraw"),
    view: next
      ? null
      : {
          label: viewLabel(listing),
          href: flow,
        },
  };
}

export interface WithdrawFailure {
  title: string;
  message: string;
  /** The list is out of date (it moved on, or a rating started): refresh it. */
  stale: boolean;
}

/** A refused withdrawal, worded for the Listings page's confirmation. */
export function withdrawFailure(error: ApiError): WithdrawFailure {
  const moved = error.code?.match(/^cannot_withdraw_([a-z_]+)$/);
  if (moved)
    return {
      title: "This listing has moved on",
      message: `It's ${moved[1].replace(/_/g, " ")} now, so it can't be withdrawn. The list shows where it stands.`,
      stale: true,
    };
  if (error.code === "run_in_progress")
    return {
      title: "A rating is running",
      message:
        "Wait for the rating to finish, then withdraw it if you still want to.",
      stale: true,
    };
  const { title, message } = listingFailure(error);
  return { title, message, stale: false };
}
