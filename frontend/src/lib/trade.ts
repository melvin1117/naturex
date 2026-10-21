/**
 * Trade panel and portfolio helpers (T18). Every amount comes from the API; these only parse
 * its decimal strings for display and comparison, validate what the user typed, and turn
 * order failures into messages. Nothing here prices an order.
 */
import { formatWait, type ApiError } from "./api/errors";
import type { OrderOut, QuoteOut } from "./api/types";

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

/** Where a real asset's page is (T23): its report, charts, ledger and the trade panel. */
export function assetHref(assetId: string): string {
  return `/asset/${encodeURIComponent(assetId)}`;
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

/** Why an order can't be placed, and the units that would go through instead. */
export type OrderProblem = {
  message: string;
  /**
   * The one-tap fix: the largest order the API says would go through now (`max_qty`, or the
   * units held for a sell, capped at the order size limit). Null when no smaller order would
   * (nothing to sell, no cash), or when the API hasn't said how large an order may be.
   */
  fix: number | null;
};

const unitCount = (n: number) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? "unit" : "units"}`;

/**
 * Why this order can't be placed, or null, with a fix when fewer units would do (#216 WP2).
 * Uses the backend's quote for exactly these units (cost, size cap, the largest order this
 * account can place) and the portfolio (cash, units held). A quote is refused only for its
 * size (`order_too_large`); then `oneUnit` is a 1-unit quote for the same side: its `max_qty`
 * and `max_order_qty` don't depend on the size asked for, and its `total` is what one unit
 * costs. Every number shown is the API's; nothing is priced or estimated here.
 */
export function orderProblem({
  side,
  units,
  held,
  cash,
  quote,
  oneUnit,
  formatMoney,
}: {
  side: Side;
  units: number | null;
  held: number;
  cash: number | null;
  /** The quote for exactly `units`. */
  quote: QuoteOut | undefined;
  /** A 1-unit quote, asked for only when the quote for `units` was refused. */
  oneUnit?: QuoteOut | undefined;
  formatMoney: (value: number) => string;
}): OrderProblem | null {
  if (units === null) return { message: UNITS_HINT, fix: null };
  const limits = quote ?? oneUnit;
  const max = limits?.max_qty ?? null;
  // Fewer units that would go through now; never the same or more than what's typed.
  const fixFor = (n: number | null) =>
    n !== null && n > 0 && n < units ? n : null;
  const upTo =
    max !== null && max > 0 && max < units
      ? ` You can ${side} up to ${unitCount(max)} now.`
      : "";
  if (side === "sell" && units > held) {
    // Only an amount the API would take: the holding, within the size cap it reported.
    const cap = limits ? (max ?? Math.min(held, limits.max_order_qty)) : null;
    return {
      message: `You hold ${unitCount(held)} of this site.`,
      fix: fixFor(cap === null ? null : Math.min(cap, held)),
    };
  }
  if (limits && units > limits.max_order_qty)
    return {
      message: `One order can be at most ${unitCount(limits.max_order_qty)}.${
        max !== null && max < limits.max_order_qty ? upTo : ""
      }`,
      fix: fixFor(max ?? limits.max_order_qty),
    };
  const total = decimal(quote?.total);
  if (side === "buy" && total !== null && cash !== null && total > cash)
    return {
      message: `You have ${formatMoney(cash)} of play money. This needs ${formatMoney(total)}.${upTo}`,
      fix: fixFor(max),
    };
  if (max === null || units <= max) return null;
  if (!quote) {
    // No quote for these units: say only what the API said, never which limit binds.
    const oneUnitTotal = decimal(oneUnit?.total);
    if (max === 0)
      return {
        message:
          side === "buy" &&
          cash !== null &&
          oneUnitTotal !== null &&
          cash < oneUnitTotal
            ? `You have ${formatMoney(cash)} of play money: not enough for one unit.`
            : `You can't ${side} any units right now.`,
        fix: null,
      };
    return {
      message: `You can ${side} up to ${unitCount(max)} now.`,
      fix: fixFor(max),
    };
  }
  // The quote for these units fits the cash (checked above), so the supply is what's short.
  if (side === "buy")
    return max === 0
      ? { message: "No units are available to buy right now.", fix: null }
      : {
          message: `Only ${unitCount(max)} are available to buy right now.`,
          fix: fixFor(max),
        };
  return {
    message: `You can sell up to ${unitCount(max)} now.`,
    fix: fixFor(max),
  };
}

