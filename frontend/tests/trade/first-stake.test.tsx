import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { announce, opensStake, Receipt } from "@/components/trade-summary";
import type { OrderOut } from "@/lib/api/types";

function order(overrides: Partial<OrderOut> = {}): OrderOut {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    asset_id: "33333333-3333-4333-8333-333333333333",
    side: "buy",
    qty: 10,
    fill_price: "20.0200",
    total: "200.20",
    primary_qty: 0,
    community_amount: "0.00",
    is_primary: false,
    created_at: "2026-10-18T00:00:00Z",
    cash_balance: "9799.80",
    shares_held: 10,
    ...overrides,
  } as OrderOut;
}

describe("a buy that opens a stake (#216)", () => {
  it("is a buy that opened the holding (a first stake, or one after selling out)", () => {
    expect(opensStake(order())).toBe(true);
    expect(opensStake(order({ shares_held: 25 }))).toBe(false);
    expect(opensStake(order({ side: "sell", shares_held: 10 }))).toBe(false);
  });

  it("gets one more line, pointing to Your stakes, and says so to screen readers", () => {
    render(<Receipt order={order()} community="Laguna Viva" />);
    expect(
      screen.getByText(/You now hold a stake in Laguna Viva/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Your stakes" })).toHaveAttribute(
      "href",
      "/portfolio",
    );
    expect(announce(order())).toMatch(/You now hold a stake in this site\.$/);
  });

  it("adding to a stake keeps the plain receipt", () => {
    render(
      <Receipt order={order({ shares_held: 25 })} community="Laguna Viva" />,
    );
    expect(screen.queryByText(/now hold a stake/)).not.toBeInTheDocument();
    expect(announce(order({ shares_held: 25 }))).not.toMatch(
      /now hold a stake/,
    );
  });
});
