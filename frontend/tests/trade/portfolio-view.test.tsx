import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioView } from "@/components/portfolio-view";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  sequence,
  SIGNED_IN_WORLD,
} from "../lib/helpers";
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
      <PortfolioView name="Rosa" />
    </WorldProvider>,
  );
  return backend;
}

const HELD = portfolio({
  cash_balance: "9799.80",
  holdings: [
    holding({
      shares: 10,
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

/** The wetland's row in the wide-screen table (phones get the card list instead). */
async function tableRow() {
  return within(await screen.findByRole("table"))
    .getByRole("link", { name: "Xochimilco Wetland" })
    .closest("tr")!;
}

beforeEach(() => FakeEventSource.reset());

describe("PortfolioView", () => {
  it("shows my alerts next to my stakes (T75)", async () => {
    renderPortfolio({
      "GET /alerts": () =>
        json({
          alerts: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              asset_id: ASSET_ID,
              asset_name: "Xochimilco Wetland",
              kind: "health_change",
              title: "Xochimilco Wetland: health fell 6.0 points",
              message: "Health 76.2 → 70.2 (−6.0 points).",
              severity: 3,
              url: null,
              report_id: null,
              created_at: "2026-10-19T08:00:00Z",
              read_at: null,
            },
          ],
          unread_count: 1,
          next_before: null,
        }),
    });

    const alerts = await screen.findByRole("list", { name: "Alerts" });
    expect(
      within(alerts).getByText("Xochimilco Wetland: health fell 6.0 points"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeVisible();
  });

  it("shows cash, totals and each holding exactly as the API sends them", async () => {
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    const row = await tableRow();
    expect(
      screen.getByText("Play money available").nextSibling,
    ).toHaveTextContent("$9,799.80");
    expect(screen.getByText("Value of stakes").nextSibling).toHaveTextContent(
      "$198.70",
    );
    expect(screen.getByText("Total").nextSibling).toHaveTextContent(
      "$9,998.50",
    );
    expect(screen.getByText("Total").parentElement).toHaveTextContent(
      "−$1.50 since you started with $10,000.00",
    );
    expect(
      screen.getByText("Unrealised profit and loss", { selector: "div" })
        .nextSibling,
    ).toHaveTextContent("−$1.50");
    const cells = within(row)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells.slice(2)).toEqual([
      "10",
      "$19.00",
      "$20.00",
      "$100.00",
      "−$1.50down −0.8%",
    ]);
    expect(within(row).getByRole("link")).toHaveAttribute(
      "href",
      `/asset/${ASSET_ID}`,
    );
    await waitFor(() =>
      expect(within(row).getByText("BBB")).toBeInTheDocument(),
    );
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
    expect(
      screen.getByText("Unrealised profit and loss", { selector: "div" })
        .nextSibling,
    ).toHaveTextContent(/^\u2212\$1,234\.50$/);
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
    expect(row).toHaveTextContent("$21.4723");
    expect(row).toHaveTextContent("$21.5001");
  });

  it("lists a card per holding on phones with its value and P&L", async () => {
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    const list = await screen.findByRole("list", { name: "Holdings" });
    // CSS shows the list below `sm` and the table from `sm` up.
    expect(list).toHaveClass("sm:hidden");
    expect(screen.getByRole("table").parentElement?.parentElement).toHaveClass(
      "hidden",
      "sm:block",
    );
    const card = within(list).getByRole("listitem");
    expect(within(card).getByRole("link")).toHaveAttribute(
      "href",
      `/asset/${ASSET_ID}`,
    );
    expect(card).toHaveTextContent("10 units · $20.00");
    expect(within(card).getByText("Value").nextSibling).toHaveTextContent(
      "$100.00",
    );
    expect(
      within(card).getByText("Unrealised profit and loss").nextSibling,
    ).toHaveTextContent("−$1.50");
  });

  it("invites a first stake when nothing is held", async () => {
    renderPortfolio();

    const link = await screen.findByRole("link", {
      name: "Back your first site",
    });
    expect(link).toHaveAttribute("href", "/");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
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

    expect(await screen.findByText("0.12 ha")).toBeInTheDocument();
    expect(screen.getByText("3.4 tCO₂")).toBeInTheDocument();
    expect(screen.getByText("$56.78/yr")).toBeInTheDocument();
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
