import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import type { QuoteOut } from "@/lib/api/types";
import {
  assetHref,
  decimal,
  money,
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
  it("accepts an affordable buy", () => {
    expect(orderProblem(base)).toBeNull();
  });

  it("needs a positive whole number", () => {
    expect(orderProblem({ ...base, units: null })).toMatch(/whole number/);
  });

  it("compares the quote's total with the cash", () => {
    expect(orderProblem({ ...base, cash: 200.19 })).toBe(
      "That costs $200.20; you have $200.19 available.",
    );
    expect(orderProblem({ ...base, cash: 200.2 })).toBeNull();
  });

  it("caps sells at the holding, before any quote", () => {
    expect(
      orderProblem({ ...base, side: "sell", held: 1, quote: undefined }),
    ).toBe("You hold 1 unit of this site.");
    expect(orderProblem({ ...base, side: "sell", held: 10 })).toBeNull();
  });

  it("applies the size cap and the available supply from the quote", () => {
    expect(orderProblem({ ...base, quote: quote({ max_order_qty: 5 }) })).toBe(
      "One order can be at most 5 units.",
    );
    expect(orderProblem({ ...base, quote: quote({ max_qty: 3 }) })).toBe(
      "Only 3 units are available to buy right now.",
    );
    expect(orderProblem({ ...base, quote: quote({ max_qty: 0 }) })).toBe(
      "No units are available to buy right now.",
    );
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
