/** Where a listing stands (T58's status and reason) and what the steward can do next. */
import type { AssetDetail } from "../api/types";

export type OutcomeKind =
  | "draft"
  | "rating"
  | "waiting_for_data"
  | "stale"
  | "failed"
  | "listed"
  | "needs_evidence"
  | "ineligible"
  | "withdrawn"
  | "suspended";

export interface ListingOutcome {
  kind: OutcomeKind;
  title: string;
  message: string;
  /** Submit again (T58 allows it for a listing stuck in `rating`). */
  canRetry: boolean;
  /** Back to draft to redraw or edit. */
  canRevise: boolean;
  canWithdraw: boolean;
}

const GATE_REASON: Record<string, string> = {
  confidence_below_70: "The rating's confidence is below 70%.",
  grade_below_c: "The land's grade came out below C.",
  forest_loss_last_12m_at_least_1pct_of_area:
    "Forest loss in the last 12 months covers at least 1% of the area.",
};

const SUSPENSION: Record<string, string> = {
  moderation: "a moderator paused it",
  data_dispute: "its data is under review",
  community_request: "your community asked for a pause",
  verification_revoked: "its verification was revoked",
};

const UNKNOWN_GATE_REASON = "It didn't pass one of the listing checks.";

/** The gate's reasons (a comma-separated code) as sentences, never as codes. */
export function gateReasons(reason: string | null | undefined): string[] {
  const sentences = (reason ?? "")
    .split(",")
    .filter(Boolean)
    .map((code) => GATE_REASON[code] ?? UNKNOWN_GATE_REASON);
  return [...new Set(sentences)];
}

const outcome = (
  kind: OutcomeKind,
  title: string,
  message: string,
  actions: Partial<
    Pick<ListingOutcome, "canRetry" | "canRevise" | "canWithdraw">
  > = {},
): ListingOutcome => ({
  kind,
  title,
  message,
  canRetry: false,
  canRevise: false,
  canWithdraw: false,
  ...actions,
});

/** What the listing's status (and `status_reason`) means for the steward, and what they can do. */
export function listingOutcome(
  asset: Pick<AssetDetail, "status" | "status_reason" | "trading">,
): ListingOutcome {
  const reason = asset.status_reason ?? null;
  const stuck = { canRetry: true, canRevise: true, canWithdraw: true };
  switch (asset.status) {
    case "draft":
      return outcome(
        "draft",
        "Draft",
        "Only your community and WildWorth admins see this until the land is listed and its opening offer launches.",
        {
          canWithdraw: true,
        },
      );
    case "rating":
      if (reason === "no_satellite_metrics")
        return outcome(
          "waiting_for_data",
          "Waiting for satellite data",
          "WildWorth doesn't have satellite data for this land yet, so the rating stopped before scoring it. Nothing was made up. Try again later, once satellite data is available.",
          stuck,
        );
      if (reason === "rating_stale")
        return outcome(
          "stale",
          "The rating stopped",
          "The rating stopped without a result (its worker went quiet). Submit it again to restart.",
          stuck,
        );
      if (reason?.startsWith("rating_failed:"))
        return outcome(
          "failed",
          "The rating failed",
          "The rating couldn't finish. The pipeline shows the step that stopped; submit it again to retry.",
          stuck,
        );
      return outcome(
        "rating",
        "Rating in progress",
        "The agents are working. You can leave this page and come back; it picks up where the rating is.",
      );
    case "needs_evidence":
      return outcome(
        "needs_evidence",
        "Needs more evidence",
        `${gateReasons(reason).join(" ") || "The rating isn't confident enough yet."} To list, the rating must be at least 70% confident. Add geotagged field photos (validated photos raise confidence by a fixed amount) and submit it again, or revise the listing.`,
        { canRevise: true, canWithdraw: true },
      );
    case "ineligible":
      return outcome(
        "ineligible",
        "Not eligible to list",
        `${gateReasons(reason).join(" ")} Land that fails these checks can't be offered to supporters.`.trim(),
      );
    case "listed":
      return outcome(
        "listed",
        "Listed",
        asset.trading
          ? "The land is listed and trading is open."
          : "The land passed the listing gate. Set up the opening offer to let supporters back it; until it launches, only your community and WildWorth admins see it.",
      );
    case "suspended":
      return outcome(
        "suspended",
        "Trading paused",
        `Trading is paused because ${SUSPENSION[reason ?? ""] ?? "of a moderation decision"}.`,
      );
    case "withdrawn":
      return outcome(
        "withdrawn",
        "Withdrawn",
        "This listing was withdrawn. Its land and its slot are free for a new listing.",
      );
  }
}
