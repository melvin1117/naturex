/**
 * Withdrawing a listing from its community's page (#233): a refusal in words. What a member may
 * change comes from the API (`manage_actions`), never guessed here.
 */
import type { ApiError } from "./api/errors";
import { listingFailure } from "./listing/errors";

export interface WithdrawFailure {
  title: string;
  message: string;
  /** The list is out of date (it moved on, or a rating started): refresh it. */
  stale: boolean;
}

/** A refused withdrawal, worded for the withdraw confirmation on a site's tile. */
export function withdrawFailure(error: ApiError): WithdrawFailure {
  const moved = error.code?.match(/^cannot_withdraw_([a-z_]+)$/);
  if (moved)
    return {
      title: "This listing has moved on",
      message: `It's ${moved[1].replace(/_/g, " ")} now, so it can't be withdrawn. The page shows where it stands.`,
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
