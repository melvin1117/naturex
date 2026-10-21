import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import CommunityPage from "@/app/steward/community/page";
import StewardLayout from "@/app/steward/layout";
import StewardPage from "@/app/steward/page";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import type {
  AssetCard,
  CommunityMember,
  CommunitySummary,
  ListingSummary,
  MyCommunity,
  WorldOut,
} from "@/lib/api/types";
import { SUMMARY_TICK_REFRESH_MS } from "@/lib/community-hooks";
import { createDataLayer } from "@/lib/data-layer";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
import { PrototypeProvider } from "@/lib/prototype/store";
import { stewardAssetId } from "@/components/shell/steward-community";

import { dropFocus } from "../focus";
import {
  BASE,
  community,
  createFakeEventSource,
  FakeEventSource,
  fakeBackend,
  json,
  SIGNED_IN_WORLD,
} from "../lib/helpers";
import { asset as assetFixture, ASSET_ID } from "../trade/fixtures";

const nav = vi.hoisted(() => ({ pathname: "/steward", search: "" }));
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.reset();
  nav.pathname = "/steward";
  nav.search = "";
  window.localStorage.clear();
});

const ROSA = SIGNED_IN_WORLD.me!;
const SELVA = community();
const WALLET_ZERO = {
  balance: "0.00",
  ipo_proceeds: "0.00",
  community_fund_payouts: "0.00",
  retained_dividends: "0.00",
  total_received: "0.00",
};
const MEMBERS: CommunityMember[] = [
  {
    user_id: ROSA.id,
    name: "Rosa",
    role: "owner",
    created_at: "2026-10-18T00:00:00Z",
  },
  {
    user_id: "88888888-8888-4888-8888-888888888888",
    name: "Tomás",
    role: "steward",
    created_at: "2026-10-18T01:00:00Z",
  },
];

function card(overrides: Partial<AssetCard> = {}): AssetCard {
  return {
    id: "35df5b9e-90ff-4205-a82e-9ca6e0e06729",
    name: "Xochimilco Wetland",
    country: "MX",
    status: "listed",
    trading: true,
    area_ha: "206.70",
    price: "21.4723",
    price_change_pct: 0,
    grade: "A",
    trend: null,
    confidence: "71.00",
    health_score: "76.20",
    value_low: "2121067.00",
    value_mid: "2669511.00",
    value_high: "2669511.00",
    cover_image_url: null,
    site_key: null,
    sparkline: [],
    mock: false,
    status_reason: null,
    ...overrides,
  };
}

function listing(overrides: Partial<ListingSummary> = {}): ListingSummary {
  return {
    asset: card(),
    next_action: "view_on_exchange",
    ipo_at: "2026-10-10T00:00:00Z",
    wallet: WALLET_ZERO,
    holders: { count: 0, shares_held: 0, top: [] },
    shares: null,
    recommendations: [],
    report_version: 1,
    ...overrides,
  };
}

function summary(overrides: Partial<CommunitySummary> = {}): CommunitySummary {
  return {
    community: {
      id: SELVA.id,
      name: SELVA.name,
      country: "MX",
      description: null,
      created_at: SELVA.created_at,
    },
    role: "owner",
    listings: [],
    wallet: WALLET_ZERO,
    holder_count: 0,
    payouts: [],
    payouts_count: 0,
    ...overrides,
  };
}

type Routes = Parameters<typeof fakeBackend>[0];

function setup(
  page: ReactNode,
  {
    world = SIGNED_IN_WORLD,
    communities = [SELVA],
    routes = {},
  }: { world?: WorldOut; communities?: MyCommunity[]; routes?: Routes } = {},
) {
  const backend = fakeBackend({
    "GET /world": () => json(world),
    "GET /me/communities": () => json(communities),
    [`GET /communities/${SELVA.id}/members`]: () => json(MEMBERS),
    "GET /alerts": () =>
      json({ alerts: [], unread_count: 0, next_before: null }),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
    pollIntervalMs: 60_000,
  });
  const tree = (content: ReactNode) => (
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>
          <StewardLayout>{content}</StewardLayout>
        </TourProvider>
      </PrototypeProvider>
    </WorldProvider>
  );
  const view = render(tree(page));
  return Object.assign(backend, {
    layer,
    showPage: (next: ReactNode) => view.rerender(tree(next)),
  });
}

