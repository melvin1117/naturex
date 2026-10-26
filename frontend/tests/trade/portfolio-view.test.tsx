import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { PortfolioView } from "@/components/portfolio-view";
import { WorldProvider } from "@/components/world-provider";
import type { OrderOut } from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
import { clearFills, freshFills, noteFill } from "@/lib/trade";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  sequence,
  SIGNED_IN_WORLD,
} from "../lib/helpers";
import { stubMotion } from "../motion";
import { ASSET_ID, cards, holding, portfolio } from "./fixtures";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portfolio",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

type Routes = Parameters<typeof fakeBackend>[0];

function renderPortfolio(routes: Routes = {}) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    "GET /assets": () => json(cards),
    "GET /portfolio": () => json(portfolio()),
    "GET /alerts": () =>
      json({ alerts: [], unread_count: 0, next_before: null }),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <PortfolioView />
    </WorldProvider>,
  );
  return backend;
}

const ME = SIGNED_IN_WORLD.me!.id;

const HELD = portfolio({
  cash_balance: "9799.80",
  holdings: [
    holding({
      shares: 10,
      avg_cost: "20.0200",
      mark_price: "19.8700",
      market_value: "198.70",
      cost_basis: "200.20",
      unrealized_pnl: "-1.50",
      unrealized_pnl_pct: "-0.75",
    }),
  ],
  holdings_value: "198.70",
  total_value: "9998.50",
  cost_basis: "200.20",
  unrealized_pnl: "-1.50",
  unrealized_pnl_pct: "-0.75",
  since_start: "-1.50",
});

/** The wetland's tile among the stakes. */
async function tableRow() {
  return within(await screen.findByRole("list", { name: "Stakes" }))
    .getByRole("link", { name: "Xochimilco Wetland" })
    .closest("li")!;
}

beforeEach(() => {
  FakeEventSource.reset();
  clearFills();
});

