import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import type { OrderOut, QuoteOut } from "@/lib/api/types";
import {
  assetHref,
  clearFills,
  decimal,
  forgetFills,
  FRESH_FILL_MS,
  freshFills,
  money,
  noteFill,
  orderFailure,
  orderProblem,
  parseUnits,
  signedMoneyText,
  tradeBlockedMessage,
  unitPrice,
  unitsInput,
} from "@/lib/trade";
import { price } from "@/lib/prototype/format";

const quote = (overrides: Partial<QuoteOut> = {}): QuoteOut => ({
  asset_id: "a",
  side: "buy",
  qty: 10,
  price: "20.0000",
  fill_price: "20.0200",
  total: "200.20",
  slippage_pct: "0.10",
  primary_qty: 10,
  community_amount: "200.20",
  max_qty: 499,
  max_order_qty: 10_000,
  ...overrides,
});

const base = {
  side: "buy" as const,
  units: 10,
  held: 0,
  cash: 10_000,
  quote: quote(),
  formatMoney: price,
};

describe("units input", () => {
  it.each([
    ["12", "12"],
    ["1.5", "15"],
    ["-3", "3"],
    ["007", "7"],
    ["1e3", "13"],
    ["", ""],
    ["1234567890123", "123456789"],
  ])("keeps %j as %j", (typed, kept) => {
    expect(unitsInput(typed)).toBe(kept);
  });

  it.each([
    ["10", 10],
    ["0", null],
    ["", null],
    ["1.5", null],
    ["abc", null],
  ])("parses %j as %j", (text, units) => {
    expect(parseUnits(text)).toBe(units);
  });

  it("reads API decimals for display only", () => {
    expect(decimal("21.4723")).toBe(21.4723);
    expect(decimal(null)).toBeNull();
    expect(decimal("nope")).toBeNull();
  });
});