describe("creating a community", () => {
  const created = {
    id: "99999999-9999-4999-8999-999999999999",
    name: "Río Verde",
    country: "MX",
    description: "Mangrove keepers.",
    created_at: "2026-10-19T00:00:00Z",
  };

  it("creates it, refreshes the account's communities and shows it", async () => {
    let mine: MyCommunity[] = [];
    const backend = setup(<StewardPage />, {
      routes: {
        "GET /me/communities": () => json(mine),
        "POST /communities": async (request) => {
          expect(await request.json()).toEqual({
            name: "Río Verde",
            country: "MX",
            description: "Mangrove keepers.",
          });
          mine = [{ ...created, role: "owner" }];
          return json(created, { status: 201 });
        },
        [`GET /communities/${created.id}/summary`]: () =>
          json(summary({ community: created })),
        [`GET /communities/${created.id}/members`]: () => json(MEMBERS),
      },
    });

    await screen.findByRole("heading", { level: 1, name: "Start a community" });
    fireEvent.change(screen.getByLabelText("Community name"), {
      target: { value: "  Río   Verde " },
    });
    fireEvent.change(screen.getByLabelText(/^Country/), {
      target: { value: "mx" },
    });
    fireEvent.change(screen.getByLabelText(/^About the community/), {
      target: { value: "Mangrove keepers." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create community" }));

    // The new community is selected and its empty home invites listing land.
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith(
        `/steward?community=${created.id}`,
        { scroll: false },
      ),
    );
    expect(backend.calls("GET /me/communities")).toBeGreaterThanOrEqual(2);
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Río Verde",
    });
    expect(heading).toBeVisible();
    // The form that held focus is gone: the new home's name takes it (T48).
    await waitFor(() => expect(heading).toHaveFocus());
    expect(
      screen.getAllByRole("link", { name: /List your land/ })[0],
    ).toHaveAttribute("href", `/steward/list?community=${created.id}`);
  }, 15_000);

  function createRoutes(mine: { current: MyCommunity[] }): Routes {
    return {
      "GET /me/communities": () => json(mine.current),
      "POST /communities": () => {
        mine.current = [{ ...created, role: "owner" }];
        return json(created, { status: 201 });
      },
      [`GET /communities/${created.id}/summary`]: () =>
        json(summary({ community: created })),
      [`GET /communities/${created.id}/members`]: () => json(MEMBERS),
    };
  }

  /** Focus may move a moment after the heading appears: give it the chance, then check. */
  async function expectNoFocus(element: HTMLElement) {
    await expect(
      waitFor(() => expect(element).toHaveFocus(), { timeout: 400 }),
    ).rejects.toThrow();
  }

  async function createFromForm() {
    fireEvent.change(
      await screen.findByLabelText("Community name", {}, { timeout: 5000 }),
      { target: { value: "Río Verde" } },
    );
    const button = screen.getByRole("button", { name: "Create community" });
    button.focus();
    fireEvent.click(button);
    // The form, and the button that held focus, give way to the page.
    dropFocus();
  }

  it("focuses the page that replaces the form once, on any route (T48)", async () => {
    nav.pathname = "/steward/list";
    const backend = setup(<h1>List your land</h1>, {
      communities: [],
      routes: createRoutes({ current: [] }),
    });
    await createFromForm();
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "List your land",
    });
    await waitFor(() => expect(heading).toHaveFocus());

    // Later pages don't grab focus: nothing is left over to fire again.
    heading.blur();
    nav.pathname = "/steward";
    backend.showPage(<StewardPage />);
    const home = await screen.findByRole("heading", {
      level: 1,
      name: "Río Verde",
    });
    await expectNoFocus(home);
  }, 15_000);

  it("forgets a just-created community on sign-out or another account (T48)", async () => {
    const backend = setup(<StewardPage />, {
      communities: [],
      routes: createRoutes({ current: [] }),
    });
    await createFromForm();
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Río Verde",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    heading.blur();

    const home = () =>
      screen.findByRole("heading", { level: 1, name: "Río Verde" });
    // Another account signed in on this tab, then back.
    act(() =>
      backend.layer.session.set({
        ...SIGNED_IN_WORLD,
        me: { ...ROSA, id: "77777777-7777-4777-8777-777777777777" },
      }),
    );
    act(() => backend.layer.session.set(SIGNED_IN_WORLD));
    await expectNoFocus(await home());
    // Signed out, then back.
    act(() => backend.layer.session.set({ ...SIGNED_IN_WORLD, me: null }));
    act(() => backend.layer.session.set(SIGNED_IN_WORLD));
    await expectNoFocus(await home());
  }, 15_000);

  it("shows the account ID to share with an owner, with Copy", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setup(<StewardPage />, { communities: [] });
    await screen.findByRole("heading", { level: 1, name: "Start a community" });
    expect(screen.getByText(ROSA.id)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy account ID" }));
    expect(await screen.findByText("Account ID copied.")).toBeVisible();
    expect(writeText).toHaveBeenCalledWith(ROSA.id);

    writeText.mockImplementationOnce(() => Promise.reject(new Error("denied")));
    fireEvent.click(screen.getByRole("button", { name: "Copy account ID" }));
    expect(await screen.findByText(/Couldn't copy/)).toBeVisible();
  });

  it("offers the account ID in the account menu on every page", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setup(<StewardPage />, { communities: [] });
    const trigger = await screen.findByRole("button", {
      name: "Account: Rosa",
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText(ROSA.id)).toBeVisible();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Copy account ID" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ROSA.id));
  });

  it("checks the name before sending", async () => {
    const backend = setup(<StewardPage />, { communities: [] });
    await screen.findByRole("heading", { level: 1, name: "Start a community" });
    fireEvent.click(screen.getByRole("button", { name: "Create community" }));
    const name = screen.getByLabelText("Community name");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Use 2–80 characters.");
    expect(name).toHaveFocus();
    expect(backend.calls("POST /communities")).toBe(0);
  });

  it.each([
    [
      "a taken name, on the name field",
      json({ detail: "community_name_taken" }, { status: 409 }),
      /already exists/,
      true,
    ],
    [
      "the community cap, above the button",
      json({ detail: "community_limit_reached" }, { status: 409 }),
      /5 communities/,
      false,
    ],
    [
      "a 422 on its field",
      json(
        {
          detail: [
            { loc: ["body", "name"], msg: "Value error, Use 2–80 characters" },
          ],
        },
        { status: 422 },
      ),
      "Use 2–80 characters.",
      true,
    ],
  ])("shows %s", async (_case, response, message, onField) => {
    setup(<StewardPage />, {
      communities: [],
      routes: { "POST /communities": () => response },
    });
    await screen.findByRole("heading", { level: 1, name: "Start a community" });
    fireEvent.change(screen.getByLabelText("Community name"), {
      target: { value: "Selva Viva" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create community" }));
    if (onField) {
      await waitFor(() =>
        expect(
          screen.getByLabelText("Community name"),
        ).toHaveAccessibleDescription(message),
      );
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
    }
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("the community home", () => {
  it("shows a new community an empty home that leads to listing land", async () => {
    setup(<StewardPage />, {
      routes: {
        [`GET /communities/${SELVA.id}/summary`]: () => json(summary()),
      },
    });
    const empty = await screen.findByRole("region", { name: "List your land" });
    expect(
      within(empty).getByRole("link", { name: /List your land/ }),
    ).toHaveAttribute("href", `/steward/list?community=${SELVA.id}`);
    expect(screen.getByText(/No alerts yet/)).toBeVisible();
    // The owner sees the members.
    const members = await screen.findByRole("region", { name: "Members" });
    expect(await within(members).findByText("Tomás")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Edit community/ }),
    ).toHaveAttribute("href", `/steward/community?community=${SELVA.id}`);
    // No wallet until there's a listing.
    expect(screen.queryByText("Retained-stake dividends")).toBeNull();
  });

  it("shows each listing's next action, the wallet, payouts and supporters", async () => {
    const trading = listing({
      wallet: {
        balance: "1550.25",
        ipo_proceeds: "1500.00",
        community_fund_payouts: "50.25",
        retained_dividends: "25.12",
        total_received: "1575.37",
      },
      holders: {
        count: 2,
        shares_held: 75,
        top: [
          { rank: 1, shares: 50, pct_of_shares: "0.01" },
          { rank: 2, shares: 25, pct_of_shares: "0.00" },
        ],
      },
      shares: {
        shares_offered: 490_000,
        shares_sold: 75,
        retained_shares: 510_000,
      },
      recommendations: ["Fence the riverbank"],
    });
    const awaiting = listing({
      asset: card({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Bosque Alto",
        trading: false,
        price: null,
      }),
      next_action: "launch_ipo",
      ipo_at: null,
    });
    const draft = listing({
      asset: card({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "Río Bajo",
        status: "draft",
        trading: false,
        grade: null,
        health_score: null,
        price: null,
      }),
      next_action: "continue_listing",
      ipo_at: null,
      report_version: null,
    });
    setup(<StewardPage />, {
      routes: {
        [`GET /communities/${SELVA.id}/summary`]: () =>
          json(
            summary({
              listings: [trading, awaiting, draft],
              wallet: trading.wallet,
              holder_count: 2,
              payouts: [
                {
                  asset_id: trading.asset.id,
                  asset_name: "Xochimilco Wetland",
                  quarter_label: "2026Q3",
                  revenue: "100.50",
                  community_fund: "50.25",
                  dividends_total: "50.25",
                  retained_dividend: "25.12",
                  holder_count: 3,
                  paid_at: "2026-10-01T00:00:00Z",
                },
              ],
              payouts_count: 1,
            }),
          ),
      },
    });

    const sites = await screen.findByRole("region", { name: "Your sites" });
    expect(
      within(sites).getByRole("link", { name: /View on Exchange/ }),
    ).toHaveAttribute("href", `/asset/${trading.asset.id}`);
    expect(
      within(sites).getByRole("link", { name: /Launch IPO/ }),
    ).toHaveAttribute(
      "href",
      `/steward/assets/${awaiting.asset.id}/ipo?community=${SELVA.id}`,
    );
    expect(
      within(sites).getByRole("link", { name: /Continue listing/ }),
    ).toHaveAttribute(
      "href",
      `/steward/list?community=${SELVA.id}&asset=${draft.asset.id}`,
    );
    expect(
      within(sites).getByRole("link", { name: "Verification of Bosque Alto" }),
    ).toHaveAttribute(
      "href",
      `/steward/assets/${awaiting.asset.id}/verify?community=${SELVA.id}`,
    );
    expect(
      within(sites).getByRole("link", { name: "Field photos of Bosque Alto" }),
    ).toHaveAttribute(
      "href",
      `/steward/assets/${awaiting.asset.id}/evidence?community=${SELVA.id}`,
    );

    const wallet = screen.getByRole("region", { name: "Community fund" });
    expect(
      within(wallet).getByText(/Community fund balance · play money/),
    ).toBeVisible();
    expect(
      within(wallet).getByText("IPO proceeds").closest("div"),
    ).toHaveTextContent("$1,500.00");
    expect(
      within(wallet).getByText("Community-fund payouts").closest("div"),
    ).toHaveTextContent("$50.25");
    expect(
      within(wallet)
        .getByText("Treasury cash: retained-stake dividends")
        .closest("div"),
    ).toHaveTextContent("$25.12");
    expect(
      within(wallet).getByText("Total received").closest("div"),
    ).toHaveTextContent("$1,575.37");

    const payouts = screen.getByRole("region", { name: "Quarterly payouts" });
    expect(within(payouts).getByText("Q3 2026")).toBeVisible();
    expect(within(payouts).getByText("$100.50")).toBeVisible();

    const supporters = screen.getByRole("region", { name: "Supporters" });
    expect(supporters).toHaveTextContent("2 supporters hold 75 units");
    expect(within(supporters).getByText("Supporter 1")).toBeVisible();
    expect(within(supporters).getByText(/50 units · 0.01%/)).toBeVisible();
    expect(within(supporters).getByText(/25 units · <0.01%/)).toBeVisible();
    expect(screen.getByText("Fence the riverbank")).toBeVisible();
    expect(screen.getByText(/No alerts yet/)).toBeVisible();
  });

  it.each([
    [1, 60, "1 supporter holds 60 units"],
    [1, 1, "1 supporter holds 1 unit"],
  ])(
    "says how many supporters hold how many units (%i, %i)",
    async (count, held, text) => {
      const one = listing({
        holders: {
          count,
          shares_held: held,
          top: [{ rank: 1, shares: held, pct_of_shares: "0.01" }],
        },
        shares: {
          shares_offered: 490_000,
          shares_sold: held,
          retained_shares: 510_000,
        },
      });
      setup(<StewardPage />, {
        routes: {
          [`GET /communities/${SELVA.id}/summary`]: () =>
            json(summary({ listings: [one], holder_count: count })),
        },
      });

      const supporters = await screen.findByRole("region", {
        name: "Supporters",
      });
      await waitFor(() => expect(supporters).toHaveTextContent(text));
    },
  );

  it("draws a featured listing's boundary when it has no thumbnail", async () => {
    const outline = [
      [
        [-99.1, 19.28],
        [-99.09, 19.28],
        [-99.09, 19.29],
        [-99.1, 19.28],
      ],
    ];
    setup(<StewardPage />, {
      routes: {
        [`GET /communities/${SELVA.id}/summary`]: () =>
          json(summary({ listings: [listing({ asset: card({ outline }) })] })),
      },
    });
    const featured = await screen.findByRole("region", {
      name: "Xochimilco Wetland",
    });
    expect(within(featured).getByText(IMAGERY_ATTRIBUTION)).toBeInTheDocument();
    expect(
      featured.querySelectorAll("[data-boundary-map] img").length,
    ).toBeGreaterThan(0);
  });

  it("lists the alerts about the community's own sites (T75)", async () => {
    const mine = {
      id: "11111111-1111-4111-8111-111111111111",
      asset_id: card().id,
      asset_name: "Xochimilco Wetland",
      kind: "grade_change" as const,
      title: "Xochimilco Wetland downgraded to BBB",
      message: "Health 72.0 → 64.5 (−7.5 points). Grade A → BBB.",
      severity: 4,
      url: null,
      report_id: null,
      created_at: "2026-10-19T08:00:00Z",
      read_at: null,
    };
    const elsewhere = {
      ...mine,
      id: "22222222-2222-4222-8222-222222222222",
      asset_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      asset_name: "A site I back",
      title: "A site I back: health fell 6.0 points",
    };
    setup(<StewardPage />, {
      routes: {
        [`GET /communities/${SELVA.id}/summary`]: () =>
          json(summary({ listings: [listing()] })),
        // The API filters by community (members only); the home never sees other sites'.
        "GET /alerts": (request) =>
          json(
            new URL(request.url).searchParams.get("community_id") === SELVA.id
              ? { alerts: [mine], unread_count: 1, next_before: null }
              : {
                  alerts: [mine, elsewhere],
                  unread_count: 2,
                  next_before: null,
                },
          ),
      },
    });

    const panel = await screen.findByRole("region", { name: "Alerts" });
    expect(
      await within(panel).findByText("Xochimilco Wetland downgraded to BBB"),
    ).toBeVisible();
    expect(within(panel).getByText("1 unread")).toBeVisible();
    expect(
      within(panel).queryByText("A site I back: health fell 6.0 points"),
    ).not.toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: "Mark all read" }),
    ).toBeVisible();
  });

  it("links field photos on the featured listing, not on closed ones (#214)", async () => {
    const closed = (status: "withdrawn" | "ineligible", id: string) =>
      listing({
        asset: card({
          id,
          name: `Closed ${status}`,
          status,
          trading: false,
          price: null,
        }),
        next_action: "none",
        ipo_at: null,
      });
    const featured = listing();
    setup(<StewardPage />, {
      routes: {
        [`GET /communities/${SELVA.id}/summary`]: () =>
          json(
            summary({
              listings: [
                featured,
                closed("withdrawn", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
                closed("ineligible", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
              ],
            }),
          ),
      },
    });

    const hero = await screen.findByRole("region", {
      name: "Xochimilco Wetland",
    });
    expect(
      within(hero).getByRole("link", {
        name: "Field photos of Xochimilco Wetland",
      }),
    ).toHaveAttribute(
      "href",
      `/steward/assets/${featured.asset.id}/evidence?community=${SELVA.id}`,
    );
    const sites = screen.getByRole("region", { name: "Your sites" });
    expect(within(sites).getByText("Closed withdrawn")).toBeVisible();
    for (const name of ["Closed withdrawn", "Closed ineligible"]) {
      expect(
        within(sites).queryByRole("link", { name: `Field photos of ${name}` }),
      ).not.toBeInTheDocument();
    }
  });

  it("tells a steward the owner launches the IPO", async () => {
    setup(<StewardPage />, {
      communities: [community({ role: "steward" })],
      routes: {
        [`GET /communities/${SELVA.id}/summary`]: () =>
          json(
            summary({
              role: "steward",
              listings: [
                listing({
                  asset: card({ trading: false }),
                  next_action: "awaiting_ipo",
                  ipo_at: null,
                }),
              ],
            }),
          ),
      },
    });
    expect(
      await screen.findByText("Waiting for the owner to launch the IPO"),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: /Launch IPO/ })).toBeNull();
  });

  it("refetches live: once per burst of trades, at once on a status change", async () => {
    const trading = listing();
    const backend = setup(<StewardPage />, {
      routes: {
        [`GET /communities/${SELVA.id}/summary`]: () =>
          json(summary({ listings: [trading] })),
      },
    });
    await screen.findByRole("region", { name: "Community fund" });
    const path = `GET /communities/${SELVA.id}/summary`;
    const before = backend.calls(path);

    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      for (const id of [1, 2, 3]) {
        source.emit("price_tick", id, {
          asset_id: trading.asset.id,
          price: "21.5000",
          reason: "order",
        });
      }
      // Another community's trade changes nothing here.
      source.emit("price_tick", 4, {
        asset_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        price: "9.0000",
        reason: "order",
      });
    });
    expect(backend.calls(path)).toBe(before);
    await waitFor(() => expect(backend.calls(path)).toBe(before + 1), {
      timeout: SUMMARY_TICK_REFRESH_MS + 2_000,
    });

    act(() => {
      FakeEventSource.latest().emit("listing_status", 5, {
        asset_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        community_id: SELVA.id,
        transition: "create",
        from: null,
        to: "draft",
        reason: null,
      });
    });
    await waitFor(() => expect(backend.calls(path)).toBe(before + 2));
  }, 15_000);

  it("explains a failed summary and retries", async () => {
    let fail = true;
    setup(<StewardPage />, {
      routes: {
        [`GET /communities/${SELVA.id}/summary`]: () =>
          fail ? json({ detail: "boom" }, { status: 503 }) : json(summary()),
      },
    });
    expect(
      await screen.findByText("We couldn't load your community home"),
    ).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("region", { name: "List your land" }),
    ).toBeVisible();
  });
});

