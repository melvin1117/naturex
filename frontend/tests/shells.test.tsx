import {
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
import LoginPage from "@/app/login/page";
import StewardLayout from "@/app/steward/layout";
import { DemoBar } from "@/components/proto/demo-bar";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import type { MyCommunity, WorldOut } from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  ADMIN_WORLD,
  BASE,
  community,
  fakeBackend,
  json,
  SIGNED_IN_WORLD,
  WORLD,
} from "./lib/helpers";

const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font", className: "font" });
  return { Geist_Mono: font, Hanken_Grotesk: font, Instrument_Serif: font };
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
  nav.pathname = "/";
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const SELVA = community();
const RIO = community({
  id: "77777777-7777-4777-8777-777777777777",
  name: "Río Claro",
  role: "steward",
});

function setup(
  ui: ReactNode,
  world: WorldOut,
  communities: MyCommunity[] = [],
) {
  const backend = fakeBackend({
    "GET /world": () => json(world),
    "GET /me/communities": () => json(communities),
  });
  const layer = createDataLayer({ baseUrl: BASE, fetch: backend.fetch });
  render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>{ui}</TourProvider>
      </PrototypeProvider>
    </WorldProvider>,
  );
  return { backend };
}

const Page = () => <p>Page content</p>;

/** The header's "Switch app" links, once the account (and its communities) are known. */
async function switchLinks() {
  await screen.findByRole("button", { name: /^Account: / });
  const switcher = screen.queryByRole("navigation", { name: "Switch app" });
  if (!switcher) return [];
  return within(switcher)
    .getAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);
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
    expect(
      screen.queryByRole("navigation", { name: "Switch app" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Create a community")).not.toBeInTheDocument();
    expect(backend.calls("GET /me/communities")).toBe(0);
  });

  it("anonymous in the scripted demo: the Steward app too", async () => {
    window.sessionStorage.setItem("nx-prototype-demo", "1");
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      WORLD,
    );
    const switcher = await screen.findByRole("navigation", {
      name: "Switch app",
    });
    expect(
      within(switcher).getByRole("link", { name: "Steward app" }),
    ).toHaveAttribute("href", "/steward");
  });

  it("investor: the Exchange and Create a community", async () => {
    const { backend } = setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
    );
    expect(
      await screen.findByRole("link", { name: "Create a community" }),
    ).toHaveAttribute("href", "/steward");
    expect(await switchLinks()).toEqual([]);
    expect(backend.calls("GET /me/communities")).toBe(1);
  });

  it.each([
    ["steward", RIO],
    ["owner", SELVA],
  ])("%s: the switcher to the Steward app", async (_role, member) => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      SIGNED_IN_WORLD,
      [member],
    );
    await screen.findByRole("navigation", { name: "Switch app" });
    expect(await switchLinks()).toEqual([["Steward app", "/steward"]]);
    expect(screen.queryByText("Create a community")).not.toBeInTheDocument();
  });

  it("admin: Admin, plus Create a community without one", async () => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      ADMIN_WORLD,
    );
    expect(
      await screen.findByRole("link", { name: "Create a community" }),
    ).toBeVisible();
    expect(await switchLinks()).toEqual([["Admin", "/admin"]]);
  });

  it("admin and community member: the Steward app and Admin", async () => {
    setup(
      <ExchangeLayout>
        <Page />
      </ExchangeLayout>,
      ADMIN_WORLD,
      [SELVA],
    );
    await screen.findByRole("link", { name: "Steward app" });
    expect(await switchLinks()).toEqual([
      ["Steward app", "/steward"],
      ["Admin", "/admin"],
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
      within(pages).getByRole("link", { name: "Marketplace" }),
    ).not.toHaveAttribute("aria-current");
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
        screen.getByRole("navigation", { name: "Steward navigation" }),
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
      name: "Community: Selva Viva. Switch community",
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
        name: "Community: Río Claro. Switch community",
      }),
    ).toBeVisible();
    expect(window.localStorage.getItem("nx-steward-community")).toBe(RIO.id);
  });

  it("opens on the remembered community, if still a member", async () => {
    window.localStorage.setItem("nx-steward-community", RIO.id);
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
        name: "Community: Río Claro. Switch community",
      }),
    ).toBeVisible();
  });

  it("shows an account without a community how to start one", async () => {
    nav.pathname = "/steward";
    setup(
      <StewardLayout>
        <Page />
      </StewardLayout>,
      SIGNED_IN_WORLD,
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Start a community",
      }),
    ).toBeVisible();
    expect(screen.queryByText("Page content")).not.toBeInTheDocument();
    // Its pages would all show this empty state, so they aren't offered.
    expect(
      screen.queryByRole("navigation", { name: "Steward navigation" }),
    ).not.toBeInTheDocument();
    // Already in the Steward app: no second "Create a community" in the header.
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
      ["Steward app", "/steward"],
    ]);
    expect(
      within(
        screen.getByRole("navigation", { name: "Control room navigation" }),
      ).getByRole("link", { name: "Time Machine" }),
    ).toHaveAttribute("aria-current", "page");
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
      name: "NatureX Steward",
    });
    expect(
      within(sheet).getByRole("link", { name: "List land" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(sheet).getByRole("button", {
        name: "Community: Selva Viva. Switch community",
      }),
    ).toBeVisible();
    const apps = within(sheet).getByRole("navigation", { name: "Switch app" });
    expect(
      within(apps)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Exchange", "Admin"]);

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
    await screen.findAllByRole("link", { name: "Create a community" });
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const sheet = await screen.findByRole("dialog", {
      name: "NatureX Exchange",
    });
    expect(
      within(sheet).getByRole("link", { name: "Create a community" }),
    ).toHaveAttribute("href", "/steward");
  });
});

describe("sandbox banner", () => {
  const NOTICE = "Sandbox: play money, not a real security.";

  it.each([
    ["Exchange", <ExchangeLayout key="e">{<Page />}</ExchangeLayout>],
    ["Steward", <StewardLayout key="s">{<Page />}</StewardLayout>],
    ["Admin", <AdminLayout key="a">{<Page />}</AdminLayout>],
  ])(
    "the %s shell is served with the notice and a skip link",
    (_shell, shell) => {
      const html = renderToString(<RootLayout>{shell}</RootLayout>);
      expect(html).toContain(NOTICE);
      expect(html).toContain('href="#main"');
      expect(html).toContain('id="main"');
    },
  );

  it("pages outside the shells get it too", async () => {
    const page = await LoginPage({ searchParams: Promise.resolve({}) });
    const html = renderToString(<RootLayout>{page}</RootLayout>);
    expect(html).toContain(NOTICE);
    expect(html).toContain('id="main"');
  });

  it.each([
    ["anonymous", WORLD, false],
    ["in the scripted demo", WORLD, true],
    ["signed in", SIGNED_IN_WORLD, false],
  ] as const)("shows the notice %s", async (_who, world, demo) => {
    if (demo) window.sessionStorage.setItem("nx-prototype-demo", "1");
    setup(<DemoBar />, world);
    await waitFor(() =>
      expect(screen.getByRole("region")).toHaveTextContent(NOTICE),
    );
  });
});
