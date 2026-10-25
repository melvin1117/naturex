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
import ListingsPage from "@/app/sandbox/steward/listings/page";
import StewardPage from "@/app/sandbox/steward/page";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import type {
  CommunitySummary,
  ListingSummary,
  MyCommunity,
} from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import { IMAGERY_ATTRIBUTION } from "@/lib/imagery";
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

const nav = vi.hoisted(() => ({ pathname: "/steward/listings", search: "" }));
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
  nav.pathname = "/steward/listings";
  nav.search = "";
  window.localStorage.clear();
});

const SELVA = community();
const OUTLINE = [
  [
    [-99.1, 19.3],
    [-99.09, 19.3],
    [-99.09, 19.31],
    [-99.1, 19.3],
  ],
];
const WALLET = {
  balance: "0.00",
  ipo_proceeds: "0.00",
  community_fund_payouts: "0.00",
  retained_dividends: "0.00",
  total_received: "0.00",
};

let counter = 0;
function listing(
  name: string,
  status: ListingSummary["asset"]["status"],
  overrides: Partial<ListingSummary> = {},
): ListingSummary {
  counter += 1;
  return {
    asset: {
      id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
      name,
      status,
      trading: false,
      area_ha: "120.00",
      sparkline: [],
      outline: OUTLINE,
      mock: true,
    } as ListingSummary["asset"],
    next_action: "none",
    verification: { level: "unverified", in_review: false, required: true },
    ipo_at: null,
    updated_at: "2026-10-20T10:00:00Z",
    manage_actions: [],
    wallet: WALLET,
    holders: { count: 0, shares_held: 0, top: [] },
    shares: null,
    recommendations: [],
    report_version: null,
    ...overrides,
  };
}

const DRAFT = listing("Humedal Norte", "draft", {
  next_action: "continue_listing",
  manage_actions: ["edit", "withdraw"],
  updated_at: "2026-10-21T10:00:00Z",
});
const RATING = listing("Bosque Alto", "rating", {
  next_action: "rating_in_progress",
});
const WAITING = listing("Laguna Viva", "listed", { next_action: "verify" });
const LIVE = listing("Manglar Sur", "listed", {
  next_action: "view_on_exchange",
  ipo_at: "2026-10-10T00:00:00Z",
});
const CLOSED = listing("Cerro Viejo", "withdrawn");

function summary(
  listings: ListingSummary[],
  overrides: Partial<CommunitySummary> = {},
): CommunitySummary {
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
    ...overrides,
  };
}

type Routes = Parameters<typeof fakeBackend>[0];

function setup(
  routes: Routes,
  {
    page = <ListingsPage />,
    communities = [SELVA],
  }: { page?: ReactNode; communities?: MyCommunity[] } = {},
) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    "GET /me/communities": () => json(communities),
    [`GET /communities/${SELVA.id}/members`]: () => json([]),
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
  render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>
          {/* The sandbox shell holds the page in <main>. */}
          <main>
            <StewardLayout>{page}</StewardLayout>
          </main>
        </TourProvider>
      </PrototypeProvider>
    </WorldProvider>,
  );
  return backend;
}

const SUMMARY = `GET /communities/${SELVA.id}/summary`;
const flow = (item: ListingSummary) =>
  `/steward/list?community=${SELVA.id}&asset=${item.asset.id}`;

function group(name: string) {
  return screen.getByRole("region", { name: new RegExp(`^${name}`) });
}

function row(name: string) {
  return screen.getByRole("heading", { name, level: 3 }).closest("li")!;
}

describe("the Listings page", () => {
  it("groups listings by where they stand, with plain words and the next step", async () => {
    setup({
      [SUMMARY]: () => json(summary([RATING, WAITING, LIVE, CLOSED, DRAFT])),
    });
    await screen.findByRole("heading", { name: "Humedal Norte" });
    expect(
      screen.getByRole("heading", { name: "Listings", level: 1 }),
    ).toBeVisible();

    const inProgress = within(group("In progress"));
    // The most recently changed first.
    expect(
      inProgress
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Humedal Norte", "Bosque Alto", "Laguna Viva"]);
    expect(
      within(row("Humedal Norte")).getByText("Draft: not submitted yet"),
    ).toBeVisible();
    expect(within(row("Bosque Alto")).getByText("Being rated")).toBeVisible();
    expect(
      within(row("Laguna Viva")).getByText("Waiting for verification"),
    ).toBeVisible();
    expect(within(row("Manglar Sur")).getByText("Live")).toBeVisible();

    // A draft continues where it stopped, or opens on its details.
    expect(
      screen.getByRole("link", { name: "Continue: Humedal Norte" }),
    ).toHaveAttribute("href", flow(DRAFT));
    expect(
      screen.getByRole("link", { name: "Edit details: Humedal Norte" }),
    ).toHaveAttribute("href", `${flow(DRAFT)}&step=details`);
    // Being rated: only its progress; the API offered nothing to change.
    expect(
      within(row("Bosque Alto")).queryByRole("button", { name: /Withdraw/ }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "View progress: Bosque Alto" }),
    ).toHaveAttribute("href", flow(RATING));
    expect(
      screen.getByRole("link", { name: "View on Marketplace: Manglar Sur" }),
    ).toHaveAttribute("href", `/asset/${LIVE.asset.id}`);
    expect(screen.getByText(`Site maps: ${IMAGERY_ATTRIBUTION}`)).toBeVisible();

    // Closed is collapsed until asked for.
    const toggle = screen.getByRole("button", { name: /Closed/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Cerro Viejo" })).toBeNull();
    fireEvent.click(toggle);
    expect(within(row("Cerro Viejo")).getByText("Withdrawn")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "View: Cerro Viejo" }),
    ).toHaveAttribute("href", flow(CLOSED));
  });

  it("teaches what to do when there's nothing yet", async () => {
    setup({ [SUMMARY]: () => json(summary([])) });
    expect(
      await screen.findByRole("heading", { name: "No listings yet" }),
    ).toBeVisible();
    // The page's button and the empty state's link both lead to the listing flow.
    const links = within(screen.getByRole("main")).getAllByRole("link", {
      name: "List your land",
    });
    expect(links.length).toBeGreaterThan(1);
    for (const link of links)
      expect(link).toHaveAttribute(
        "href",
        `/steward/list?community=${SELVA.id}`,
      );
  });

  it("offers no changes to someone who isn't a member", async () => {
    setup({
      [SUMMARY]: () => json(summary([DRAFT], { role: null })),
    });
    await screen.findByRole("heading", { name: "Humedal Norte" });
    expect(screen.queryByRole("button", { name: /Withdraw/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Edit details/ })).toBeNull();
    expect(
      screen.getByRole("link", { name: "View: Humedal Norte" }),
    ).toBeVisible();
  });
});