describe("community settings", () => {
  it("lets the owner edit the community, sending only what changed", async () => {
    nav.pathname = "/steward/community";
    let name = SELVA.name;
    const backend = setup(<CommunityPage />, {
      routes: {
        [`GET /communities/${SELVA.id}`]: () =>
          json({ ...summary().community, name }),
        [`PATCH /communities/${SELVA.id}`]: async (request) => {
          expect(await request.json()).toEqual({ name: "Selva Viva Norte" });
          name = "Selva Viva Norte";
          return json({ ...summary().community, name });
        },
      },
    });
    const input = await screen.findByLabelText("Community name");
    expect(input).toHaveValue("Selva Viva");
    await waitFor(() =>
      expect(backend.calls("GET /me/communities")).toBeGreaterThan(0),
    );
    const before = backend.calls("GET /me/communities");
    fireEvent.change(input, { target: { value: "Selva Viva Norte" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved.")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText("Community name")).toHaveValue(
        "Selva Viva Norte",
      ),
    );
    // The edit invalidates the account's communities, so the header shows the new name.
    await waitFor(() =>
      expect(backend.calls("GET /me/communities")).toBe(before + 1),
    );
    expect(backend.calls(`GET /communities/${SELVA.id}/summary`)).toBe(0);
    // "Saved." goes once the form changes again.
    fireEvent.change(screen.getByLabelText("Community name"), {
      target: { value: "Selva" },
    });
    expect(screen.queryByText("Saved.")).toBeNull();

    const members = screen.getByRole("region", { name: "Members" });
    expect(await within(members).findByText("Tomás")).toBeVisible();
    expect(
      within(members).getByRole("button", { name: "Remove Tomás" }),
    ).toBeVisible();
    expect(
      within(members).getByLabelText("Add a steward by account ID"),
    ).toBeVisible();
  });

  it("removes a steward only after confirming", async () => {
    nav.pathname = "/steward/community";
    let removed = 0;
    setup(<CommunityPage />, {
      routes: {
        [`GET /communities/${SELVA.id}`]: () => json(summary().community),
        [`DELETE /communities/${SELVA.id}/members/${MEMBERS[1]!.user_id}`]:
          () => {
            removed += 1;
            return new Response(null, { status: 204 });
          },
      },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Tomás" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Remove Tomás?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(removed).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove Tomás" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Remove Tomás?" }),
      ).getByRole("button", { name: "Remove steward" }),
    );
    await waitFor(() => expect(removed).toBe(1));
  });

  it("adds a steward by account ID and explains a refusal", async () => {
    nav.pathname = "/steward/community";
    const newcomer = "77777777-7777-4777-8777-777777777777";
    setup(<CommunityPage />, {
      routes: {
        [`GET /communities/${SELVA.id}`]: () => json(summary().community),
        [`POST /communities/${SELVA.id}/members`]: async (request) => {
          // A browser drops focus from "Add" while it's disabled for the request.
          dropFocus();
          const body = (await request.json()) as { user_id: string };
          return body.user_id === newcomer
            ? json(
                {
                  user_id: newcomer,
                  name: "Lucía",
                  role: "steward",
                  created_at: "2026-10-19T00:00:00Z",
                },
                { status: 201 },
              )
            : json({ detail: "user_not_found" }, { status: 404 });
        },
      },
    });
    const field = await screen.findByLabelText("Add a steward by account ID");
    fireEvent.change(field, { target: { value: "not-an-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the account ID they shared with you.",
    );
    expect(field).toHaveFocus();
    const addButton = screen.getByRole("button", { name: "Add" });
    fireEvent.change(field, {
      target: { value: "12345678-1234-4234-8234-123456789012" },
    });
    addButton.focus();
    fireEvent.click(addButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(/No account/);
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.change(field, { target: { value: newcomer } });
    addButton.focus();
    fireEvent.click(addButton);
    expect(await screen.findByText("Lucía is now a steward.")).toBeVisible();
    // Ready for the next ID (T48).
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("shows a steward the details read-only", async () => {
    nav.pathname = "/steward/community";
    setup(<CommunityPage />, {
      communities: [community({ role: "steward" })],
      routes: {
        [`GET /communities/${SELVA.id}`]: () => json(summary().community),
      },
    });
    expect(
      await screen.findByText("Only the owner can change these details."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Community name")).toBeNull();
    expect(screen.queryByLabelText("Add a steward by account ID")).toBeNull();
  });
});

describe("a site's Steward pages (T74)", () => {
  const OTHER = community({
    id: "77777777-7777-4777-8777-777777777777",
    name: "Río Verde",
  });
  const CONTROLS = "The site's Steward controls";
  const site = assetFixture({ name: "Cloud Forest", community_id: OTHER.id });

  function openSitePage(
    communities: MyCommunity[],
    detail = site,
    path = `/steward/assets/${ASSET_ID}/ipo`,
  ) {
    nav.pathname = path;
    nav.search = `community=${OTHER.id}`;
    return setup(<p>{CONTROLS}</p>, {
      communities,
      routes: { [`GET /assets/${ASSET_ID}`]: () => json(detail) },
    });
  }

  it.each([
    [`/steward/assets/${ASSET_ID}/ipo`, ASSET_ID],
    [`/steward/assets/${ASSET_ID}/verify`, ASSET_ID],
    [`/steward/assets/${ASSET_ID}`, ASSET_ID],
    ["/steward", null],
    ["/steward/list", null],
    ["/steward/assetsx/1", null],
    [null, null],
  ])("finds the site of %s", (pathname, id) => {
    expect(stewardAssetId(pathname)).toBe(id);
  });

  it.each([
    `/steward/assets/${ASSET_ID}/ipo`,
    `/steward/assets/${ASSET_ID}/verify`,
  ])(
    "tells an account without a community it isn't a member (%s)",
    async (path) => {
      openSitePage([], site, path);

      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: "You're not a member of the community that lists this site",
        }),
      ).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Start a community" }),
      ).toBeNull();
      expect(screen.queryByText(CONTROLS)).toBeNull();
      expect(
        screen.getByRole("link", { name: /See Cloud Forest on the Exchange/ }),
      ).toHaveAttribute("href", `/asset/${ASSET_ID}`);
      expect(
        screen.getByRole("link", { name: "Start a community" }),
      ).toHaveAttribute("href", "/steward");
      expect(screen.getByText(ROSA.id)).toBeVisible();
    },
  );

  it("tells a member of another community, and links to its own home", async () => {
    openSitePage([SELVA]);

    await screen.findByRole("heading", {
      level: 1,
      name: "You're not a member of the community that lists this site",
    });
    expect(screen.queryByText(CONTROLS)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Your community home" }),
    ).toHaveAttribute("href", `/steward?community=${SELVA.id}`);
    expect(
      screen.queryByRole("link", { name: "Start a community" }),
    ).toBeNull();
  });

  it("refuses a site no community lists", async () => {
    openSitePage([SELVA], assetFixture({ community_id: null }));

    await screen.findByRole("heading", {
      level: 1,
      name: "You're not a member of the community that lists this site",
    });
    expect(screen.queryByText(CONTROLS)).toBeNull();
  });

  it("shows the page to a member of the community that lists the site", async () => {
    openSitePage([SELVA, { ...OTHER, role: "steward" }]);

    expect(await screen.findByText(CONTROLS)).toBeVisible();
    expect(screen.queryByRole("heading", { name: /not a member/ })).toBeNull();
  });

  it("leaves a missing site to the page, which explains it", async () => {
    nav.pathname = `/steward/assets/${ASSET_ID}/ipo`;
    setup(<p>{CONTROLS}</p>, {
      communities: [],
      routes: {
        [`GET /assets/${ASSET_ID}`]: () =>
          json({ detail: "asset_not_found" }, { status: 404 }),
      },
    });

    expect(await screen.findByText(CONTROLS)).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Start a community" }),
    ).toBeNull();
  });

  it("still offers to start a community everywhere else", async () => {
    nav.pathname = "/steward/list";
    const backend = setup(<p>{CONTROLS}</p>, { communities: [] });

    await screen.findByRole("heading", { level: 1, name: "Start a community" });
    expect(backend.calls(`GET /assets/${ASSET_ID}`)).toBe(0);
  });
});
