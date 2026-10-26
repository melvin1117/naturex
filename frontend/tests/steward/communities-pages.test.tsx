import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import StewardLayout from "@/app/sandbox/steward/layout";
import StewardPage from "@/app/sandbox/steward/page";
import { WorldProvider } from "@/components/world-provider";
import type {
  AssetCard,
  CommunitySummary,
  ListingSummary,
} from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";

import {
  BASE,
  community,
  createFakeEventSource,
  FakeEventSource,
  fakeBackend,
  json,
  SIGNED_IN_WORLD,
} from "../lib/helpers";

/** Communities (ADR-0008): the list of your communities, and one community's page. */

const nav = vi.hoisted(() => ({ pathname: "/steward", search: "" }));
// Like the app router: replacing the URL changes what the page reads from it.
const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn((href: string) => {
    const [path, query = ""] = href.split("?");
    nav.pathname = path!;
    nav.search = query;
  }),
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
});

beforeEach(() => {
  vi.clearAllMocks();
  FakeEventSource.reset();
  window.localStorage.clear();
  nav.pathname = "/steward";
  nav.search = "";
});

const SELVA = community();
const WALLET = {
  balance: "0.00",
  ipo_proceeds: "0.00",
  community_fund_payouts: "0.00",
  retained_dividends: "0.00",
  total_received: "0.00",
};

function card(overrides: Partial<AssetCard> = {}): AssetCard {
  return {
    id: "35df5b9e-90ff-4205-a82e-9ca6e0e06729",
    name: "Xochimilco Wetland",
    country: "MX",
    status: "listed",
    trading: false,
    area_ha: "206.70",
    price: null,
    price_change_pct: null,
    grade: "AA",
    trend: null,
    confidence: "71.00",
    health_score: "85.10",
    value_low: "2121067.00",
    value_mid: "2669511.00",
    value_high: "2669511.00",
    cover_image_url: null,
    site_key: null,
    sparkline: [],
    mock: true,
    status_reason: null,
    ...overrides,
  } as AssetCard;
}

function listing(overrides: Partial<ListingSummary> = {}): ListingSummary {
  return {
    asset: card(),
    next_action: "launch_ipo",
    ipo_at: null,
    updated_at: "2026-10-18T00:00:00Z",
    manage_actions: [],
    wallet: WALLET,
    holders: { count: 0, shares_held: 0, top: [] },
    shares: null,
    recommendations: [],
    report_version: 1,
    verification: { level: "verified", in_review: false, required: false },
    ...overrides,
  };
}

function summary(listings: ListingSummary[]): CommunitySummary {
  return {
    community: {
      id: SELVA.id,
      name: SELVA.name,
      country: "MX",
      description: null,
      created_at: SELVA.created_at,
    },
    role: "owner",
    listings,
    wallet: WALLET,
    holder_count: 0,
    payouts: [],
    payouts_count: 0,
  };
}

type Routes = Parameters<typeof fakeBackend>[0];

function setup(
  summaryResponse: () => Response | Promise<Response>,
  routes: Routes = {},
) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    "GET /me/communities": () => json([SELVA]),
    [`GET /communities/${SELVA.id}/members`]: () => json([]),
    [`GET /communities/${SELVA.id}/summary`]: summaryResponse,
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
      {/* The sandbox shell holds the page in <main>. */}
      <main>
        <StewardLayout>{content}</StewardLayout>
      </main>
    </WorldProvider>
  );
  render(tree(<StewardPage />));
  return backend;
}

const SITE = "35df5b9e-90ff-4205-a82e-9ca6e0e06729";
const tiles = () => screen.findByRole("list", { name: "Selva Viva's sites" });

