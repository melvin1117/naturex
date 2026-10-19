import {
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
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  BASE,
  community,
  createFakeEventSource,
  fakeBackend,
  json,
  SIGNED_IN_WORLD,
} from "../lib/helpers";

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
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
    pollIntervalMs: 60_000,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>
          <StewardLayout>{page}</StewardLayout>
        </TourProvider>
      </PrototypeProvider>
    </WorldProvider>,
  );
  return backend;
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
    expect(
      await screen.findByRole("heading", { level: 1, name: "Río Verde" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: /List your land/ })[0],
    ).toHaveAttribute("href", `/steward/list?community=${created.id}`);
  }, 15_000);

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
    ).toHaveAttribute("href", `/steward/list?community=${SELVA.id}`);

    const wallet = screen.getByRole("region", { name: "Community fund" });
    expect(
      within(wallet).getByText("IPO proceeds").closest("div"),
    ).toHaveTextContent("$1,500.00");
    expect(
      within(wallet).getByText("Community-fund payouts").closest("div"),
    ).toHaveTextContent("$50.25");
    expect(
      within(wallet).getByText("Retained-stake dividends").closest("div"),
    ).toHaveTextContent("$25.12");
    expect(
      within(wallet).getByText("Total received").closest("div"),
    ).toHaveTextContent("$1,575.37");

    const payouts = screen.getByRole("region", { name: "Quarterly payouts" });
    expect(within(payouts).getByText("Q3 2026")).toBeVisible();
    expect(within(payouts).getByText("$100.50")).toBeVisible();

    const supporters = screen.getByRole("region", { name: "Supporters" });
    expect(within(supporters).getByText("Supporter 1")).toBeVisible();
    expect(within(supporters).getByText(/50 units · 0.01%/)).toBeVisible();
    expect(within(supporters).getByText(/25 units · <0.01%/)).toBeVisible();
    expect(screen.getByText("Fence the riverbank")).toBeVisible();
    expect(screen.getByText(/No alerts yet/)).toBeVisible();
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
        [`GET /communities/${SELVA.id}/summary`]: () =>
          json(summary({ community: { ...summary().community, name } })),
        [`PATCH /communities/${SELVA.id}`]: async (request) => {
          expect(await request.json()).toEqual({ name: "Selva Viva Norte" });
          name = "Selva Viva Norte";
          return json({ ...summary().community, name });
        },
      },
    });
    const input = await screen.findByLabelText("Community name");
    expect(input).toHaveValue("Selva Viva");
    fireEvent.change(input, { target: { value: "Selva Viva Norte" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved.")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText("Community name")).toHaveValue(
        "Selva Viva Norte",
      ),
    );
    // The header's community list and the home pick up the new name.
    expect(backend.calls("GET /me/communities")).toBeGreaterThanOrEqual(2);

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
        [`GET /communities/${SELVA.id}/summary`]: () => json(summary()),
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
        [`GET /communities/${SELVA.id}/summary`]: () => json(summary()),
        [`POST /communities/${SELVA.id}/members`]: async (request) => {
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
    fireEvent.change(field, {
      target: { value: "12345678-1234-4234-8234-123456789012" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/No account/);
    fireEvent.change(field, { target: { value: newcomer } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Lucía is now a steward.")).toBeVisible();
  });

  it("shows a steward the details read-only", async () => {
    nav.pathname = "/steward/community";
    setup(<CommunityPage />, {
      communities: [community({ role: "steward" })],
      routes: {
        [`GET /communities/${SELVA.id}/summary`]: () =>
          json(summary({ role: "steward" })),
      },
    });
    expect(
      await screen.findByText("Only the owner can change these details."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Community name")).toBeNull();
    expect(screen.queryByLabelText("Add a steward by account ID")).toBeNull();
  });
});