describe("PortfolioView", () => {
  it("washes the stake a trade just changed, once (#216 WP2)", async () => {
    noteFill(
      {
        id: "o1",
        asset_id: ASSET_ID,
        side: "buy",
        qty: 4,
        shares_held: 10,
      } as OrderOut,
      ME,
    );
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    const row = await tableRow();
    expect(row).toHaveClass("ww-wash");
    expect(row).toHaveAttribute("data-fresh");
    // Its units land on the API's value (reduced motion in jsdom: at once).
    expect(row).toHaveTextContent("10 units");
    // Shown once: coming back later doesn't replay it.
    await waitFor(() => expect(freshFills(ME).size).toBe(0));
  });

  it("says what changed in text too, for reduced motion (#216 WP2)", async () => {
    const motion = stubMotion({ reduce: true });
    onTestFinished(() => motion.restore());
    noteFill(
      {
        id: "o6",
        asset_id: ASSET_ID,
        side: "sell",
        qty: 40,
        shares_held: 10,
      } as OrderOut,
      ME,
    );
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    const row = await tableRow();
    expect(within(row).getByText("−40 units just now")).toBeVisible();
    expect(row).toHaveTextContent("10 units");
  });

  it("never shows another account's fill", async () => {
    noteFill(
      {
        id: "o7",
        asset_id: ASSET_ID,
        side: "buy",
        qty: 4,
        shares_held: 10,
      } as OrderOut,
      "someone-else",
    );
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    expect(await tableRow()).not.toHaveClass("ww-wash");
    expect(screen.queryByText(/just now/)).not.toBeInTheDocument();
  });

  it("doesn't wash a stake that changed again since the fill", async () => {
    noteFill(
      {
        id: "o2",
        asset_id: ASSET_ID,
        side: "buy",
        qty: 4,
        shares_held: 7,
      } as OrderOut,
      ME,
    );
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    expect(await tableRow()).not.toHaveClass("ww-wash");
  });

  it("shows where the money stands: the total, the stakes and the sandbox balance", async () => {
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    const money = await screen.findByRole("region", {
      name: "Your play money",
    });
    expect(within(money).getByText("Total now").nextSibling).toHaveTextContent(
      "$9,998.50",
    );
    expect(money).toHaveTextContent("−$1.50 since you started with $10,000.00");
    const inStakes = within(money).getByText("In stakes").closest("div")!;
    expect(inStakes).toHaveTextContent("$198.70");
    expect(inStakes).toHaveTextContent("You paid $200.20");
    expect(inStakes).toHaveTextContent("−$1.50 (−0.75%) since you bought");
    const balance = within(money).getByText("Sandbox balance").closest("div")!;
    expect(balance).toHaveTextContent("$9,799.80");
    // No market words: never "invested", "wallet" or "profit" (ux-writing.md).
    expect(document.body).not.toHaveTextContent(
      /invest|wallet|profit|returns|funds|deposit/i,
    );
  });

  it("shows how each stake is doing: paid, worth now and the change", async () => {
    renderPortfolio({
      "GET /portfolio": () => json(HELD),
      "GET /assets": () => json([{ ...cards[0], health_score: "61.4" }]),
    });

    const row = await tableRow();
    expect(row).toHaveTextContent("10 units · $19.87 a unit");
    expect(within(row).getByText("You paid").nextSibling).toHaveTextContent(
      "$200.20",
    );
    expect(within(row).getByText("Worth now").nextSibling).toHaveTextContent(
      "$198.70",
    );
    expect(
      within(row).getByText("Change in value").nextSibling,
    ).toHaveTextContent("−$1.50 (−0.75%)");
    expect(within(row).getByRole("link")).toHaveAttribute(
      "href",
      `/asset/${ASSET_ID}`,
    );
    // The grade on first mention: letter, health score and label.
    expect(
      await within(row).findByRole("img", {
        name: "Grade BBB, health 61.4, Good health",
      }),
    ).toBeInTheDocument();
  });

  it("charts a stake's latest prices against what was paid", async () => {
    renderPortfolio({
      "GET /portfolio": () => json(HELD),
      "GET /assets": () =>
        json([{ ...cards[0], sparkline: ["18.5000", "19.2000", "20.0000"] }]),
    });
    const row = await tableRow();
    expect(
      await within(row).findByRole("img", {
        name: "Xochimilco Wetland: its latest 3 prices, from $18.50 to $20.00 a unit; you paid $20.02 a unit.",
      }),
    ).toBeInTheDocument();
  });

  it("says a stake with one price has no chart yet", async () => {
    renderPortfolio({
      "GET /portfolio": () => json(HELD),
      "GET /assets": () => json([{ ...cards[0], sparkline: ["20.0000"] }]),
    });
    const row = await tableRow();
    expect(
      await within(row).findByText(
        "Its stake price chart starts once it has a few prices.",
      ),
    ).toBeInTheDocument();
  });

  it("says a gain with a sign and an arrow, in the trend's colour", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json({
          ...HELD,
          holdings: [holding()],
          unrealized_pnl: "12.30",
          unrealized_pnl_pct: "2.94",
        }),
    });
    const money = await screen.findByRole("region", {
      name: "Your play money",
    });
    const up = within(money).getByText((_, el) =>
      el?.tagName === "SPAN" ? el.textContent === "up +$12.30 (+2.9%)" : false,
    );
    expect(up).toHaveClass("text-lime-ink");
    expect(up.querySelector("svg")).not.toBeNull();
  });

  it("never rounds a small change to 0.0%", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json({
          ...HELD,
          holdings: [
            holding({ unrealized_pnl: "0.07", unrealized_pnl_pct: "0.03" }),
          ],
        }),
    });
    const row = await tableRow();
    expect(row).toHaveTextContent("+$0.07 (+0.03%)");
  });

  it("says a change under 0.01% as such, without a second sign", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json({
          ...HELD,
          holdings: [
            holding({ unrealized_pnl: "-0.07", unrealized_pnl_pct: "0.00" }),
          ],
        }),
    });
    const row = await tableRow();
    expect(row).toHaveTextContent("\u2212$0.07 (<0.01%)");
  });

  it("says a stake that hasn't moved is level", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json({
          ...HELD,
          holdings: [
            holding({ unrealized_pnl: "0.00", unrealized_pnl_pct: "0.00" }),
          ],
          unrealized_pnl: "0.00",
          unrealized_pnl_pct: "0.00",
        }),
    });
    const row = await tableRow();
    expect(within(row).getByText("No change")).toBeVisible();
  });

  it("writes losses with a true minus sign", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json({
          ...HELD,
          holdings: [holding({ unrealized_pnl: "-1234.50" })],
          unrealized_pnl: "-1234.50",
        }),
    });

    const row = await tableRow();
    expect(row).toHaveTextContent("\u2212$1,234.50");
  });

  it("shows per-unit prices to 4 decimals", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json({
          ...HELD,
          holdings: [holding({ avg_cost: "21.4723", mark_price: "21.5001" })],
        }),
    });

    const row = await tableRow();
    expect(row).toHaveTextContent("$21.5001 a unit");
  });

  it("shows a new listing's boundary map as its thumbnail, with the map credit", async () => {
    const OUTLINE = [
      [-99.1, 19.28],
      [-99.09, 19.28],
      [-99.09, 19.29],
      [-99.1, 19.28],
    ];
    renderPortfolio({
      "GET /portfolio": () => json(HELD),
      "GET /assets": () =>
        json([{ ...cards[0], site_key: null, outline: [OUTLINE] }]),
    });
    const row = await tableRow();
    await waitFor(() =>
      expect(row.querySelector("[data-boundary-map] img")).not.toBeNull(),
    );
    // One credit for every map, under the stakes, not one per tile.
    expect(within(row).queryByText(IMAGERY_ATTRIBUTION)).toBeNull();
    expect(screen.getByText(`Site maps: ${IMAGERY_ATTRIBUTION}`)).toBeVisible();
  });

  it("prefers a new listing's cover photo to its map", async () => {
    const cover = "https://cdn.example.org/covers/wetland.jpg";
    renderPortfolio({
      "GET /portfolio": () => json(HELD),
      "GET /assets": () =>
        json([
          {
            ...cards[0],
            site_key: null,
            cover_image_url: cover,
            outline: [
              [
                [-99.1, 19.28],
                [-99.09, 19.28],
                [-99.09, 19.29],
              ],
            ],
          },
        ]),
    });
    const row = await tableRow();
    expect(row.querySelector(`img[src="${cover}"]`)).not.toBeNull();
    expect(row.querySelector("[data-boundary-map]")).toBeNull();
    expect(screen.queryByText(/Site maps:/)).toBeNull();
  });

  it("keeps the curated thumbnail and no map credit for a demo site", async () => {
    renderPortfolio({ "GET /portfolio": () => json(HELD) });
    const row = await tableRow();
    expect(
      row.querySelector('img[src*="wetland_mx.thumbnail"]'),
    ).not.toBeNull();
    expect(screen.queryByText(/Site maps:/)).toBeNull();
  });

  it("invites a first stake when nothing is held", async () => {
    renderPortfolio();

    const link = await screen.findByRole("link", {
      name: "Back your first site",
    });
    expect(link).toHaveAttribute("href", "/");
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" &&
          el.textContent === "You have $10,000.00 to back living land.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("list", { name: "Stakes" })).toBeNull();
  });

  it("says impact figures aren't available while the API reports none", async () => {
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    expect(
      await screen.findByText(
        "Impact figures for your stakes aren't available yet.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ ha$/)).not.toBeInTheDocument();
  });

  it("lists impact figures from the API", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json({
          ...HELD,
          impact: {
            ha_protected: "0.12",
            t_co2_stored: "3.40",
            services_usd_yr: "56.78",
          },
        }),
    });

    const impact = await screen.findByRole("region", {
      name: "What your stakes keep alive",
    });
    expect(within(impact).getByText("0.12 ha")).toBeInTheDocument();
    expect(within(impact).getByText("3.4 tCO₂")).toBeInTheDocument();
    expect(within(impact).getByText("$56.78 a year")).toBeInTheDocument();
    expect(impact).toHaveTextContent(
      "Attribution only, not a carbon credit or offset.",
    );
  });

  it("never claims a stake has no chart while its site is loading or missing", async () => {
    renderPortfolio({
      "GET /portfolio": () => json(HELD),
      "GET /assets": () => new Promise<Response>(() => {}),
    });
    const row = await tableRow();
    expect(within(row).queryByText(/chart starts/)).toBeNull();
  });

  it("says when a stake has no price yet, and leaves it out of the totals", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json({
          ...HELD,
          holdings: [
            ...HELD.holdings,
            holding({
              asset_id: "44444444-4444-4444-8444-444444444444",
              asset_name: "Río Claro Forest",
              mark_price: null,
              market_value: null,
              unrealized_pnl: null,
              unrealized_pnl_pct: null,
            }),
          ],
        }),
    });
    const money = await screen.findByRole("region", {
      name: "Your play money",
    });
    expect(money).toHaveTextContent(
      "Not counting 1 stake without a price yet.",
    );
    const row = within(screen.getByRole("list", { name: "Stakes" }))
      .getByRole("link", { name: "Río Claro Forest" })
      .closest("li")!;
    expect(within(row).getByText("Worth now").nextSibling).toHaveTextContent(
      "—not priced yet",
    );
  });

  it("still says how it went once every stake is sold", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json(portfolio({ cash_balance: "10012.40", since_start: "12.40" })),
    });
    expect(
      await screen.findByText((_, el) =>
        el?.tagName === "P"
          ? el.textContent === "up +$12.40 since you started with $10,000.00"
          : false,
      ),
    ).toBeVisible();
  });

  it("formats large and tiny impact figures", async () => {
    renderPortfolio({
      "GET /portfolio": () =>
        json({
          ...HELD,
          impact: {
            ha_protected: "1234.5",
            t_co2_stored: "0.03",
            services_usd_yr: "12345.60",
          },
        }),
    });
    const impact = await screen.findByRole("region", {
      name: "What your stakes keep alive",
    });
    expect(within(impact).getByText("1,235 ha")).toBeInTheDocument();
    expect(within(impact).getByText("<0.1 tCO₂")).toBeInTheDocument();
    expect(within(impact).getByText("$12,345.60 a year")).toBeInTheDocument();
  });

  it("explains a failure and retries", async () => {
    const backend = renderPortfolio({
      "GET /portfolio": sequence(
        () => json({ detail: "boom" }, { status: 500 }),
        () => json(portfolio()),
      ),
    });

    expect(
      await screen.findByText("We couldn't load your stakes"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("link", { name: "Back your first site" }),
    ).toBeInTheDocument();
    expect(backend.calls("GET /portfolio")).toBe(2);
  });
});
