import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import ExchangeLayout from "@/app/(exchange)/layout";
import AdminLayout from "@/app/admin/layout";
import RootLayout from "@/app/layout";
import DevUiPage from "@/app/dev/ui/page";
import JudgePage from "@/app/judge/page";
import LoginPage from "@/app/login/page";
import NotFound from "@/app/not-found";
import RegisterPage from "@/app/register/page";
import StewardLayout from "@/app/steward/layout";
import { DemoBar } from "@/components/proto/demo-bar";
import { TourProvider } from "@/components/proto/tour";
import {
  StewardCommunityProvider,
  useStewardCommunity,
} from "@/components/shell/steward-community";
import { WorldProvider } from "@/components/world-provider";
import type { MyCommunity, WorldOut } from "@/lib/api/types";
import { createDataLayer, queryKeys, type DataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  ADMIN_WORLD,
  BASE,
  community,
  fakeBackend,
  json,
  sequence,
  SIGNED_IN_WORLD,
  WORLD,
} from "./lib/helpers";

const nav = vi.hoisted(() => ({ pathname: "/", search: "" }));
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
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font", className: "font" });
  return { Geist_Mono: font, Gloock: font, Hanken_Grotesk: font };
});

beforeAll(() => {
  // jsdom lacks these; Radix menus and dialogs ask for them.
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
  nav.pathname = "/";
  nav.search = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const SELVA = community();
const RIO = community({
  id: "77777777-7777-4777-8777-777777777777",
  name: "Río Claro",
  role: "steward",
});

type Routes = Parameters<typeof fakeBackend>[0];

function setup(
  ui: ReactNode,
  world: WorldOut,
  communities: MyCommunity[] = [],
  routes: Routes = {},
  prepare?: (layer: DataLayer) => void,
) {
  const backend = fakeBackend({
    "GET /world": () => json(world),
    "GET /me/communities": () => json(communities),
    ...routes,
  });
  const layer = createDataLayer({ baseUrl: BASE, fetch: backend.fetch });
  prepare?.(layer);
  render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>{ui}</TourProvider>
      </PrototypeProvider>
    </WorldProvider>,
  );
  return { backend, layer };
}

const ROSA_ID = SIGNED_IN_WORLD.me!.id;
const REMEMBERED = `nx-steward-community:${ROSA_ID}`;

const Page = () => <p>Page content</p>;

/**
 * The header's app menu (the app's name beside the lockup), opened, once the account and its
 * communities are known; null when the name is just a label (nowhere else to go).
 */
async function openAppMenu(): Promise<HTMLElement | null> {
  await screen.findByRole("button", { name: /^Account: / });
  const trigger = screen.queryByRole("button", { name: /, switch app$/ });
  if (!trigger) return null;
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

/** The other apps the app menu offers: [name, href], without the current one. */
async function switchLinks() {
  const menu = await openAppMenu();
  if (!menu) return [];
  const links = within(menu)
    .getAllByRole("menuitem")
    .filter(
      (item) =>
        item.getAttribute("aria-current") !== "page" &&
        item.textContent !== "Create a community",
    )
    .map((item) => [item.textContent, item.getAttribute("href")]);
  fireEvent.keyDown(menu, { key: "Escape" });
  return links;
}

/** Waits until the app menu offers exactly these other apps (communities load after the account). */
async function expectSwitchLinks(expected: string[][]) {
  await waitFor(async () => expect(await switchLinks()).toEqual(expected));
}

/** The app menu's "Create a community", if it offers one. */
async function createCommunityItem(): Promise<HTMLElement | null> {
  const menu = await openAppMenu();
  if (!menu) return null;
  return within(menu).queryByRole("menuitem", { name: "Create a community" });
}

describe("Exchange navigation per role", () => {
  it("anonymous: the Exchange only, and no communities request", async () => {
    const { backend } = setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      WORLD,
    );
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeVisible();
    // Nowhere else to go: the app's name is a label, not a menu.
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Exchange").tagName).toBe("SPAN");
    expect(
      screen.queryByRole("button", { name: /, switch app$/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Create a community")).not.toBeInTheDocument();
    expect(backend.calls("GET /me/communities")).toBe(0);
  });

  it("says it's a play-money sandbox in the strip above the app bar, and offers one", async () => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      WORLD,
    );
    const banner = await screen.findByRole("banner");
    // Not beside the app's name any more: in the strip above, on every page and width.
    expect(
      within(banner).queryByText("Sandbox · play money only"),
    ).not.toBeInTheDocument();
    const line = screen.getByText("Sandbox · play money only");
    expect(line).not.toHaveClass("hidden");
    expect(line).not.toHaveClass("sr-only");
    expect(
      await screen.findByRole("link", { name: /Try it in your own sandbox/ }),
    ).toHaveAttribute("href", "/sandbox");
  });

  it("leaves the strip out inside a visitor's sandbox, where the sandbox bar says it", async () => {
    nav.pathname = "/sandbox";
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
    );
    await screen.findByRole("button", { name: /^Account: / });
    expect(
      screen.queryByText("Sandbox · play money only"),
    ).not.toBeInTheDocument();
  });

  it("offers a signed-in account no sandbox of its own in the strip", async () => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
    );
    await screen.findByRole("button", { name: /^Account: / });
    expect(screen.getByText("Sandbox · play money only")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: /Try it in your own sandbox/ }),
    ).not.toBeInTheDocument();
  });

  it("anonymous in the scripted demo: Stewards too", async () => {
    window.sessionStorage.setItem("nx-prototype-demo", "1");
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      WORLD,
    );
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "Exchange, switch app" }),
      { key: "Enter" },
    );
    expect(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Stewards",
      }),
    ).toHaveAttribute("href", "/steward");
  });

  it("investor: the Exchange and Create a community", async () => {
    const { backend } = setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
    );
    expect(await createCommunityItem()).toHaveAttribute("href", "/steward");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(await switchLinks()).toEqual([]);
    expect(backend.calls("GET /me/communities")).toBe(1);
  });

  it("names the app in the home link, and marks the current app in its menu", async () => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
    );
    expect(
      await screen.findByRole("link", { name: "WildWorth Exchange" }),
    ).toHaveAttribute("href", "/");
    const menu = await openAppMenu();
    expect(
      within(menu!).getByRole("menuitem", { name: "Exchange" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["steward", RIO],
    ["owner", SELVA],
  ])("%s: the switcher to Stewards", async (_role, member) => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
      [member],
    );
    expect(await switchLinks()).toEqual([["Stewards", "/steward"]]);
    expect(await createCommunityItem()).toBeNull();
  });

  it("admin: Admin, plus Create a community without one", async () => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      ADMIN_WORLD,
    );
    expect(await createCommunityItem()).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(await switchLinks()).toEqual([["Control room", "/admin"]]);
  });

  it("admin and community member: Stewards and Admin", async () => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      ADMIN_WORLD,
      [SELVA],
    );
    await expectSwitchLinks([
      ["Stewards", "/steward"],
      ["Control room", "/admin"],
    ]);
  });

  it("marks the current page", async () => {
    nav.pathname = "/portfolio";
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      WORLD,
    );
    const pages = screen.getByRole("navigation", {
      name: "Exchange navigation",
    });
    expect(
      within(pages).getByRole("link", { name: "Your stakes" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(pages).getByRole("link", { name: "Rated sites" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(pages).getByRole("link", { name: "AI at work" }),
    ).toHaveAttribute("href", "/ai");
  });

  it("marks AI at work on its page", async () => {
    nav.pathname = "/ai";
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      WORLD,
    );
    const pages = screen.getByRole("navigation", {
      name: "Exchange navigation",
    });
    expect(
      within(pages).getByRole("link", { name: "AI at work" }),
    ).toHaveAttribute("aria-current", "page");
  });
});

