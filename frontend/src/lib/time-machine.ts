/**
 * The admin Time Machine (T43) on T38's API: what a refusal means, labels for each asset's
 * outcome and the live progress of a quarter. Pure, so the panel stays presentational.
 */
import { formatWait, type ApiError } from "./api/errors";
import type { AssetRating, SimulatedAsset, TimeMachine } from "./api/types";
import { num } from "./report-facts";

export type TimeMachineFailure = {
  title: string;
  message: string;
  /** The world moved under the admin: refetch the Time Machine state. */
  refresh: boolean;
};

export const SANDBOX_ONLY: Omit<TimeMachineFailure, "refresh"> = {
  title: "The Time Machine runs in demo sandboxes only",
  message:
    "Real listings in the live world are never moved by simulated quarters or events. Open a demo session as the demo admin to try it.",
};

/** Why the Time Machine can't be used in this world, or null when it can (T38 `available`). */
export function unavailableReason(state: TimeMachine): string | null {
  if (state.available) return null;
  return state.unavailable_reason === "time_machine_sandbox_only" ||
    !state.unavailable_reason
    ? SANDBOX_ONLY.message
    : `The Time Machine isn't available here (${state.unavailable_reason}).`;
}

function common(error: ApiError): TimeMachineFailure | null {
  const wait =
    error.retryAfterSeconds === null
      ? "a moment"
      : formatWait(error.retryAfterSeconds);
  switch (error.code) {
    case "time_machine_sandbox_only":
    case "template_world":
      return { ...SANDBOX_ONLY, refresh: true };
    case "admin_only":
      return {
        title: "Admins only",
        message: "Only a platform admin can run the Time Machine.",
        refresh: false,
      };
    case "rating_rate_limited":
    case "rating_global_limit":
      return {
        title: "Too many ratings right now",
        message: `NatureX limits how many ratings run each hour. Try again in ${wait}.`,
        refresh: false,
      };
    case "rating_busy":
      return {
        title: "The raters are busy",
        message: `Every rating worker is busy. Try again in ${wait}.`,
        refresh: false,
      };
    case "llm_budget_exhausted":
      return {
        title: "The AI budget is spent",
        message:
          "This deployment has reached its LLM budget, so no more ratings can run.",
        refresh: false,
      };
  }
  return null;
}

/** A refused or failed `POST /admin/simulate/quarter`. */
export function quarterFailure(error: ApiError): TimeMachineFailure {
  const shared = common(error);
  if (shared) return shared;
  switch (error.code) {
    case "quarter_mismatch":
      return {
        title: "The quarter already moved",
        message:
          "Someone else moved this world to another quarter. The timeline has been refreshed; check it and try again.",
        refresh: true,
      };
    case "timeline_end":
      return {
        title: "End of the scripted timeline",
        message: "Reset the demo to start the timeline again.",
        refresh: true,
      };
    case "local_jobs_disabled":
      return {
        title: "Time Machine jobs are off on this server",
        message:
          "Quarters run in-process only with LOCAL_JOBS=true. The quarterly re-rate job still runs on its schedule.",
        refresh: true,
      };
  }
  return {
    title: "The quarter didn't run",
    message: error.message,
    refresh: error.status === 409,
  };
}

