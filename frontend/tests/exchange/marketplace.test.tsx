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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const CARDS = cards as AssetCard[];
const WETLAND = CARDS.find((c) => c.site_key === "wetland_mx")!;

beforeAll(stubBrowserApis);
beforeEach(() => FakeEventSource.reset());

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

  it("filters by grade band", async () => {
    renderExchange(<Marketplace />, { "GET /assets": () => json(CARDS) });
    await screen.findByRole("region", { name: "All sites" });

    fireEvent.click(screen.getByRole("radio", { name: "BBB–BB" }));

    expect(
      await screen.findByText("No sites rated BBB–BB yet."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "AAA–A" }));
    expect(within(grid()).getAllByRole("link")).toHaveLength(3);
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
