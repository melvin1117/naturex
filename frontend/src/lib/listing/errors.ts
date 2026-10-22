/** Every failed listing write (T58) as what to show, with T36's 422 problems where they belong. */
import { ApiError, formatWait } from "../api/errors";
import type { AssetDetail } from "../api/types";
import type { FieldErrors, ListingField } from "./details";

export interface PolygonProblem {
  code: string;
  title: string;
  message: string;
}

const POLYGON_TITLE: Record<string, string> = {
  invalid_geojson: "The shape isn't valid",
  too_complex: "Too many corners",
  self_intersection: "The edges cross",
  too_small: "Too small",
  too_large: "Too large",
  overlap: "Overlap",
};

export interface ListingFailure {
  title: string;
  message: string;
  /** T36's problems from a 422, one per issue, for the boundary panel. */
  polygon: PolygonProblem[];
  /** Field messages from a 422. */
  fields: FieldErrors;
  /** The wait from `Retry-After` (429, 503), in seconds. */
  retryAfterSeconds: number | null;
  /** The community has too many listings in progress: point to its home. */
  limitReached?: boolean;
  /** The session ended: offer to sign in again (the draft is kept in this tab). */
  signIn?: boolean;
}

const STATUS_LABEL: Record<AssetDetail["status"], string> = {
  draft: "a draft",
  rating: "being rated",
  needs_evidence: "waiting for evidence",
  ineligible: "ineligible",
  listed: "listed",
  suspended: "suspended",
  withdrawn: "withdrawn",
};

const EVENT_VERB: Record<string, string> = {
  create: "created",
  edit: "edited",
  rated: "rated",
  submit: "submitted for rating",
  revise: "revised",
  withdraw: "withdrawn",
  suspend: "suspended",
  resume: "resumed",
};

function waitText(seconds: number | null): string {
  return seconds === null ? "a moment" : formatWait(seconds);
}

function validationIssues(detail: unknown) {
  if (!Array.isArray(detail)) return [];
  return detail.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { type, loc, msg } = item as {
      type?: unknown;
      loc?: unknown;
      msg?: unknown;
    };
    return [
      {
        type: typeof type === "string" ? type : "",
        field: Array.isArray(loc) ? String(loc.at(-1) ?? "") : "",
        msg: typeof msg === "string" ? msg.replace(/^Value error, /, "") : "",
      },
    ];
  });
}

const FIELDS = new Set<string>([
  "name",
  "country",
  "description",
  "attestation",
]);

/** Any failed listing write as what to show: one message, plus 422 problems where they belong. */
export function listingFailure(error: ApiError): ListingFailure {
  const base = {
    polygon: [] as PolygonProblem[],
    fields: {} as FieldErrors,
    retryAfterSeconds: error.retryAfterSeconds,
  };
  const wait = waitText(error.retryAfterSeconds);
  const code = error.code ?? "";
  const refused = code.match(/^cannot_([a-z]+)_([a-z_]+)$/);
  if (refused) {
    const status = refused[2] as AssetDetail["status"];
    return {
      ...base,
      title: "This listing has moved on",
      message: `It's ${STATUS_LABEL[status] ?? status.replace(/_/g, " ")} now, so it can't be ${EVENT_VERB[refused[1]] ?? refused[1]}. Its current status is shown below.`,
    };
  }
  if (error.status === 401)
    return {
      ...base,
      title: "Your session has ended",
      message:
        "Sign in again to save. What you've entered stays in this tab meanwhile.",
      signIn: true,
    };
  switch (code) {
    case "listing_limit_reached":
      return {
        ...base,
        title: "Too many listings in progress",
        message:
          "Your community already has as many listings in progress (drafts, ratings and ones waiting for evidence) as it can. Withdraw one on the Listings page, or finish it, then try again.",
        limitReached: true,
      };
    case "metrics_unavailable":
      return {
        ...base,
        title: "Still no satellite data",
        message:
          "There's no satellite data for this land yet, so a new rating would stop at the same step. Try again once it's available.",
      };
    case "evidence_required":
      return {
        ...base,
        title: "Nothing new to rate",
        message:
          "A new rating needs new field evidence or newer satellite data. Revise the listing to change it.",
      };
    case "overlap":
      return {
        ...base,
        title: "Another listing claims this land",
        message:
          "A listing submitted before yours now covers part of this boundary. Revise the boundary to go around it.",
      };
    case "run_in_progress":
      return {
        ...base,
        title: "A rating is already running",
        message: "Its progress shows here as the agents work.",
      };
    case "edit_rate_limited":
      return {
        ...base,
        title: "Too many edits",
        message: `You've edited this draft many times in the last hour. Try again in ${wait}.`,
      };
    case "resubmit_cooldown":
      return {
        ...base,
        title: "Wait before rating again",
        message: `This listing was submitted a few minutes ago. You can submit it again in ${wait}.`,
      };
    case "rating_rate_limited":
    case "rating_global_limit":
      return {
        ...base,
        title: "Too many ratings right now",
        message: `NatureX limits how many ratings run each hour. Try again in ${wait}.`,
      };
    case "rating_busy":
      return {
        ...base,
        title: "The raters are busy",
        message: `Every rating worker is busy. Try again in ${wait}.`,
      };
    case "no_changes":
      return {
        ...base,
        title: "Nothing changed",
        message: "There was nothing new to save.",
      };
    case "members_only":
      return {
        ...base,
        title: "Not your community",
        message:
          "Only this community's owner and stewards can manage its listings.",
      };
  }
  if (error.status === 422) {
    const issues = validationIssues(error.detail);
    const polygon = issues
      .filter((issue) => issue.type.startsWith("polygon."))
      .map((issue) => {
        const problem = issue.type.slice("polygon.".length);
        return {
          code: problem,
          title: POLYGON_TITLE[problem] ?? "The boundary can't be used",
          message: issue.msg,
        };
      });
    const fields: FieldErrors = {};
    for (const issue of issues) {
      if (!issue.type.startsWith("polygon.") && FIELDS.has(issue.field))
        fields[issue.field as ListingField] ??= issue.msg;
    }
    if (polygon.length || Object.keys(fields).length)
      return {
        ...base,
        polygon,
        fields,
        title: polygon.length ? "Check the boundary" : "Check the details",
        message: polygon.length
          ? "NatureX couldn't accept this boundary. Fix the problems below and save again."
          : "Some details need a change before saving.",
      };
  }
  if (error.status === 404)
    return {
      ...base,
      title: "Not found",
      message:
        "This listing or community isn't available any more. Refresh the page.",
    };
  if (error.status === 403)
    return { ...base, title: "Not allowed", message: error.message };
  return { ...base, title: "That didn't work", message: error.message };
}
