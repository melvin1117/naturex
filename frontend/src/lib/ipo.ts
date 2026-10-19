/**
 * Opening offer (IPO) launch helpers (T64). The price and every term of its formula come from
 * the backend's preview (`GET /assets/{id}/ipo/preview`); nothing here prices anything. These
 * only validate what the owner typed against the offering bounds (`app/market/offering.py`,
 * checked against the generated OpenAPI schema in tests) and turn the backend's codes into
 * plain words (docs/design/ux-writing.md: units, opening offer, play money).
 */
import type { ApiError } from "./api/errors";
import type { AssetDetail } from "./api/types";

export const MIN_TOTAL_SHARES = 10_000;
export const MAX_TOTAL_SHARES = 10_000_000;
export const DEFAULT_TOTAL_SHARES = 1_000_000;
export const MIN_RETAINED_PCT = 10;
export const MAX_RETAINED_PCT = 90;
export const DEFAULT_RETAINED_PCT = 51;
/** Wait this long after the last keystroke before asking for a new preview. */
export const PREVIEW_DEBOUNCE_MS = 400;

const int = (n: number) => n.toLocaleString("en-US");

export const SHARES_HINT = `Between ${int(MIN_TOTAL_SHARES)} and ${int(MAX_TOTAL_SHARES)} units. More units means a lower price per unit.`;
export const RETAINED_HINT = `Between ${MIN_RETAINED_PCT}% and ${MAX_RETAINED_PCT}%, up to 2 decimals. Keeping more than half keeps your community the majority holder.`;

/** Keep what can be part of a whole number of units: digits only (commas and spaces dropped). */
export function sharesInput(text: string): string {
  return text
    .replace(/\D/g, "")
    .replace(/^0+(?=\d)/, "")
    .slice(0, 9);
}

/** The units to issue, or null when not a whole number within the bounds. */
export function parseTotalShares(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) &&
    n >= MIN_TOTAL_SHARES &&
    n <= MAX_TOTAL_SHARES
    ? n
    : null;
}

/** Keep what can be part of a percentage with at most 2 decimals. */
export function retainedInput(text: string): string {
  const cleaned = text.replace(/[^\d.]/g, "");
  const [whole = "", ...rest] = cleaned.split(".");
  const digits = whole.replace(/^0+(?=\d)/, "").slice(0, 3);
  return rest.length === 0 ? digits : `${digits}.${rest.join("").slice(0, 2)}`;
}

/**
 * The retained % as the decimal string sent to the API ("51", "62.5"), or null when out of
 * range or malformed. Sent as text so the backend's Decimal gets exactly what was typed.
 */
