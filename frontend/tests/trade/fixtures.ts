/** Backend answers for the trade panel and portfolio tests (shapes from the OpenAPI schema). */
import type {
  AssetCard,
  AssetDetail,
  HoldingOut,
  PortfolioOut,
  QuoteOut,
} from "@/lib/api/types";

import { json } from "../lib/helpers";

export const ASSET_ID = "33333333-3333-4333-8333-333333333333";

export function asset(overrides: Partial<AssetDetail> = {}): AssetDetail {
  return {
    id: ASSET_ID,
    name: "Xochimilco Wetland",
    status: "listed",
    area_ha: "120.00",
    geojson: {},
    total_shares: 1_000_000,
    retained_pct: "51.00",
    primary_shares_remaining: 489_000,
    community_wallet: "0.00",
    site_key: "wetland_mx",
    price: "20.0000",
    trading: true,
    ipo_at: "2026-10-01T00:00:00Z",
    recent_events: [],
    ...overrides,
  } as AssetDetail;
}

export function holding(overrides: Partial<HoldingOut> = {}): HoldingOut {
  return {
    asset_id: ASSET_ID,
    asset_name: "Xochimilco Wetland",
    shares: 5,
    avg_cost: "19.0000",
    mark_price: "20.0000",
    market_value: "100.00",
    cost_basis: "95.00",
    unrealized_pnl: "5.00",
    unrealized_pnl_pct: "5.26",
    ...overrides,
  };
}

export function portfolio(overrides: Partial<PortfolioOut> = {}): PortfolioOut {
  return {
    cash_balance: "10000.00",
    holdings: [],
    holdings_value: "0.00",
    total_value: "10000.00",
    cost_basis: "0.00",
    unrealized_pnl: "0.00",
    unrealized_pnl_pct: null,
    starting_cash: "10000.00",
    since_start: "0.00",
    impact: {
      ha_protected: "0.00",
      t_co2_stored: "0.00",
      services_usd_yr: "0.00",
    },
    ...overrides,
  };
}

/** A quote as the backend writes it; the numbers are canned, never computed by the panel. */
export function quoteFor(
  request: Request,
  overrides: Partial<QuoteOut> = {},
): Response {
  const url = new URL(request.url);
  const side = url.searchParams.get("side") as "buy" | "sell";
  const qty = Number(url.searchParams.get("qty"));
  const body: QuoteOut = {
    asset_id: ASSET_ID,
    side,
    qty,
    price: "20.0000",
    fill_price: side === "buy" ? "20.0200" : "19.9800",
    total: side === "buy" ? "200.20" : "99.90",
    slippage_pct: side === "buy" ? "0.10" : "-0.10",
    primary_qty: side === "buy" ? qty : 0,
    community_amount: side === "buy" ? "200.20" : "0.00",
    max_qty: side === "buy" ? 499 : 5,
    max_order_qty: 10_000,
    ...overrides,
  };
  return json(body);
}

export const cards: AssetCard[] = [
  {
    id: ASSET_ID,
    name: "Xochimilco Wetland",
    status: "listed",
    area_ha: "120.00",
    price: "20.0000",
    grade: "BBB",
    site_key: "wetland_mx",
  } as AssetCard,
];
