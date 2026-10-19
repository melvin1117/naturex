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
});

beforeEach(() => FakeEventSource.reset());

describe("PortfolioView", () => {
  it("shows cash, totals and each holding exactly as the API sends them", async () => {
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    const row = (
      await screen.findByRole("link", { name: "Xochimilco Wetland" })
    ).closest("tr")!;
    expect(
      screen.getByText("Play money available").nextSibling,
    ).toHaveTextContent("$9,799.80");
    expect(screen.getByText("Value of stakes").nextSibling).toHaveTextContent(
      "$198.70",
    );
    expect(screen.getByText("Total").nextSibling).toHaveTextContent(
      "$9,998.50",
    );
    expect(
      screen.getByText("Total profit and loss").nextSibling,
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