describe("a community's page", () => {
  beforeEach(() => {
    nav.search = `community=${SELVA.id}`;
  });

  it("shows the page's shape with one status while the summary loads", async () => {
    setup(() => new Promise<Response>(() => {}));
    const status = await screen.findByText("Loading Selva Viva…");
    expect(status).toHaveAttribute("role", "status");
    const main = screen.getByRole("main");
    expect(within(main).getAllByRole("status")).toHaveLength(1);
    expect(
      main.querySelector("[data-skeleton=steward-home]"),
    ).toBeInTheDocument();
    expect(main.querySelector(".animate-spin")).toBeNull();
  });

  it("leads a new community to list its land", async () => {
    setup(() => json(summary([])));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Selva Viva" }),
    ).toBeVisible();
    expect(screen.getByText("No land listed yet.")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "List your first site" }),
    ).toHaveAttribute("href", `/steward/list?community=${SELVA.id}`);
    expect(
      screen.getByRole("link", { name: "All communities" }),
    ).toHaveAttribute("href", "/steward");
  });

  it("says how its land is doing in one sentence", async () => {
    setup(() =>
      json({
        ...summary([
          listing({
            asset: card({ trading: true, price: "21.4723" }),
            ipo_at: "2026-10-18T00:00:00Z",
            next_action: "view_on_exchange",
          }),
        ]),
        holder_count: 3,
        wallet: { ...WALLET, balance: "1234.50" },
      }),
    );
    expect(
      await screen.findByText((_, el) =>
        el?.tagName === "P"
          ? el.textContent ===
            "1 site on the Marketplace, backed by 3 supporters. The community fund holds $1,234.50."
          : false,
      ),
    ).toBeVisible();
  });

  it("shows each site where it stands, leading to its next step", async () => {
    setup(() =>
      json(
        summary([
          listing({
            asset: card({ id: "a1", name: "Laguna", status: "draft" }),
            next_action: "continue_listing",
          }),
          listing({
            asset: card({ id: "a2", name: "Cerro" }),
            next_action: "offer_in_review",
            offer: {
              total_shares: 1_000_000,
              retained_pct: "51.00",
              sent_at: "2026-10-18T00:00:00Z",
              review_note: null,
            },
          }),
          listing({
            asset: card({ id: "a3", name: "Bosque" }),
            next_action: "offer_sent_back",
            offer: {
              total_shares: 1_000_000,
              retained_pct: "51.00",
              sent_at: null,
              review_note: "Keep more units.",
            },
          }),
          listing({
            asset: card({
              id: SITE,
              name: "Xochimilco Wetland",
              trading: true,
              price: "21.4723",
              price_change_pct: 2.5,
            }),
            ipo_at: "2026-10-18T00:00:00Z",
            next_action: "view_on_exchange",
          }),
          listing({
            asset: card({ id: "a5", name: "Gone", status: "withdrawn" }),
            next_action: "none",
          }),
        ]),
      ),
    );
    const list = await tiles();
    const link = (name: string) => within(list).getByRole("link", { name });
    expect(link("Laguna: Draft. Continue")).toHaveAttribute(
      "href",
      `/steward/list?community=${SELVA.id}&asset=a1`,
    );
    expect(
      link("Cerro: Waiting for the Reviewer. See your offer"),
    ).toHaveAttribute(
      "href",
      `/steward/list?community=${SELVA.id}&asset=a2&step=offer`,
    );
    expect(link("Bosque: Sent back. Change your offer")).toBeVisible();
    expect(within(list).getByText("“Keep more units.”")).toBeVisible();
    expect(
      link("Xochimilco Wetland: On the Marketplace. See it"),
    ).toHaveAttribute("href", `/asset/${SITE}`);
    expect(within(list).getByText(/\$21\.4723 a unit/)).toBeVisible();
    // Withdrawn land is gone for good; the last tile lists more.
    expect(within(list).queryByText("Gone")).not.toBeInTheDocument();
    expect(link("List more land")).toHaveAttribute(
      "href",
      `/steward/list?community=${SELVA.id}`,
    );
    // The sent-back offer comes first: it needs the community.
    expect(
      within(list).getAllByRole("heading", { level: 3 })[0],
    ).toHaveTextContent("Bosque");
  });

  it("withdraws a draft from its tile", async () => {
    let withdrawn = false;
    setup(
      () =>
        json(
          summary(
            withdrawn
              ? []
              : [
                  listing({
                    asset: card({ id: "a1", name: "Laguna", status: "draft" }),
                    next_action: "continue_listing",
                    manage_actions: ["edit", "withdraw"],
                  }),
                ],
          ),
        ),
      {
        "POST /assets/a1/withdraw": () => {
          withdrawn = true;
          return json(card({ id: "a1", status: "withdrawn" }));
        },
      },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Withdraw Laguna" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Withdraw listing" }),
    );
    expect(await screen.findByText("No land listed yet.")).toBeVisible();
    // The tile and its button are gone: the page's heading takes focus.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Selva Viva" }),
      ).toHaveFocus(),
    );
  });

  it("says when nothing is on the Marketplace yet", async () => {
    setup(() =>
      json(
        summary([
          listing({
            asset: card({ status: "draft" }),
            next_action: "continue_listing",
          }),
        ]),
      ),
    );
    expect(
      await screen.findByText(
        "Nothing on the Marketplace yet. Finish a listing and send its offer to the Reviewer.",
      ),
    ).toBeVisible();
  });

  it("says trading is paused when its only launched site is", async () => {
    setup(() =>
      json(
        summary([
          listing({
            asset: card({ status: "suspended" }),
            ipo_at: "2026-10-18T00:00:00Z",
            next_action: "view_on_exchange",
          }),
        ]),
      ),
    );
    expect(
      await screen.findByText("Trading is paused on its sites for now."),
    ).toBeVisible();
  });

  it("offers Edit to the owner only", async () => {
    setup(() => json({ ...summary([]), role: "steward" }));
    expect(await screen.findByText(/You're a steward/)).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Edit community/ }),
    ).not.toBeInTheDocument();
  });
});