describe("orderProblem", () => {
  const message = (args: Parameters<typeof orderProblem>[0]) =>
    orderProblem(args)?.message ?? null;

  it("accepts an affordable buy", () => {
    expect(orderProblem(base)).toBeNull();
  });

  it("needs a positive whole number", () => {
    expect(orderProblem({ ...base, units: null })).toEqual({
      message: expect.stringMatching(/whole number/),
      fix: null,
    });
  });

  it("compares the quote's total with the cash, in play money", () => {
    expect(message({ ...base, cash: 200.19 })).toBe(
      "You have $200.19 of play money. This needs $200.20.",
    );
    expect(orderProblem({ ...base, cash: 200.2 })).toBeNull();
  });

  it("says how many units the cash covers and offers them, from the API's max_qty", () => {
    expect(
      orderProblem({
        ...base,
        units: 300,
        cash: 10_000,
        quote: quote({ qty: 300, total: "10735.47", max_qty: 279 }),
        formatMoney: money,
      }),
    ).toEqual({
      message:
        "You have $10,000.00 of play money. This needs $10,735.47. You can buy up to 279 units now.",
      fix: 279,
    });
  });

  it("offers no fix when no unit would go through", () => {
    expect(
      orderProblem({ ...base, cash: 5, quote: quote({ max_qty: 0 }) }),
    ).toEqual({
      message: "You have $5.00 of play money. This needs $200.20.",
      fix: null,
    });
  });

  it("caps sells at the holding, before any quote, and offers the holding once quoted", () => {
    expect(
      orderProblem({ ...base, side: "sell", held: 1, quote: undefined }),
    ).toEqual({ message: "You hold 1 unit of this site.", fix: null });
    expect(
      orderProblem({
        ...base,
        side: "sell",
        held: 1,
        quote: quote({ side: "sell", max_qty: 1 }),
      }),
    ).toEqual({ message: "You hold 1 unit of this site.", fix: 1 });
    expect(
      orderProblem({ ...base, side: "sell", held: 0, quote: undefined }),
    ).toEqual({ message: "You hold 0 units of this site.", fix: null });
    expect(orderProblem({ ...base, side: "sell", held: 10 })).toBeNull();
  });

  it("never offers a sell above the size cap", () => {
    // The 1-unit sell quote says how much this account can sell now.
    const oneUnit = quote({
      side: "sell",
      qty: 1,
      total: "19.98",
      max_qty: 10_000,
      max_order_qty: 10_000,
    });
    expect(
      orderProblem({
        ...base,
        side: "sell",
        units: 50_000,
        held: 20_000,
        quote: undefined,
        oneUnit,
      }),
    ).toEqual({ message: "You hold 20,000 units of this site.", fix: 10_000 });
  });

  it("offers no sell fix before the API has said how large an order may be", () => {
    // No quote yet, and a holding above any cap the panel could know: offering it all could
    // be refused, so only the message shows until a quote arrives.
    expect(
      orderProblem({
        ...base,
        side: "sell",
        units: 50_000,
        held: 20_000,
        quote: undefined,
      }),
    ).toEqual({ message: "You hold 20,000 units of this site.", fix: null });
  });

  describe("when the quote for these units was refused (its size)", () => {
    const oneUnit = quote({
      qty: 1,
      total: "35.79",
      max_qty: 279,
      max_order_qty: 10_000,
    });

    it("names the size cap and what would go through", () => {
      expect(
        orderProblem({
          ...base,
          units: 999_999_999,
          quote: undefined,
          oneUnit,
          formatMoney: money,
        }),
      ).toEqual({
        message:
          "One order can be at most 10,000 units. You can buy up to 279 units now.",
        fix: 279,
      });
    });

    it("says only what the API said, never which limit binds", () => {
      expect(
        orderProblem({ ...base, units: 500, quote: undefined, oneUnit }),
      ).toEqual({ message: "You can buy up to 279 units now.", fix: 279 });
      expect(
        orderProblem({
          ...base,
          side: "sell",
          units: 50,
          held: 80,
          quote: undefined,
          oneUnit: { ...oneUnit, side: "sell", max_qty: 40 },
        }),
      ).toEqual({ message: "You can sell up to 40 units now.", fix: 40 });
    });

    it("compares the cash with what one unit costs, from the 1-unit quote", () => {
      expect(
        orderProblem({
          ...base,
          units: 2,
          cash: 10,
          quote: undefined,
          oneUnit: { ...oneUnit, max_qty: 0 },
          formatMoney: money,
        }),
      ).toEqual({
        message: "You have $10.00 of play money: not enough for one unit.",
        fix: null,
      });
      // Enough for one unit, yet none would go through: no claim about why.
      expect(
        orderProblem({
          ...base,
          units: 2,
          cash: 100,
          quote: undefined,
          oneUnit: { ...oneUnit, max_qty: 0 },
        }),
      ).toEqual({ message: "You can't buy any units right now.", fix: null });
    });
  });
});

describe("fresh fills", () => {
  const order = (overrides: Partial<OrderOut> = {}): OrderOut => ({
    id: "o1",
    asset_id: "a",
    side: "buy",
    qty: 10,
    fill_price: "20.0200",
    total: "200.20",
    primary_qty: 10,
    community_amount: "200.20",
    is_primary: true,
    created_at: "2026-10-18T00:00:00Z",
    cash_balance: "9799.80",
    shares_held: 15,
    ...overrides,
  });

  afterEach(() => clearFills());

  it("remembers the units before and after a fill, for the next page", () => {
    noteFill(order(), "me", 1_000);
    noteFill(
      order({ id: "o2", asset_id: "b", side: "sell", qty: 4, shares_held: 6 }),
      "me",
      1_000,
    );
    const fresh = freshFills("me", 2_000);
    expect(fresh.get("a")).toMatchObject({ unitsBefore: 5, unitsAfter: 15 });
    expect(fresh.get("b")).toMatchObject({ unitsBefore: 10, unitsAfter: 6 });
    // A pure read: asking again gives the same answer until the page forgets them.
    expect(freshFills("me", 2_000).size).toBe(2);
    forgetFills(fresh.values());
    expect(freshFills("me", 2_000).size).toBe(0);
  });

  it("lets an old fill go and keeps a newer one", () => {
    noteFill(order(), "me", 0);
    expect(freshFills("me", FRESH_FILL_MS + 1).size).toBe(0);
    const seen = freshFills("me", 0);
    noteFill(order({ id: "o3" }), "me", 10);
    forgetFills(seen.values());
    expect(freshFills("me", 10).get("a")?.orderId).toBe("o3");
  });

  it("prunes expired fills when noting a new one", () => {
    noteFill(order(), "me", 0);
    noteFill(order({ id: "o4", asset_id: "b" }), "me", FRESH_FILL_MS + 5);
    forgetFills([{ orderId: "o4", unitsBefore: 0, unitsAfter: 0, at: 0 }]);
    // Only the expired one was left, and noting o4 already dropped it.
    expect(freshFills("me", 0).size).toBe(0);
  });

  it("never shows one account's fills to another, or after the session ends", () => {
    noteFill(order(), "me", 0);
    expect(freshFills("someone-else", 0).size).toBe(0);
    expect(freshFills(null, 0).size).toBe(0);
    noteFill(order({ id: "o5", asset_id: "b" }), "someone-else", 0);
    expect(freshFills("me", 0).size).toBe(0);
    expect(freshFills("someone-else", 0).size).toBe(1);
    clearFills();
    expect(freshFills("someone-else", 0).size).toBe(0);
  });
});