export function parseRetainedPct(text: string): string | null {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  if (n < MIN_RETAINED_PCT || n > MAX_RETAINED_PCT) return null;
  return text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** Whether the preview answers for these inputs (it echoes the offering it priced). */
export function previewMatches(
  preview: { total_shares: number; retained_pct: string },
  totalShares: number,
  retainedPct: string,
): boolean {
  return (
    preview.total_shares === totalShares &&
    Number(preview.retained_pct) === Number(retainedPct)
  );
}

export interface Explanation {
  title: string;
  body: string;
}

const VERIFICATION: Explanation = {
  title: "Verification comes first",
  body: "The opening offer stays closed until this listing's land documents are verified. Once a reviewer approves them, you can launch.",
};

/** Why `launchable` is false (`blocked_reason`), or why the launch was refused with it. */
export function blockedExplanation(code: string): Explanation {
  switch (code) {
    case "run_in_progress":
      return {
        title: "A rating is running",
        body: "Wait for the current rating to finish. Its report can change the opening price, so the preview will update when it's sealed.",
      };
    case "ipo_price_too_high":
      return {
        title: "The price per unit is too high",
        body: "One unit would cost more than a new supporter's starting play money, so nobody could back the site. Issue more units to lower the price per unit.",
      };
    case "ipo_price_too_low":
      return {
        title: "The price per unit rounds to zero",
        body: "Issue fewer units so each one has a price.",
      };
    case "verification_required":
    case "not_verified":
      return VERIFICATION;
    default:
      return {
        title: "The opening offer can't launch right now",
        body: "Something about this listing blocks the launch. Refresh the preview and try again.",
      };
  }
}

/** Why a listing that isn't `listed` can't open to supporters yet, by its status. */
export function notListedExplanation(
  status: AssetDetail["status"] | undefined,
): Explanation {
  const title = "This site isn't listed yet";
  switch (status) {
    case "draft":
      return {
        title,
        body: "This listing is still a draft. Submit it for rating; once it's listed, you can open it to supporters.",
      };
    case "rating":
      return {
        title,
        body: "The AI rating is still running. If the site passes the listing gate, it's listed and you can launch here.",
      };
    case "needs_evidence":
      return {
        title,
        body: "The rating needs more evidence before the site can be listed. Add field evidence and submit it again.",
      };
    case "ineligible":
      return {
        title: "This site can't be listed",
        body: "It didn't pass the listing gate (grade C or better, no significant forest loss this year), so it can't open to supporters.",
      };
    case "suspended":
      return {
        title: "This site is suspended",
        body: "A suspended site can't open to supporters. It can launch once it's listed again.",
      };
    case "withdrawn":
      return {
        title: "This listing was withdrawn",
        body: "A withdrawn listing can't open to supporters.",
      };
    default:
      return {
        title,
        body: "Only a listed site can open to supporters.",
      };
  }
}

/** What a failed preview or launch means for the page. */
export type IpoRefusal =
  /** `ipo_already_launched`: show the way to the Exchange. */
  | { kind: "launched" }
  /** `asset_not_listed`: explain by the asset's status. */
  | { kind: "not_listed" }
  /** `no_rating`: there's no usable report to price from. */
  | { kind: "no_rating" }
  /** 403: only the community's owner launches. */
  | { kind: "owner_only" }
  /** 404: missing, or not visible to this account. */
  | { kind: "not_found" }
  /** `ipo_price_changed`: a newer report moved the price; preview and confirm again. */
  | { kind: "price_changed" }
  /** A reason the owner may fix by changing the offering, or that passes on its own. */
  | { kind: "blocked"; code: string; explanation: Explanation }
  /** Anything else (network, 5xx, 422): the API's safe message. */
  | { kind: "error"; message: string };

const OFFERING_CODES = new Set([
  "ipo_price_too_low",
  "ipo_price_too_high",
  "run_in_progress",
  "verification_required",
  "not_verified",
]);

export function ipoRefusal(error: ApiError): IpoRefusal {
  if (error.status === 403) return { kind: "owner_only" };
  if (error.status === 404) return { kind: "not_found" };
  if (error.status === 409) {
    switch (error.code) {
      case "ipo_already_launched":
        return { kind: "launched" };
      case "asset_not_listed":
        return { kind: "not_listed" };
      case "no_rating":
        return { kind: "no_rating" };
      case "ipo_price_changed":
        return { kind: "price_changed" };
    }
    const code = error.code ?? "";
    if (OFFERING_CODES.has(code)) {
      return { kind: "blocked", code, explanation: blockedExplanation(code) };
    }
  }
  return { kind: "error", message: error.message };
}

export const PRICE_CHANGED: Explanation = {
  title: "The opening price changed",
  body: "A newer rating report moved the price since your preview, so nothing was launched. Check the new price below and confirm again.",
};

export const OWNER_ONLY: Explanation = {
  title: "Only the owner can launch",
  body: "Only your community's owner can open a site to supporters. Stewards can follow the listing, but the launch is the owner's decision.",
};

export const NO_RATING: Explanation = {
  title: "There's no rating to price from",
  body: "The opening price comes from the site's latest rating report, and this site doesn't have a usable one yet. Re-rate the site, then come back.",
};

export const NOT_FOUND: Explanation = {
  title: "We couldn't find this site",
  body: "It may have been removed, or it belongs to a community you're not part of.",
};

export const SANDBOX_NOTE =
  "Sandbox: play money, not a real security. Supporters get a stake in the rating's sandbox market, never the land.";