describe("Communities", () => {
  it("lists your communities with a glimpse of their land", async () => {
    nav.search = "";
    setup(() =>
      json(
        summary([
          listing({
            asset: card({ trading: true }),
            ipo_at: "2026-10-18T00:00:00Z",
          }),
        ]),
      ),
    );
    const list = await screen.findByRole("list", { name: "Your communities" });
    const link = within(list).getByRole("link", { name: /Selva Viva/ });
    expect(link).toHaveAttribute("href", `/steward?community=${SELVA.id}`);
    expect(
      await within(link).findByText("1 site · 1 on the Marketplace"),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Start a community" }),
    ).toHaveAttribute("href", "/steward?new=1");
  });

  it("says when a community's sites didn't load", async () => {
    setup(() => json({ detail: "boom" }, { status: 503 }));
    expect(await screen.findByText("We couldn't load its sites")).toBeVisible();
  });

  it("starts another community and opens it, focused, without showing the list", async () => {
    nav.search = "new=1";
    const RIO = {
      id: "99999999-9999-4999-8999-999999999999",
      name: "Río Verde",
      country: "MX",
      description: null,
      created_at: "2026-10-19T00:00:00Z",
    };
    let mine = [SELVA];
    setup(() => json(summary([])), {
      "GET /me/communities": () => json(mine),
      "POST /communities": () => {
        mine = [SELVA, { ...RIO, role: "owner" }];
        return json(RIO, { status: 201 });
      },
      [`GET /communities/${RIO.id}/summary`]: () =>
        json({ ...summary([]), community: RIO }),
    });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Start a community",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Back to your communities" }),
    ).toHaveAttribute("href", "/steward");
    fireEvent.change(screen.getByLabelText("Community name"), {
      target: { value: "Río Verde" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create community" }));

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "Río Verde",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(nav.search).toBe(`community=${RIO.id}`);
    expect(router.replace).toHaveBeenCalledTimes(1);
  });
});
