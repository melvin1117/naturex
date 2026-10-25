import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Marketplace } from "@/components/proto/marketplace";
import type { AssetCard } from "@/lib/api/types";

import { FakeEventSource, json, sequence } from "../lib/helpers";
import cards from "./fixtures/assets.json";
import { renderExchange, stubBrowserApis } from "./render";

// Like Next.js, useSearchParams follows window.history.replaceState.
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const listeners = new Set<() => void>();
  const replaceState = window.history.replaceState.bind(window.history);
  window.history.replaceState = (...args) => {
    replaceState(...args);
    listeners.forEach((listener) => listener());
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
    usePathname: () => "/",
    useSearchParams: () =>
      new URLSearchParams(
        useSyncExternalStore(subscribe, () => window.location.search),
      ),
  };
});

const CARDS = cards as AssetCard[];
const WETLAND = CARDS.find((c) => c.site_key === "wetland_mx")!;

beforeAll(stubBrowserApis);
beforeEach(() => {
  FakeEventSource.reset();
  window.history.replaceState(null, "", "/");
});

function grid() {
  return screen.getByRole("region", { name: "All sites" });
}

describe("Marketplace", () => {
  it("shows a loading state until the cards arrive", async () => {
    renderExchange(<Marketplace />, {
      "GET /assets": () => new Promise<Response>(() => {}),
    });
    expect(await screen.findByText("Loading sites…")).toBeInTheDocument();
  });

  it("shows an error with a retry", async () => {
    const { backend } = renderExchange(<Marketplace />, {
      "GET /assets": sequence(
        () => json({ detail: "boom" }, { status: 500 }),
        () => json(CARDS),
      ),
    });
    expect(
      await screen.findByText("We couldn't load the marketplace"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("link", { name: /Xochimilco Wetland/ }),
    ).toBeInTheDocument();
    expect(backend.calls("GET /assets")).toBe(2);
  });

  it("says so when no site is listed", async () => {
    renderExchange(<Marketplace />, { "GET /assets": () => json([]) });
    expect(
      await screen.findByText(/No sites are listed yet/),
    ).toBeInTheDocument();
  });

  it("renders a card per asset with the API's numbers, linking to the real asset", async () => {
    renderExchange(<Marketplace />, { "GET /assets": () => json(CARDS) });
    await screen.findByRole("region", { name: "All sites" });

    const links = within(grid()).getAllByRole("link");
    expect(links).toHaveLength(3);
    // Best grade first: the AA mangrove, then the A sites by health.
    expect(links.map((l) => l.querySelector("h3")?.textContent)).toEqual([
      "Ría Celestún Mangrove",
      "Sumidero Canyon Restoration Forest",
      "Xochimilco Wetland",
    ]);
    const wetland = links[2]!;
    expect(wetland).toHaveAttribute("href", `/asset/${WETLAND.id}`);
    expect(within(wetland).getByText("$21.47")).toBeInTheDocument();
    expect(within(wetland).getByText("76.2")).toBeInTheDocument();
    expect(within(wetland).getByText("71% confidence")).toBeInTheDocument();
    expect(within(wetland).getByText("First rating")).toBeInTheDocument();
    expect(
      within(wetland).getByRole("img", { name: /Grade A, Strong health/ }),
    ).toBeInTheDocument();
    expect(
      within(wetland).getByAltText("Satellite view of Xochimilco Wetland"),
    ).toHaveAttribute("src", "/api/media/demo-sites/wetland_mx/thumbnail.webp");
    // The top-rated site is featured.
    expect(
      screen.getByRole("heading", { level: 2, name: "Ría Celestún Mangrove" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Sites listed").nextSibling).toHaveTextContent("3");
  });

  it("marks a listed site awaiting its opening offer as not trading yet", async () => {
    const launching = {
      ...WETLAND,
      id: "77777777-7777-4777-8777-777777777777",
      name: "New Mangrove",
      trading: false,
      price: null,
      price_change_pct: null,
      sparkline: [],
    };
    renderExchange(<Marketplace />, {
      "GET /assets": () => json([...CARDS, launching]),
    });
    const card = await screen.findByRole("link", { name: /New Mangrove/ });

    expect(within(card).getByText("Not trading yet")).toBeInTheDocument();
    const traded = screen.getByRole("link", { name: /Xochimilco Wetland/ });
    expect(
      within(traded).queryByText("Not trading yet"),
    ).not.toBeInTheDocument();
  });

  it("marks an unrated site and leaves it out of the rated totals", async () => {
    const pending = {
      ...WETLAND,
      id: "66666666-6666-4666-8666-666666666666",
      name: "New Wetland",
      status: "rating" as const,
      area_ha: "1000.00",
      grade: null,
      confidence: null,
      health_score: null,
      value_low: null,
      value_mid: null,
      value_high: null,
      trend: null,
    };
    renderExchange(<Marketplace />, {
      "GET /assets": () => json([...CARDS, pending]),
    });
    const card = await screen.findByRole("link", { name: /New Wetland/ });

    expect(within(card).getByText("Awaiting rating")).toBeInTheDocument();
    expect(within(card).getByText("Not rated yet")).toBeInTheDocument();
    expect(screen.getByText("Sites listed").nextSibling).toHaveTextContent("4");
    // 206.70 + 457.88 + 400.21 ha: the unrated 1,000 ha isn't "rated".
    expect(screen.getByText("Land rated").nextSibling).toHaveTextContent(
      "1,065 ha",
    );
    expect(screen.getByText("Nature's value").nextSibling).toHaveTextContent(
      "$38.9M",
    );
  });

  it("filters by grade band", async () => {
    renderExchange(<Marketplace />, { "GET /assets": () => json(CARDS) });
    await screen.findByRole("region", { name: "All sites" });

    fireEvent.click(screen.getByRole("radio", { name: "BBB–BB" }));

    expect(
      await screen.findByText("No sites rated BBB–BB yet."),
    ).toBeInTheDocument();
    expect(window.location.search).toBe("?grade=b");
    fireEvent.click(screen.getByRole("radio", { name: "AAA–A" }));
    expect(within(grid()).getAllByRole("link")).toHaveLength(3);
  });

  it("reads the filter and sort from the URL", async () => {
    window.history.replaceState(null, "", "/?grade=a&sort=value");
    renderExchange(<Marketplace />, { "GET /assets": () => json(CARDS) });
    await screen.findByRole("region", { name: "All sites" });

    expect(screen.getByRole("radio", { name: "AAA–A" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: /^Sort: / })).toHaveTextContent(
      "Sort: Annual value",
    );
    const names = within(grid())
      .getAllByRole("link")
      .map((l) => l.querySelector("h3")?.textContent);
    expect(names[0]).toBe("Ría Celestún Mangrove");
    expect(names[1]).toBe("Xochimilco Wetland");
  });

  it.each([
    "?grade=toString",
    "?grade=__proto__",
    "?grade=constructor",
    "?sort=constructor",
    "?sort=__proto__&grade=hasOwnProperty",
  ])("ignores a crafted %s and shows every site", async (query) => {
    window.history.replaceState(null, "", `/${query}`);
    renderExchange(<Marketplace />, { "GET /assets": () => json(CARDS) });
    await screen.findByRole("region", { name: "All sites" });

    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
    expect(within(grid()).getAllByRole("link")).toHaveLength(3);
    expect(screen.getByRole("combobox", { name: /^Sort: / })).toHaveTextContent(
      "Sort: Best grade",
    );
  });

  it("draws each sparkline from the card, with no per-card price request", async () => {
    const withHistory = CARDS.map((c) =>
      c.id === WETLAND.id
        ? { ...c, sparkline: ["21.4723", "21.5045", "21.5518"] }
        : c,
    );
    const { backend } = renderExchange(<Marketplace />, {
      "GET /assets": () => json(withHistory),
    });
    const link = await screen.findByRole("link", {
      name: /Xochimilco Wetland/,
    });

    // Only a card with two prices or more draws one; the others say nothing.
    const charts = grid().querySelectorAll(".recharts-responsive-container");
    expect(charts).toHaveLength(1);
    expect(link).toContainElement(charts[0] as HTMLElement);
    expect(screen.queryByText(/price chart starts/)).toBeNull();
    expect(
      backend.requests.filter((r) => r.url.includes("/prices")),
    ).toHaveLength(0);
  });

  it("updates prices live on price_tick", async () => {
    const moved = CARDS.map((c) =>
      c.id === WETLAND.id
        ? { ...c, price: "25.0000", price_change_pct: 16.43 }
        : c,
    );
    renderExchange(<Marketplace />, {
      "GET /assets": sequence(
        () => json(CARDS),
        () => json(moved),
      ),
    });
    const link = await screen.findByRole("link", {
      name: /Xochimilco Wetland/,
    });
    expect(within(link).getByText("$21.47")).toBeInTheDocument();

    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      source.emit("price_tick", 1, {
        asset_id: WETLAND.id,
        price: "25.0000",
        reason: "order",
      });
    });

    await waitFor(() =>
      expect(
        within(
          screen.getByRole("link", { name: /Xochimilco Wetland/ }),
        ).getByText("$25.00"),
      ).toBeInTheDocument(),
    );
    expect(
      within(
        screen.getByRole("link", { name: /Xochimilco Wetland/ }),
      ).getByText("+16.4%"),
    ).toBeInTheDocument();
  });
});
