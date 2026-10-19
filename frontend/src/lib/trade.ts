/**
 * Trade panel and portfolio helpers (T18). Every amount comes from the API; these only parse
 * its decimal strings for display and comparison, validate what the user typed, and turn
 * order failures into messages. Nothing here prices an order.
 */
import { formatWait, type ApiError } from "./api/errors";
import type { QuoteOut } from "./api/types";

export type Side = "buy" | "sell";

/** An API decimal (a string like "21.4723") as a number for display; null if missing. */
export function decimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Money: "$1,234.56". */
export function money(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Per-unit prices keep the API's 4 decimals where they matter: "$21.4744", "$20.00". */
export function unitPrice(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

/** An API decimal string as money, "—" when missing. */
export function moneyText(value: string | null | undefined): string {
  const n = decimal(value);
  return n === null ? "—" : money(n);
}

/** An API decimal string as a per-unit price, "—" when missing. */
export function unitPriceText(value: string | null | undefined): string {
  const n = decimal(value);
  return n === null ? "—" : unitPrice(n);
}

/** "+$12.34", "−$5.00" or "$0.00": the API's signed amount with its sign spelt out. */
export function signedMoneyText(value: string | null | undefined): string {
  const n = decimal(value);
  if (n === null) return "—";
  if (n === 0) return money(0);
  return `${n > 0 ? "+" : "−"}${money(Math.abs(n))}`;
}

/**
 * Where an asset's page is. Until T22's asset page (`/asset/<id>`) is merged, real assets are
 * traded on `/dev/trade`; switching this one line is part of the T22 integration.
 */
export function assetHref(assetId: string): string {
  return `/dev/trade?asset=${encodeURIComponent(assetId)}`;
}

/** Keep what can be part of a whole number of units: digits only. */
export function unitsInput(text: string): string {
  return text
    .replace(/\D/g, "")
    .replace(/^0+(?=\d)/, "")
    .slice(0, 9);
}

/** The typed units as a positive whole number, or null. */
export function parseUnits(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const units = Number(text);
  return Number.isSafeInteger(units) && units > 0 ? units : null;
}

export const UNITS_HINT = "Enter a whole number of units, 1 or more.";

/**
 * Why this order can't be placed, or null. Uses the backend's quote (cost, size cap, the
 * largest order this account can place) and the portfolio (cash, units held).
 */
export function orderProblem({
  side,
  units,
  held,
  cash,
  quote,
  formatMoney,
}: {
  side: Side;
  units: number | null;
  held: number;
  cash: number | null;
  quote: QuoteOut | undefined;
  formatMoney: (value: number) => string;
}): string | null {
  if (units === null) return UNITS_HINT;
  if (side === "sell" && units > held)
    return `You hold ${held.toLocaleString("en-US")} ${held === 1 ? "unit" : "units"} of this site.`;
  if (!quote) return null;
  if (units > quote.max_order_qty)
    return `One order can be at most ${quote.max_order_qty.toLocaleString("en-US")} units.`;
  const total = decimal(quote.total);
  if (side === "buy" && total !== null && cash !== null && total > cash)
    return `That costs ${formatMoney(total)}; you have ${formatMoney(cash)} available.`;
  if (
    side === "buy" &&
    quote.max_qty !== null &&
    quote.max_qty !== undefined &&
    units > quote.max_qty
  )
    return quote.max_qty === 0
      ? "No units are available to buy right now."
      : `Only ${quote.max_qty.toLocaleString("en-US")} units are available to buy right now.`;
  return null;
}

export type OrderFailure = {
  message: string;
  /** The session is gone: offer a sign-in link. */
  signIn?: boolean;
  /** The order may have filled (no answer, or a server error): check before retrying. */
  uncertain?: boolean;
};

/** A failed quote or order as a message for the trade panel (every status the API returns). */
export function orderFailure(
  error: ApiError,
  { order = true } = {},
): OrderFailure {
  switch (error.code) {
    case "auth_required":
      return {
        message: "Your session has ended. Sign in again to trade.",
        signIn: true,
      };
    case "insider_trading_blocked":
      return {
        message:
          "Members of this site's community can't trade its units. Your community earns from its retained stake instead.",
      };
    case "admins_cannot_trade":
      return {
        message:
          "Admin accounts can't trade. Use a separate investor account to back sites.",
      };
    case "not_trading":
      return {
        message:
          "Trading on this site hasn't opened yet: its community hasn't launched the opening offer.",
      };
    case "insufficient_cash":
      return {
        message:
          "You don't have enough play money for this order now. Try fewer units.",
      };
    case "insufficient_shares":
      return { message: "You can't sell more units than you hold." };
    case "insufficient_supply":
      return {
        message:
          "Not enough units are available to buy right now. Try fewer units.",
      };
    case "order_too_large":
      return { message: "That order is too large. Try fewer units." };
    case "price_moved":
      return {
        message:
          "The price moved since your quote, so nothing was traded. Check the new total and confirm again.",
      };
  }
  if (error.isNetworkError || error.status >= 500) {
    return order
      ? {
          message:
            "We couldn't confirm your order. Check your stakes before trying again: it may have gone through.",
          uncertain: true,
        }
      : { message: error.message };
  }
  switch (error.status) {
    case 401:
      return {
        message: "Your session has ended. Sign in again to trade.",
        signIn: true,
      };
    case 403:
      // csrf_origin and other coded 403s already have a specific message.
      return {
        message: error.code
          ? error.message
          : "Your account can't trade this site.",
      };
    case 404:
      return {
        message: "This site isn't available any more. Refresh the page.",
      };
    case 409:
      return {
        message:
          "This site isn't open for trading right now. Refresh to see its status.",
      };
    case 422:
      return { message: UNITS_HINT };
    case 429:
      return {
        message: `Too many requests. Try again in ${
          error.retryAfterSeconds === null
            ? "a moment"
            : formatWait(error.retryAfterSeconds)
        }.`,
      };
    default:
      return { message: error.message };
  }
}
