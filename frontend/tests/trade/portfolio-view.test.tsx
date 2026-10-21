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
import type { OrderOut } from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import { freshFills, noteFill } from "@/lib/trade";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  sequence,
  SIGNED_IN_WORLD,
} from "../lib/helpers";
import { EVENT_SOURCE, REPORT_SOURCE, sseResponse } from "../copilot/fixtures";
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
  it("washes the stake a trade just changed, once (#216 WP2)", async () => {
    noteFill({
      id: "o1",
      asset_id: ASSET_ID,
      side: "buy",
      qty: 4,
      shares_held: 10,
    } as OrderOut);
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    const row = await tableRow();
    expect(row).toHaveClass("nx-wash");
    expect(row).toHaveAttribute("data-fresh");
    // Its units land on the API's value (reduced motion in jsdom: at once).
    expect(within(row).getByText("10")).toBeInTheDocument();
    const card = screen
      .getByRole("list", { name: "Stakes" })
      .querySelector("li")!;
    expect(card).toHaveClass("nx-wash");
    // Shown once: coming back later doesn't replay it.
    await waitFor(() => expect(freshFills().size).toBe(0));
  });

  it("doesn't wash a stake that changed again since the fill", async () => {
    noteFill({
      id: "o2",
      asset_id: ASSET_ID,
      side: "buy",
      qty: 4,
      shares_held: 7,
    } as OrderOut);
    renderPortfolio({ "GET /portfolio": () => json(HELD) });

    expect(await tableRow()).not.toHaveClass("nx-wash");
  });

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

  it("asks the Copilot across every site, citing each site's report or news (T44)", async () => {
    const FOREST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const forestReport = {
      ...REPORT_SOURCE,
      ref: "R2-2",
      asset_id: FOREST,
      asset_name: "Osa Forest",
    };
    const answer =
      "The wetland faces encroachment [E55555555] and fell [R2]; the forest held steady [R2-2].";
    const backend = renderPortfolio({
      "POST /copilot": () =>
        sseResponse([
          {
            type: "sources",
            sources: [EVENT_SOURCE, REPORT_SOURCE, forestReport],
          },
          { type: "delta", text: answer },
          {
            type: "done",
            answer,
            citations: [EVENT_SOURCE, REPORT_SOURCE, forestReport],
            mode: "model",
            model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
          },
        ]),
    });

    const chat = await screen.findByRole("region", { name: "Ask the Copilot" });
    fireEvent.change(
      within(chat).getByLabelText("Ask the Copilot about every site"),
      { target: { value: "Which sites fell?" } },
    );
    fireEvent.click(
      within(chat).getByRole("button", { name: "Send question" }),
    );

    expect(
      await within(chat).findByRole("link", {
        name: "Source R2-2: Osa Forest · Report v2",
      }),
    ).toHaveAttribute("href", `/asset/${FOREST}?tab=report`);
    expect(
      within(chat).getByRole("link", {
        name: `Source E55555555: Xochimilco wetland · ${EVENT_SOURCE.title}`,
      }),
    ).toHaveAttribute("href", `/asset/${EVENT_SOURCE.asset_id}?tab=news`);
    expect(
      within(chat).getByRole("link", {
        name: /^R2-2\s*Osa Forest · Report v2$/,
      }),
    ).toBeVisible();
    const [request] = backend.requests.filter((r) => r.method === "POST");
    // World-wide: no asset_id, so the backend searches every visible site.
    expect(await request!.json()).toEqual({ question: "Which sites fell?" });
  });

  it("offers world-wide suggestions", async () => {
    renderPortfolio();
    const chat = await screen.findByRole("region", { name: "Ask the Copilot" });
    expect(
      within(chat).getByRole("button", {
        name: "Which sites were downgraded?",
      }),
    ).toBeVisible();
    expect(
      within(chat).queryByRole("button", { name: "What drives this grade?" }),
    ).not.toBeInTheDocument();
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
      screen.getByText("Change in value", { selector: "dt:not(.sr-only)" })
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
      screen.getByText("Change in value", { selector: "dt:not(.sr-only)" })
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

    const list = await screen.findByRole("list", { name: "Stakes" });
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
      within(card).getByText("Change in value").nextSibling,
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