describe("orderFailure", () => {
  it("marks unknown outcomes so the user checks before retrying", () => {
    expect(orderFailure(new ApiError(0, "offline")).uncertain).toBe(true);
    expect(orderFailure(new ApiError(503, "busy")).uncertain).toBe(true);
    expect(orderFailure(new ApiError(0, "offline"), { order: false })).toEqual({
      message: "offline",
    });
  });

  it("says a refused order changed nothing, never a refused quote", () => {
    const tooBig = new ApiError(400, "x", "order_too_large");
    expect(orderFailure(tooBig)).toEqual({
      message: "That's more units than one order can take. Nothing was traded.",
      units: true,
    });
    expect(orderFailure(tooBig, { order: false }).message).toBe(
      "That's more units than one order can take.",
    );
    expect(
      orderFailure(new ApiError(409, "x", "insufficient_cash")).message,
    ).not.toMatch(/Try fewer units/);
  });

  it("offers sign-in for an ended session", () => {
    expect(orderFailure(new ApiError(401, "x", "auth_required")).signIn).toBe(
      true,
    );
  });

  it("keeps a coded 403's own message", () => {
    expect(
      orderFailure(
        new ApiError(
          403,
          "Open WildWorth from its usual address",
          "csrf_origin",
        ),
      ).message,
    ).toBe("Open WildWorth from its usual address");
    expect(orderFailure(new ApiError(403, "x")).message).toBe(
      "Your account can't trade this site.",
    );
  });

  it("explains a trade block the same way for a quote and a refused order", () => {
    for (const reason of [
      "insider_trading_blocked",
      "admins_cannot_trade",
      "treasury_cannot_act",
    ] as const) {
      expect(orderFailure(new ApiError(403, "x", reason)).message).toBe(
        tradeBlockedMessage(reason),
      );
    }
    expect(tradeBlockedMessage("treasury_cannot_act")).toMatch(/can't trade/);
  });
});

describe("formatting", () => {
  it("shows per-unit prices to 4 decimals and money to cents", () => {
    expect(unitPrice(21.4723)).toBe("$21.4723");
    expect(unitPrice(20)).toBe("$20.00");
    expect(unitPrice(19.98)).toBe("$19.98");
    expect(money(1234.5)).toBe("$1,234.50");
  });

  it("spells out the sign of an amount with a true minus", () => {
    expect(signedMoneyText("-1.50")).toBe("\u2212$1.50");
    expect(signedMoneyText("12.34")).toBe("+$12.34");
    expect(signedMoneyText("0.00")).toBe("$0.00");
    expect(signedMoneyText(null)).toBe("—");
  });
});

describe("assetHref", () => {
  it("points at the real asset page", () => {
    expect(assetHref("a b")).toBe("/asset/a%20b");
  });
});