/** A refused or failed `POST /admin/simulate/event`. */
export function eventFailure(error: ApiError): TimeMachineFailure {
  const shared = common(error);
  if (shared) return shared;
  switch (error.code) {
    case "asset_not_listed":
      return {
        title: "This site isn't listed",
        message: "Events can only be injected into a listed site.",
        refresh: true,
      };
    case "no_current_metrics":
      return {
        title: "This site has no rating to start from",
        message:
          "An event changes a site's stored metrics; rate the site first.",
        refresh: false,
      };
    case "run_in_progress":
      return {
        title: "A rating is already running for this site",
        message: "Wait for it to finish, then inject the event.",
        refresh: false,
      };
    case "stale_metrics":
      return {
        title: "The site was re-rated meanwhile",
        message:
          "A newer rating sealed while this event was being applied, so nothing was stored. Try again: it will start from the new rating.",
        refresh: true,
      };
    case "event_not_recorded":
      return {
        title: "The site was re-rated, but the event wasn't recorded",
        message:
          "The new rating and price stand, but the event itself couldn't be stored, so it won't appear in the news, on the chart or as a news alert. The server logged the run; check the site before injecting again.",
        refresh: true,
      };
    case "rerate_failed":
      return {
        title: "The re-rate failed",
        message:
          "The site couldn't be re-rated, so the event wasn't stored. Try again.",
        refresh: false,
      };
    case "conflict_of_interest":
      return {
        title: "You're in this site's community",
        message:
          "An admin can't inject events into a site their own community listed.",
        refresh: false,
      };
    case "not_found":
      return {
        title: "Site not found",
        message: "That site isn't in this world any more.",
        refresh: true,
      };
  }
  return {
    title: "The event wasn't injected",
    message: error.message,
    refresh: error.status === 409,
  };
}

export const ASSET_STATUS_LABEL: Record<string, string> = {
  rerated: "Re-rated",
  already_done: "Already re-rated",
  skipped: "Skipped",
  failed: "Failed",
  in_progress: "Rating in progress",
  stopped: "Stopped",
};

const DETAIL_LABEL: Record<string, string> = {
  no_time_machine_version: "no scripted scenario for this site",
  no_current_metrics: "no rating to start from",
  llm_budget_exhausted: "the AI budget is spent",
  job_budget_exhausted: "this run's budget is spent",
  rating_rate_limited: "the hourly rating limit",
  rating_global_limit: "the hourly rating limit",
  rating_busy: "every rating worker was busy",
};

export function detailText(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return DETAIL_LABEL[detail] ?? detail.replaceAll("_", " ");
}

export const PAYOUT_LABEL: Record<
  NonNullable<SimulatedAsset["payout"]>,
  string
> = {
  paid: "Paid",
  already_paid: "Already paid",
  skipped: "Not paid",
  failed: "Payout failed",
};

/** "Stopped" reason for the whole quarter. */
export function stoppedText(stopped: string | null | undefined): string | null {
  if (!stopped) return null;
  return `Stopped early: ${detailText(stopped)}. Run the quarter again to finish the remaining sites.`;
}

export type RatingChange = {
  health: [number | null, number | null];
  grade: [string | null, string | null];
  price: [number | null, number | null];
};

export function ratingChange(
  before: AssetRating | null | undefined,
  after: AssetRating | null | undefined,
): RatingChange {
  return {
    health: [num(before?.health_score), num(after?.health_score)],
    grade: [before?.grade ?? null, after?.grade ?? null],
    price: [num(before?.price), num(after?.price)],
  };
}

/** One run of a quarter, as its `rating_progress` events report it. */
export type QuarterRun = { assetId: string; done: boolean };

/**
 * Fold a `rating_progress` payload into the quarter's runs: a run joins on its `queued` step
 * with trigger `time_machine`, and is done on its `done` step. Other runs are ignored.
 */
export function trackQuarterRun(
  runs: ReadonlyMap<string, QuarterRun>,
  payload: Record<string, unknown>,
): Map<string, QuarterRun> | null {
  const runId = payload.run_id;
  const assetId = payload.asset_id;
  if (typeof runId !== "string" || typeof assetId !== "string") return null;
  if (payload.step === "queued" && payload.trigger === "time_machine") {
    if (runs.has(runId)) return null;
    return new Map(runs).set(runId, { assetId, done: false });
  }
  const run = runs.get(runId);
  if (payload.step === "done" && run && !run.done) {
    return new Map(runs).set(runId, { ...run, done: true });
  }
  return null;
}
