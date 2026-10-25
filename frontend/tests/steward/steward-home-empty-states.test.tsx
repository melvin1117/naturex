import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import StewardLayout from "@/app/sandbox/steward/layout";
import StewardPage from "@/app/sandbox/steward/page";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import type {
  AssetCard,
  CommunitySummary,
  ListingSummary,
} from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  BASE,
  community,
  createFakeEventSource,
  FakeEventSource,
  fakeBackend,
  json,
  SIGNED_IN_WORLD,
} from "../lib/helpers";

/** WP4 (#216): the steward home's loading state and empty states that teach. */

const nav = vi.hoisted(() => ({ pathname: "/steward", search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
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
  FakeEventSource.reset();
  window.localStorage.clear();
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

function setup(summaryResponse: () => Response | Promise<Response>) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    "GET /me/communities": () => json([SELVA]),
    [`GET /communities/${SELVA.id}/members`]: () => json([]),
    [`GET /communities/${SELVA.id}/summary`]: summaryResponse,
    "GET /alerts": () =>
      json({ alerts: [], unread_count: 0, next_before: null }),
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
          {/* The sandbox shell holds the page in <main>. */}
          <main>
            <StewardLayout>{content}</StewardLayout>
          </main>
        </TourProvider>
      </PrototypeProvider>
    </WorldProvider>
  );
  render(tree(<StewardPage />));
  return backend;
}

function panel(name: string) {
  return screen.findByRole("region", { name });
}

describe("steward home loading", () => {
  it("shows the home's shape with one status while the summary loads", async () => {
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
});

describe("steward home empty states", () => {
  it("doesn't ask a rated site's steward to wait for a rating (#216)", async () => {
    setup(() => json(summary([listing()])));
    const actions = await panel("Recovery plan");
    expect(actions).toHaveTextContent(
      "Mock ratings don't include the Auditor's recommendations. A live rating may list concrete steps here that would strengthen the grade.",
    );
    expect(actions).not.toHaveTextContent(/once a site has been rated/);
  });

  it("explains what a payout needs before the opening offer", async () => {
    setup(() => json(summary([listing()])));
    expect(await panel("Quarterly payouts")).toHaveTextContent(
      /^Quarterly payouts\s*Payouts start after a site's opening offer/,
    );
  });

  it("names the next quarter once a site is open to supporters", async () => {
    setup(() =>
      json(
        summary([
          listing({
            asset: card({ trading: true, mock: false }),
            next_action: "view_on_exchange",
            ipo_at: "2026-10-10T00:00:00Z",
          }),
        ]),
      ),
    );
    expect(await panel("Quarterly payouts")).toHaveTextContent(
      "The first payout comes when the next quarter runs",
    );
    expect(await panel("Recovery plan")).toHaveTextContent(
      "The latest rating lists no recovery steps.",
    );
  });

  it("lists the Auditor's recommendations when there are some", async () => {
    setup(() =>
      json(summary([listing({ recommendations: ["Fence the riverbank"] })])),
    );
    const actions = await panel("Recovery plan");
    expect(within(actions).getByText("Fence the riverbank")).toBeVisible();
    expect(actions).not.toHaveTextContent(/Mock ratings/);
  });
});