describe("withdrawing a listing", () => {
  it("confirms what happens, then moves it to Closed in place", async () => {
    let withdrawn = false;
    let release: () => void = () => {};
    const backend = setup({
      [SUMMARY]: () =>
        json(
          summary(
            withdrawn
              ? [
                  {
                    ...DRAFT,
                    asset: { ...DRAFT.asset, status: "withdrawn" },
                    next_action: "none",
                    manage_actions: [],
                  },
                ]
              : [DRAFT],
          ),
        ),
      [`POST /assets/${DRAFT.asset.id}/withdraw`]: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        withdrawn = true;
        return json({ id: DRAFT.asset.id, status: "withdrawn" });
      },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Withdraw Humedal Norte" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Withdraw Humedal Norte?",
    });
    expect(dialog).toHaveTextContent("moves to Closed");
    expect(dialog).toHaveTextContent("Nothing is deleted");
    expect(dialog).toHaveTextContent(
      "no one holds units and no payouts change",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Withdraw listing" }),
    );
    const pending = await within(dialog).findByRole("button", {
      name: "Withdrawing…",
    });
    expect(pending).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Keep it" }),
    ).toBeDisabled();
    release();

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(backend.calls(`POST /assets/${DRAFT.asset.id}/withdraw`)).toBe(1);
    const heading = await screen.findByRole("heading", {
      name: "Humedal Norte",
    });
    expect(screen.getByRole("button", { name: /Closed/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading.closest("li")!.firstElementChild).toHaveClass("ww-wash");
    expect(
      within(heading.closest("li")!).getByText("Withdrawn just now"),
    ).toBeVisible();
    expect(
      screen.getByText("Humedal Norte was withdrawn. It's under Closed now."),
    ).toHaveAttribute("role", "status");
  });

  it("focuses each withdrawn listing in turn, the second one too", async () => {
    const SECOND = listing("Bosque Bajo", "draft", {
      next_action: "continue_listing",
      manage_actions: ["edit", "withdraw"],
    });
    const gone = new Set<string>();
    const closed = (item: ListingSummary): ListingSummary =>
      gone.has(item.asset.id)
        ? {
            ...item,
            asset: { ...item.asset, status: "withdrawn" },
            next_action: "none",
            manage_actions: [],
          }
        : item;
    const withdraw = (item: ListingSummary) => () => {
      gone.add(item.asset.id);
      return json({ id: item.asset.id, status: "withdrawn" });
    };
    setup({
      [SUMMARY]: () => json(summary([DRAFT, SECOND].map(closed))),
      [`POST /assets/${DRAFT.asset.id}/withdraw`]: withdraw(DRAFT),
      [`POST /assets/${SECOND.asset.id}/withdraw`]: withdraw(SECOND),
    });

    for (const name of ["Humedal Norte", "Bosque Bajo"]) {
      fireEvent.click(
        await screen.findByRole("button", { name: `Withdraw ${name}` }),
      );
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Withdraw listing" }),
      );
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      const heading = screen.getByRole("heading", { name, level: 3 });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(
        within(heading.closest("li")!).getByText("Withdrawn just now"),
      ).toBeVisible();
      expect(
        screen.getByText(`${name} was withdrawn. It's under Closed now.`),
      ).toBeInTheDocument();
    }
  });

  it("keeps the dialog open with a plain reason when the API refuses", async () => {
    setup({
      [SUMMARY]: () => json(summary([DRAFT])),
      [`POST /assets/${DRAFT.asset.id}/withdraw`]: () =>
        json({ detail: "run_in_progress" }, { status: 409 }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Withdraw Humedal Norte" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Withdraw listing" }),
    );
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("A rating is running");
    expect(alert).toHaveTextContent("Wait for the rating to finish");
    expect(
      within(dialog).getByRole("button", { name: "Withdraw listing" }),
    ).toBeEnabled();
  });
});

describe("the Community home", () => {
  it("links to Listings with the count of unfinished ones", async () => {
    nav.pathname = "/steward";
    setup(
      {
        [SUMMARY]: () =>
          json(
            summary([
              DRAFT,
              { ...DRAFT, asset: { ...DRAFT.asset, id: "x" } },
              LIVE,
            ]),
          ),
      },
      { page: <StewardPage /> },
    );
    // Beside the nav's own Listings link, the home's says what's unfinished.
    const link = await screen.findByRole("link", { name: "Listings 2 drafts" });
    expect(link).toHaveAttribute(
      "href",
      `/steward/listings?community=${SELVA.id}`,
    );
  });
});
