import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import type { OrderOut, QuoteOut } from "@/lib/api/types";
import {
  assetHref,
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

  it("caps sells at the holding, before any quote, and offers the holding", () => {
    expect(
      orderProblem({ ...base, side: "sell", held: 1, quote: undefined }),
    ).toEqual({ message: "You hold 1 unit of this site.", fix: 1 });
    expect(
      orderProblem({ ...base, side: "sell", held: 0, quote: undefined }),
    ).toEqual({ message: "You hold 0 units of this site.", fix: null });
    expect(orderProblem({ ...base, side: "sell", held: 10 })).toBeNull();
  });

  it("never offers a sell above the size cap", () => {
    expect(
      orderProblem({
        ...base,
        side: "sell",
        units: 50_000,
        held: 20_000,
        quote: undefined,
        limits: { max_qty: 10_000, max_order_qty: 10_000, price: "20.0000" },
      })?.fix,
    ).toBe(10_000);
  });

  it("applies the size cap and the available supply from the quote", () => {
    expect(
      orderProblem({ ...base, quote: quote({ max_order_qty: 5, max_qty: 5 }) }),
    ).toEqual({ message: "One order can be at most 5 units.", fix: 5 });
    expect(orderProblem({ ...base, quote: quote({ max_qty: 3 }) })).toEqual({
      message: "Only 3 units are available to buy right now.",
      fix: 3,
    });
    expect(orderProblem({ ...base, quote: quote({ max_qty: 0 }) })).toEqual({
      message: "No units are available to buy right now.",
      fix: null,
    });
  });

  it("uses a 1-unit quote's limits when the order's own quote was refused", () => {
    const limits = { max_qty: 279, max_order_qty: 10_000, price: "35.7849" };
    expect(
      orderProblem({
        ...base,
        units: 999_999_999,
        quote: undefined,
        limits,
        formatMoney: money,
      }),
    ).toEqual({
      message:
        "One order can be at most 10,000 units. You can buy up to 279 units now.",
      fix: 279,
    });
    // Within the cap but more than the cash covers (the price is only compared).
    expect(
      orderProblem({
        ...base,
        units: 500,
        quote: undefined,
        limits,
        formatMoney: money,
      }),
    ).toEqual({
      message:
        "You have $10,000.00 of play money: enough for up to 279 units now.",
      fix: 279,
    });
    // Cash would cover it: the supply is what's short.
    expect(
      orderProblem({
        ...base,
        units: 200,
        quote: undefined,
        limits: { ...limits, max_qty: 150 },
      }),
    ).toEqual({
      message: "Only 150 units are available to buy right now.",
      fix: 150,
    });
    expect(
      orderProblem({
        ...base,
        units: 2,
        cash: 10,
        quote: undefined,
        limits: { ...limits, max_qty: 0 },
        formatMoney: money,
      }),
    ).toEqual({
      message: "You have $10.00 of play money: not enough for one unit.",
      fix: null,
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

  it("remembers the units before and after a fill, for the next page", () => {
    noteFill(order(), 1_000);
    noteFill(
      order({ id: "o2", asset_id: "b", side: "sell", qty: 4, shares_held: 6 }),
      1_000,
    );
    const fresh = freshFills(2_000);
    expect(fresh.get("a")).toMatchObject({ unitsBefore: 5, unitsAfter: 15 });
    expect(fresh.get("b")).toMatchObject({ unitsBefore: 10, unitsAfter: 6 });
    // A pure read: asking again gives the same answer until the page forgets them.
    expect(freshFills(2_000).size).toBe(2);
    forgetFills(fresh.values());
    expect(freshFills(2_000).size).toBe(0);
  });

  it("lets an old fill go and keeps a newer one", () => {
    noteFill(order(), 0);
    expect(freshFills(FRESH_FILL_MS + 1).size).toBe(0);
    const seen = freshFills(0);
    noteFill(order({ id: "o3" }), 10);
    forgetFills(seen.values());
    expect(freshFills(10).get("a")?.orderId).toBe("o3");
    forgetFills(freshFills(10).values());
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
        new ApiError(403, "Open NatureX from its usual address", "csrf_origin"),
      ).message,
    ).toBe("Open NatureX from its usual address");
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