describe("Steward shell", () => {
  it("shows a member the pages, its community and the way back", async () => {
    nav.pathname = "/steward";
    setup(
      <StewardLayout>
        <Page />
      </StewardLayout>,
      SIGNED_IN_WORLD,
      [SELVA],
    );
    expect(await screen.findByText("Page content")).toBeVisible();
    expect(screen.getByText("Selva Viva")).toBeVisible();
    expect(screen.getByText("Owner")).toBeVisible();
    // One community: a label, not a menu.
    expect(
      screen.queryByRole("button", { name: /switch community/i }),
    ).not.toBeInTheDocument();
    expect(await switchLinks()).toEqual([["Exchange", "/"]]);
    expect(
      within(
        screen.getByRole("navigation", { name: "Stewards navigation" }),
      ).getByRole("link", { name: "Community home" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("switches between communities and remembers the choice", async () => {
    nav.pathname = "/steward";
    setup(
      <StewardLayout>
        <Page />
      </StewardLayout>,
      SIGNED_IN_WORLD,
      [SELVA, RIO],
    );
    const trigger = await screen.findByRole("button", {
      name: "Selva Viva, switch community",
    });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "Selva VivaOwner",
      "Río ClaroSteward",
    ]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.click(items[1]!);

    expect(
      await screen.findByRole("button", {
        name: "Río Claro, switch community",
      }),
    ).toBeVisible();
    expect(window.localStorage.getItem(REMEMBERED)).toBe(RIO.id);
    expect(router.replace).toHaveBeenCalledWith(
      `/steward?community=${RIO.id}`,
      { scroll: false },
    );
  });

  it("opens on the remembered community, if still a member", async () => {
    window.localStorage.setItem(REMEMBERED, RIO.id);
    nav.pathname = "/steward";
    setup(
      <StewardLayout>
        <Page />
      </StewardLayout>,
      SIGNED_IN_WORLD,
      [SELVA, RIO],
    );
    expect(
      await screen.findByRole("button", {
        name: "Río Claro, switch community",
      }),
    ).toBeVisible();
  });

  it("keeps the shown community in Steward links", async () => {
    nav.pathname = "/steward";
    setup(
      <StewardLayout>
        <Page />
      </StewardLayout>,
      SIGNED_IN_WORLD,
      [SELVA, RIO],
    );
    await screen.findByRole("button", { name: "Selva Viva, switch community" });
    const pages = screen.getByRole("navigation", {
      name: "Stewards navigation",
    });
    expect(
      within(pages).getByRole("link", { name: "List your land" }),
    ).toHaveAttribute("href", `/steward/list?community=${SELVA.id}`);
    expect(
      screen.getByRole("link", { name: /^WildWorth\s*Stewards$/ }),
    ).toHaveAttribute("href", `/steward?community=${SELVA.id}`);
  });

  it("lets the URL win over the remembered community", async () => {
    window.localStorage.setItem(REMEMBERED, SELVA.id);
    nav.pathname = "/steward";
    nav.search = `community=${RIO.id}`;
    setup(
      <StewardLayout>
        <Page />
      </StewardLayout>,
      SIGNED_IN_WORLD,
      [SELVA, RIO],
    );
    expect(
      await screen.findByRole("button", {
        name: "Río Claro, switch community",
      }),
    ).toBeVisible();
  });

  it.each([
    ["a tampered remembered ID", "", "not-a-member"],
    ["a community in the URL the account isn't in", "community=other", ""],
  ])("falls back to the first community for %s", async (_case, search, id) => {
    if (id) window.localStorage.setItem(REMEMBERED, id);
    nav.pathname = "/steward";
    nav.search = search;
    setup(
      <StewardLayout>
        <Page />
      </StewardLayout>,
      SIGNED_IN_WORLD,
      [SELVA, RIO],
    );
    expect(
      await screen.findByRole("button", {
        name: "Selva Viva, switch community",
      }),
    ).toBeVisible();
  });

  it("shows the remembered community from the first render", async () => {
    window.localStorage.setItem(REMEMBERED, RIO.id);
    nav.pathname = "/steward";
    const seen: (string | null)[] = [];
    function Probe() {
      seen.push(useStewardCommunity().active?.id ?? null);
      return <p>Probe</p>;
    }
    // Arriving from another page: the world and the communities are already known.
    const backend = fakeBackend({
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /me/communities": () => json([SELVA, RIO]),
    });
    const layer = createDataLayer({ baseUrl: BASE, fetch: backend.fetch });
    layer.session.set(SIGNED_IN_WORLD);
    await layer.cache.fetch(queryKeys.myCommunities(ROSA_ID), () =>
      Promise.resolve([SELVA, RIO]),
    );
    render(
      <WorldProvider dataLayer={layer}>
        <PrototypeProvider>
          <StewardCommunityProvider>
            <Probe />
          </StewardCommunityProvider>
        </PrototypeProvider>
      </WorldProvider>,
    );
    await waitFor(() => expect(seen).toContain(RIO.id));
    expect(seen[0]).toBe(RIO.id);
    expect(new Set(seen)).toEqual(new Set([RIO.id]));
  });

  it("shows an account without a community how to start one", async () => {
    nav.pathname = "/steward";
    setup(
      <StewardLayout>
        <Page />
      </StewardLayout>,
      SIGNED_IN_WORLD,
    );
    const title = await screen.findByRole("heading", {
      level: 1,
      name: "Start a community",
    });
    expect(title).toBeVisible();
    // Shrinkable columns: a long ID or name can't widen the page at 390 px.
    expect(
      screen
        .getByRole("region", { name: "Start a community" })
        .querySelector(":scope > .grid"),
    ).toHaveClass(
      "grid-cols-[minmax(0,1fr)]",
      "lg:grid-cols-[minmax(0,1fr)_440px]",
    );
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
    // Its pages would all show this empty state, so they aren't offered.
    expect(
      screen.queryByRole("navigation", { name: "Stewards navigation" }),
    ).not.toBeInTheDocument();
    // Already in Stewards: no second "Create a community" in the header.
    expect(screen.queryByText("Create a community")).not.toBeInTheDocument();
    expect(await switchLinks()).toEqual([["Exchange", "/"]]);
  });

  it("explains a failed communities request and retries", async () => {
    nav.pathname = "/steward";
    let fail = true;
    const backend = fakeBackend({
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /me/communities": () =>
        fail ? json({ detail: "boom" }, { status: 503 }) : json([community()]),
    });
    render(
      <WorldProvider
        dataLayer={createDataLayer({ baseUrl: BASE, fetch: backend.fetch })}
      >
        <PrototypeProvider>
          <TourProvider>
            <StewardLayout>
              <Page />
            </StewardLayout>
          </TourProvider>
        </PrototypeProvider>
      </WorldProvider>,
    );
    expect(
      await screen.findByText("We couldn't load your communities"),
    ).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Page content")).toBeVisible();
  });
});

describe("Admin shell", () => {
  it("offers an admin the other apps they can open", async () => {
    nav.pathname = "/admin";
    setup(
      <AdminLayout>
        <Page />
      </AdminLayout>,
      ADMIN_WORLD,
      [RIO],
    );
    expect(await screen.findByText("Page content")).toBeVisible();
    expect(await switchLinks()).toEqual([
      ["Exchange", "/"],
      ["Stewards", "/steward"],
    ]);
    expect(
      within(
        screen.getByRole("navigation", { name: "Control room navigation" }),
      ).getByRole("link", { name: "Time Machine" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("shows a non-admin the 403 message and no Admin link", async () => {
    nav.pathname = "/admin";
    setup(
      <AdminLayout>
        <Page />
      </AdminLayout>,
      SIGNED_IN_WORLD,
      [SELVA],
    );
    expect(
      await screen.findByText("The control room is for platform admins"),
    ).toBeVisible();
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
    await expectSwitchLinks([
      ["Exchange", "/"],
      ["Stewards", "/steward"],
    ]);
  });
});

describe("mobile menu", () => {
  it("holds the pages, the communities and the apps, and closes on navigation", async () => {
    nav.pathname = "/steward/list";
    setup(
      <StewardLayout>
        <Page />
      </StewardLayout>,
      ADMIN_WORLD,
      [SELVA, RIO],
    );
    await screen.findByText("Page content");
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const sheet = await screen.findByRole("dialog", {
      name: "WildWorth Stewards",
    });
    expect(
      within(sheet).getByRole("link", { name: "List your land" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(sheet).getByRole("button", {
        name: "Selva Viva, switch community",
      }),
    ).toBeVisible();
    const apps = within(sheet).getByRole("navigation", { name: "Switch app" });
    expect(
      within(apps)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Exchange", "Control room"]);

    fireEvent.click(within(apps).getByRole("link", { name: "Exchange" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("offers an investor Create a community", async () => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
    );
    await screen.findByRole("button", { name: /^Account: / });
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const sheet = await screen.findByRole("dialog", {
      name: "WildWorth Exchange",
    });
    expect(
      await within(sheet).findByRole("link", { name: "Create a community" }),
    ).toHaveAttribute("href", "/steward");
  });
});

describe("when the account changes", () => {
  async function signOut() {
    fireEvent.keyDown(
      await screen.findByRole("button", { name: /^Account: / }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /sign out/i }));
    await screen.findByRole("link", { name: "Sign in" });
  }

  it.each([
    ["a member", [SELVA], true],
    ["an investor", [], false],
  ])(
    "signing out %s never asks for communities anonymously",
    async (_who, communities, member) => {
      window.localStorage.setItem(REMEMBERED, SELVA.id);
      const { backend } = setup(
        <ExchangeLayout>
          <Page />
        </ExchangeLayout>,
        SIGNED_IN_WORLD,
        communities,
        {
          "GET /world": sequence(
            () => json(SIGNED_IN_WORLD),
            () => json(WORLD),
          ),
          "POST /auth/logout": () => new Response(null, { status: 204 }),
        },
      );
      if (member) await expectSwitchLinks([["Stewards", "/steward"]]);
      else
        await waitFor(async () =>
          expect(await createCommunityItem()).toBeVisible(),
        );
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(backend.calls("GET /me/communities")).toBe(1);

      await signOut();
      // Anonymous again: the app's name is a label; no apps, no Create a community.
      expect(
        screen.queryByRole("button", { name: /, switch app$/ }),
      ).not.toBeInTheDocument();
      // Give any stray refetch time to land.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(backend.calls("GET /me/communities")).toBe(1);
      expect(window.localStorage.getItem(REMEMBERED)).toBeNull();
    },
  );

  it("never shows a member's communities to the next account", async () => {
    const INVESTOR: WorldOut = {
      ...SIGNED_IN_WORLD,
      me: {
        ...SIGNED_IN_WORLD.me!,
        id: "88888888-8888-4888-8888-888888888888",
        name: "Ines",
      },
    };
    let answerInvestor!: (response: Response) => void;
    const { backend, layer } = setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
      [],
      {
        "GET /world": sequence(
          () => json(SIGNED_IN_WORLD),
          () => json(INVESTOR),
        ),
        "GET /me/communities": sequence(
          () => json([SELVA]),
          () => new Promise<Response>((resolve) => (answerInvestor = resolve)),
        ),
      },
    );
    await expectSwitchLinks([["Stewards", "/steward"]]);

    await act(() => layer.session.reload());
    const account = await screen.findByRole("button", {
      name: "Account: Ines",
    });
    // Just her initials, drawn by CSS (not text); the name is in its accessible name and menu.
    expect(account.textContent!.trim()).toBe("");
    // Ines's answer hasn't come back: nothing from Rosa, nothing guessed.
    await waitFor(() => expect(backend.calls("GET /me/communities")).toBe(2));
    expect(
      screen.queryByRole("button", { name: /, switch app$/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Create a community")).not.toBeInTheDocument();

    await act(async () => answerInvestor(json([])));
    await waitFor(async () =>
      expect(await createCommunityItem()).toBeVisible(),
    );
    expect(
      within(screen.getByRole("menu")).queryByRole("menuitem", {
        name: "Stewards",
      }),
    ).not.toBeInTheDocument();
  });

  it("still offers Stewards when the communities can't be read", async () => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
      [],
      {
        "GET /me/communities": () => json({ detail: "boom" }, { status: 503 }),
      },
    );
    await expectSwitchLinks([["Stewards", "/steward"]]);
    expect(await createCommunityItem()).toBeNull();
  });
});

describe("play-money framing without a demo bar", () => {
  const FOOTER = "Nothing here is a real security";

  it.each([
    ["Exchange", <ExchangeLayout key="e">{<Page />}</ExchangeLayout>],
    ["Steward", <StewardLayout key="s">{<Page />}</StewardLayout>],
    ["Admin", <AdminLayout key="a">{<Page />}</AdminLayout>],
  ])(
    "the %s shell says it's play money in its footer, with a skip link",
    (_shell, shell) => {
      const html = renderToString(<RootLayout>{shell}</RootLayout>);
      expect(html).toContain(FOOTER);
      expect(html).not.toContain("Demo mode");
      expect(html).toContain('href="#main"');
      expect(html.match(/id="main"/g)).toHaveLength(1);
    },
  );

  it.each([
    ["/login", async () => LoginPage({ searchParams: Promise.resolve({}) })],
    [
      "/register",
      async () => RegisterPage({ searchParams: Promise.resolve({}) }),
    ],
    ["/judge", async () => <JudgePage />],
    ["/dev/ui", async () => <DevUiPage />],
    ["404", async () => <NotFound />],
  ])("%s has one #main skip target", async (_path, page) => {
    const html = renderToString(<RootLayout>{await page()}</RootLayout>);
    expect(html).toContain('href="#main"');
    expect(html.match(/id="main"/g)).toHaveLength(1);
  });

  it("signing up says it's play money too", async () => {
    const page = await RegisterPage({ searchParams: Promise.resolve({}) });
    const html = renderToString(<RootLayout>{page}</RootLayout>);
    expect(html).toMatch(/[Pp]lay money/);
  });

  it.each([
    ["anonymous", WORLD],
    ["signed in", SIGNED_IN_WORLD],
  ] as const)("the real app shows no demo bar %s", async (_who, world) => {
    const { backend } = setup(<DemoBar />, world, [], {
      "POST /auth/logout": () => new Response(null, { status: 204 }),
    });
    await waitFor(() => expect(backend.calls("GET /world")).toBe(1));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    // A real account is never signed out by the leftover-demo cleanup.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(backend.calls("POST /auth/logout")).toBe(0);
  });

  it("leaves the scripted prototype demo", async () => {
    window.sessionStorage.setItem("nx-prototype-demo", "1");
    setup(<DemoBar />, WORLD);
    await waitFor(() =>
      expect(window.sessionStorage.getItem("nx-prototype-demo")).toBeNull(),
    );
  });

  it("signs out a demo session left in the real app's cookie", async () => {
    const leftover: WorldOut = {
      ...WORLD,
      me: { ...SIGNED_IN_WORLD.me!, kind: "persona", persona: "arjun" },
    };
    const { backend } = setup(<DemoBar />, leftover, [], {
      "POST /auth/logout": () => new Response(null, { status: 204 }),
    });
    await waitFor(() => expect(backend.calls("POST /auth/logout")).toBe(1));
  });
});