export type OrderFailure = {
  message: string;
  /** The session is gone: offer a sign-in link. */
  signIn?: boolean;
  /** The order may have filled (no answer, or a server error): check before retrying. */
  uncertain?: boolean;
  /** Fewer units would do: the message describes the units field. */
  units?: boolean;
};

type TradeBlockedReason = NonNullable<QuoteOut["trade_blocked_reason"]>;

const TRADE_BLOCKED: Record<TradeBlockedReason, string> = {
  insider_trading_blocked:
    "Members of this site's community can't trade its units. Your community earns from its retained stake instead.",
  admins_cannot_trade:
    "Admin accounts can't trade. Use a separate investor account to back sites.",
  treasury_cannot_act: "Community treasury accounts can't trade.",
};

/** Why this account can't trade the asset at all: a quote's `trade_blocked_reason`, or the
 * same code on a refused order (T57). */
export function tradeBlockedMessage(reason: TradeBlockedReason): string {
  return TRADE_BLOCKED[reason];
}

/** A failed quote or order as a message for the trade panel (every status the API returns). */
export function orderFailure(
  error: ApiError,
  { order = true } = {},
): OrderFailure {
  // A refused order changed nothing; a refused quote never could.
  const untraded = order ? " Nothing was traded." : "";
  switch (error.code) {
    case "auth_required":
      return {
        message: "Your session has ended. Sign in again to trade.",
        signIn: true,
      };
    case "insider_trading_blocked":
    case "admins_cannot_trade":
    case "treasury_cannot_act":
      return { message: tradeBlockedMessage(error.code) };
    case "not_trading":
      return {
        message:
          "This site isn't trading yet: its community hasn't launched the opening offer, or trading was just paused. Refresh to see its status.",
      };
    case "insufficient_cash":
      return {
        message:
          "You don't have enough play money for this order now." + untraded,
        units: true,
      };
    case "insufficient_shares":
      return {
        message: "You can't sell more units than you hold." + untraded,
        units: true,
      };
    case "insufficient_supply":
      return {
        message: "Not enough units are available to buy right now." + untraded,
        units: true,
      };
    case "order_too_large":
      return {
        message: "That's more units than one order can take." + untraded,
        units: true,
      };
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
      return { message: UNITS_HINT, units: true };
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

/**
 * Fills made in this tab, so the next page the user opens can show what changed (#216 WP2):
 * the portfolio washes the stake's row and counts its units from before the fill. In memory
 * only, and per account: a reload starts fresh, a fill older than `FRESH_FILL_MS` is old news,
 * and another account (a sign-out, a persona switch) never sees this one's fills.
 */
export const FRESH_FILL_MS = 60_000;

export type FreshFill = {
  orderId: string;
  /** Units held right before the fill (the order's `shares_held` minus or plus its `qty`). */
  unitsBefore: number;
  unitsAfter: number;
  at: number;
};

let fillsAccount: string | null = null;
const fills = new Map<string, FreshFill>();

/** Keep only `account`'s fills that are still fresh. */
function prune(account: string, now: number): void {
  if (fillsAccount !== account) {
    fills.clear();
    fillsAccount = account;
  }
  for (const [assetId, fill] of fills)
    if (now - fill.at > FRESH_FILL_MS) fills.delete(assetId);
}

/** Note `account`'s fill (after `POST /orders` answered): its asset's latest one wins. */
export function noteFill(
  order: OrderOut,
  account: string,
  now = Date.now(),
): void {
  prune(account, now);
  const delta = order.side === "buy" ? order.qty : -order.qty;
  fills.set(order.asset_id, {
    orderId: order.id,
    unitsBefore: order.shares_held - delta,
    unitsAfter: order.shares_held,
    at: now,
  });
}

/** `account`'s fresh fills by asset id (a pure read: call it while rendering). */
export function freshFills(
  account: string | null | undefined,
  now = Date.now(),
): Map<string, FreshFill> {
  if (!account || account !== fillsAccount) return new Map();
  return new Map(
    [...fills].filter(([, fill]) => now - fill.at <= FRESH_FILL_MS),
  );
}

/**
 * Forget fills once a page has shown them (call it from an effect), so coming back later
 * doesn't replay the highlight. A fill made since then, with a new order id, is kept.
 */
export function forgetFills(shown: Iterable<FreshFill>): void {
  const ids = new Set([...shown].map((fill) => fill.orderId));
  for (const [assetId, fill] of fills)
    if (ids.has(fill.orderId)) fills.delete(assetId);
}

/** Forget every fill (the session ended). */
export function clearFills(): void {
  fills.clear();
  fillsAccount = null;
}
