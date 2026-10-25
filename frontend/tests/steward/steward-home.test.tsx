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

import CommunityPage from "@/app/sandbox/steward/community/page";
import StewardLayout from "@/app/sandbox/steward/layout";
import StewardPage from "@/app/sandbox/steward/page";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import type {
  CommunityMember,
  CommunitySummary,
  MyCommunity,
  WorldOut,
} from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";
import { stewardAssetId } from "@/components/shell/steward-community";
import { AccountIdCopy, COPIED_MS } from "@/components/account-id";

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
  // Like the app router: replacing the URL changes what the page reads from it.
  router.replace.mockImplementation((href: string) => {
    if (!href.startsWith("/steward")) return;
    const [path, query = ""] = href.split("?");
    nav.pathname = path!;
    nav.search = query;
  });
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
      screen.getByRole("link", { name: "List your first site" }),
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

  it("shows an account ID to share with an owner, with Copy (community settings)", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<AccountIdCopy id={ROSA.id} />);
    expect(screen.getByText(ROSA.id)).toBeVisible();
    const button = screen.getByRole("button", { name: "Copy account ID" });
    fireEvent.click(button);
    // Confirmed on the button itself, and announced politely: no toast.
    expect(await within(button).findByText("Copied")).toBeVisible();
    expect(button).toHaveAccessibleName("Copied");
    expect(
      screen.getByText("Account ID copied.").closest("[aria-live]"),
    ).toHaveAttribute("aria-live", "polite");
    expect(writeText).toHaveBeenCalledWith(ROSA.id);

    writeText.mockImplementationOnce(() => Promise.reject(new Error("denied")));
    fireEvent.click(button);
    expect(await screen.findByText(/Couldn't copy/)).toBeVisible();
    expect(button).toHaveAccessibleName("Copy account ID");
  });

  it("says Copied on the button for a moment, then Copy again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn(() => Promise.resolve()) },
        configurable: true,
      });
      render(<AccountIdCopy id={ROSA.id} />);
      const button = screen.getByRole("button", { name: "Copy account ID" });
      fireEvent.click(button);
      await waitFor(() => expect(button).toHaveAccessibleName("Copied"));
      act(() => vi.advanceTimersByTime(COPIED_MS));
      expect(button).toHaveAccessibleName("Copy account ID");
      expect(screen.queryByText("Account ID copied.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    // The edit invalidates the account's communities, so every page shows the new name.
    await waitFor(() =>
      expect(backend.calls("GET /me/communities")).toBe(before + 1),
    );
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
        screen.getByRole("link", {
          name: /See Cloud Forest on the Marketplace/,
        }),
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
