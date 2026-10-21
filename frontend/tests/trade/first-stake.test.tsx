import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { announce, isFirstStake, Receipt } from "@/components/trade-summary";
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

describe("the first stake (#216)", () => {
  it("is a buy that opened the holding", () => {
    expect(isFirstStake(order())).toBe(true);
    expect(isFirstStake(order({ shares_held: 25 }))).toBe(false);
    expect(isFirstStake(order({ side: "sell", shares_held: 10 }))).toBe(false);
  });

  it("gets one more line, pointing to Your stakes, and says so to screen readers", () => {
    render(<Receipt order={order()} community="Laguna Viva" />);
    expect(screen.getByText(/Your first stake in Laguna Viva/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Your stakes" })).toHaveAttribute(
      "href",
      "/portfolio",
    );
    expect(announce(order())).toMatch(/Your first stake in this site\.$/);
  });

  it("a later stake keeps the plain receipt", () => {
    render(
      <Receipt order={order({ shares_held: 25 })} community="Laguna Viva" />,
    );
    expect(screen.queryByText(/first stake/)).not.toBeInTheDocument();
    expect(announce(order({ shares_held: 25 }))).not.toMatch(/first stake/);
  });
});
