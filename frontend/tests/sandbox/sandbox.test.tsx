import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Link from "@/components/app-link";
import { LeftoverDemo } from "@/components/shell/leftover-demo";
import { SandboxHeader } from "@/components/shell/sandbox-header";
import { TimeMachineSheet } from "@/components/shell/time-machine-sheet";
import { Toaster } from "@/components/ui/sonner";
import { SandboxGate } from "@/components/sandbox/sandbox-gate";
import { WorldProvider } from "@/components/world-provider";
import type { WorldOut } from "@/lib/api/types";
import {
  createDataLayer,
  useDataLayer,
  type DataLayer,
} from "@/lib/data-layer";
import { useApiBase, useWorld } from "@/lib/hooks";
import { assetOverlayUrl } from "@/lib/land-cover-overlay";
import { beforeAfterViews } from "@/lib/site-views";
import { documentDownloadUrl } from "@/lib/verification";
import { useRouter } from "@/lib/nav";
import { appPath, isSandboxPath, sandboxHref } from "@/lib/sandbox";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  sequence,
  SIGNED_IN_WORLD,
  WORLD,
} from "../lib/helpers";

const nav = vi.hoisted(() => ({ push: vi.fn(), pathname: "/sandbox" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: nav.push,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

const sandboxLayer = vi.hoisted(() => ({ current: null as DataLayer | null }));
vi.mock("@/lib/data-layer", async (original) => ({
  ...(await original<typeof import("@/lib/data-layer")>()),
  getSandboxDataLayer: () => sandboxLayer.current!,
}));

function demoWorld(persona: "rosa" | "arjun" | "admin" | null): WorldOut {
  if (persona === null) return WORLD;
  return {
    ...WORLD,
    label: "visitor",
    me: {
      id: "55555555-5555-4555-8555-555555555555",
      name: persona,
      email: null,
      kind: "persona",
      is_admin: persona === "admin",
      world_id: WORLD.id,
      persona,
    },
  };
}

function setup(
  ui: ReactNode,
  routes: Parameters<typeof fakeBackend>[0],
  baseUrl = BASE,
) {
  const backend = fakeBackend(routes);
  const layer = createDataLayer({
    baseUrl,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  sandboxLayer.current = layer;
  render(<WorldProvider dataLayer={layer}>{ui}</WorldProvider>);
  return { backend, layer };
}

beforeEach(() => {
  nav.push.mockReset();
  nav.pathname = "/sandbox";
  window.sessionStorage.clear();
});

describe("the sandbox's URL space", () => {
  it.each([
    ["/", "/sandbox"],
    ["/?tab=all", "/sandbox?tab=all"],
    ["/asset/1?tab=trace#x", "/sandbox/asset/1?tab=trace#x"],
    ["/steward/list", "/sandbox/steward/list"],
    ["/admin", "/sandbox/admin"],
    ["/trace/recorded/9", "/sandbox/trace/recorded/9"],
    ["/judge", "/judge"],
    ["/login?next=/admin", "/login?next=/admin"],
    ["/sandbox/asset/1", "/sandbox/asset/1"],
    ["#ledger", "#ledger"],
    ["https://example.org/", "https://example.org/"],
  ])("%s → %s", (href, inSandbox) => {
    expect(sandboxHref(href)).toBe(inSandbox);
  });

  it("knows its paths and strips them back to the app's", () => {
    expect(isSandboxPath("/sandbox")).toBe(true);
    expect(isSandboxPath("/sandbox/asset/1")).toBe(true);
    expect(isSandboxPath("/sandboxes")).toBe(false);
    expect(isSandboxPath(null)).toBe(false);
    expect(appPath("/sandbox")).toBe("/");
    expect(appPath("/sandbox/asset/1")).toBe("/asset/1");
    expect(appPath("/asset/1")).toBe("/asset/1");
  });

  it("links and navigates within the sandbox from inside it", () => {
    nav.pathname = "/sandbox/asset/1";
    function Go() {
      const router = useRouter();
      return (
        <>
          <Link href="/asset/2">Another site</Link>
          <Link href="/judge">The story</Link>
          <button onClick={() => router.push("/admin")}>Admin</button>
        </>
      );
    }
    render(<Go />);
    expect(screen.getByRole("link", { name: "Another site" })).toHaveAttribute(
      "href",
      "/sandbox/asset/2",
    );
    expect(screen.getByRole("link", { name: "The story" })).toHaveAttribute(
      "href",
      "/judge",
    );
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(nav.push).toHaveBeenCalledWith("/sandbox/admin", undefined);
  });

  it("leaves links alone in the real app", () => {
    nav.pathname = "/asset/1";
    render(<Link href="/asset/2">Another site</Link>);
    expect(screen.getByRole("link", { name: "Another site" })).toHaveAttribute(
      "href",
      "/asset/2",
    );
  });

  it("keeps every app screen in the sandbox: outside it, only the welcome and the story", () => {
    const app = join(__dirname, "../../src/app");
    const routes = readdirSync(app).filter((name) =>
      statSync(join(app, name)).isDirectory(),
    );
    expect(routes.sort()).toEqual(["dev", "how", "sandbox"]);
  });
});

describe("files the browser fetches itself", () => {
  it("come from the same channel as the page's data", async () => {
    function Urls() {
      const base = useApiBase();
      const views = beforeAfterViews(
        {
          id: "a1",
          site_key: null,
          site_views: {
            version: "v1",
            before: { start: "2021-01-01", end: "2021-12-31" },
            after: { start: "2025-10-01", end: "2026-09-30" },
          } as never,
        },
        base,
      );
      return (
        <>
          <img alt="after" src={views?.after} />
          <img alt="overlay" src={assetOverlayUrl("a1", "v1", base)} />
          <a href={documentDownloadUrl("a1", "d1", base)}>Download</a>
        </>
      );
    }
    setup(
      <Urls />,
      { "GET /sandbox/world": () => json(demoWorld("rosa")) },
      `${BASE}/sandbox`,
    );

    expect(screen.getByRole("img", { name: "after" })).toHaveAttribute(
      "src",
      "/api/sandbox/assets/a1/views/after.webp?v=v1",
    );
    expect(screen.getByRole("img", { name: "overlay" })).toHaveAttribute(
      "src",
      "/api/sandbox/assets/a1/overlay.png?v=v1",
    );
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/sandbox/assets/a1/documents/d1",
    );
  });
});

const NO_ALERTS = () =>
  json({ alerts: [], unread_count: 0, next_before: null });

describe("the sandbox header", () => {
  it.each([
    ["arjun", ["Marketplace", "Communities", "Your stakes"]],
    ["rosa", ["Marketplace", "Communities", "Your stakes"]],
    ["admin", ["Marketplace", "Reviews"]],
  ] as const)("gives %s the same few pages", async (persona, pages) => {
    setup(<SandboxHeader />, {
      "GET /world": () => json(demoWorld(persona)),
      "GET /alerts": NO_ALERTS,
    });
    const nav = await screen.findByRole("navigation", { name: "Pages" });
    await waitFor(() =>
      expect(
        Array.from(nav.querySelectorAll("a")).map((a) => a.textContent),
      ).toEqual(pages),
    );
    expect(
      screen.getByRole("link", { name: "Marketplace", current: "page" }),
    ).toHaveAttribute("href", "/sandbox");
    expect(screen.getByRole("button", { name: "Time Machine" })).toBeVisible();
  });

  it("shows the same WildWorth lockup as the welcome: the full mark, not the small W", async () => {
    setup(<SandboxHeader />, {
      "GET /world": () => json(demoWorld("arjun")),
      "GET /alerts": NO_ALERTS,
    });
    const home = await screen.findByRole("link", {
      name: "WildWorth, Marketplace",
    });
    const mark = home.querySelector("svg[data-variant]");
    expect(mark).toHaveAttribute("data-variant", "double");
    // The welcome and the story draw it at the same size (only the reading's colour follows
    // the ground: lime on dark, lime-ink on light).
    expect(mark).toHaveAttribute("width", "25");
  });

  it("names the person button with what it shows, without the avatar's letter", async () => {
    setup(<SandboxHeader />, {
      "GET /world": () => json(demoWorld("arjun")),
      "GET /alerts": NO_ALERTS,
    });
    const trigger = await screen.findByRole("button", {
      name: /^Viewing as Arjun, Supporter/,
    });
    // axe's label-in-name: the visible "Viewing as Arjun Supporter" starts the name, words
    // apart, and avatars draw their initials with CSS, so no stray letter joins the text.
    expect(trigger).toHaveTextContent(/^Viewing as Arjun Supporter$/);
    // It shows everyone you can be, the current person in front.
    expect(
      Array.from(trigger.querySelectorAll("[data-persona]")).map((el) =>
        el.getAttribute("data-persona"),
      ),
    ).toEqual(["rosa", "admin", "arjun"]);
    const avatar = trigger.querySelector("[data-current]");
    expect(avatar).toHaveAttribute("data-initial", "A");
    expect(avatar).toHaveTextContent("");
  });

  it("switches person from the menu and goes to their home", async () => {
    const { backend } = setup(<SandboxHeader />, {
      "GET /world": () => json(demoWorld("arjun")),
      "GET /alerts": NO_ALERTS,
      "POST /demo/persona": () => json(demoWorld("admin")),
    });
    const trigger = await screen.findByRole("button", {
      name: /^Viewing as Arjun, Supporter/,
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Reviewer/ }));

    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith(
        "/sandbox/admin/verifications",
        undefined,
      ),
    );
    expect(backend.calls("POST /demo/persona")).toBe(1);
  });

  it("starts the sandbox over or leaves it from the same menu", async () => {
    setup(<SandboxHeader />, {
      "GET /world": () => json(demoWorld("rosa")),
      "GET /alerts": NO_ALERTS,
    });
    fireEvent.pointerDown(
      await screen.findByRole("button", {
        name: /^Viewing as Rosa, Community/,
      }),
      { button: 0, ctrlKey: false },
    );
    expect(
      await screen.findByRole("menuitem", { name: /Leave the sandbox/ }),
    ).toHaveAttribute("href", "/");
    expect(
      screen.getByRole("menuitem", { name: /Start the sandbox over/ }),
    ).toBeVisible();
  });
});

describe("the persona menu, when something fails", () => {
  async function openMenu(name: RegExp) {
    fireEvent.pointerDown(await screen.findByRole("button", { name }), {
      button: 0,
      ctrlKey: false,
    });
  }

  it("says so when a switch fails, and stays where it was", async () => {
    setup(
      <>
        <SandboxHeader />
        <Toaster />
      </>,
      {
        "GET /world": () => json(demoWorld("arjun")),
        "GET /alerts": NO_ALERTS,
        "POST /demo/persona": () =>
          json({ detail: "demo_busy" }, { status: 503 }),
      },
    );
    await openMenu(/^Viewing as Arjun/);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Rosa/ }));

    expect(
      await screen.findByText("Couldn't switch to Rosa just now"),
    ).toBeVisible();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("goes home only once the sandbox has started over", async () => {
    let finish!: (response: Response) => void;
    setup(
      <>
        <SandboxHeader />
        <Toaster />
      </>,
      {
        "GET /world": () => json(demoWorld("rosa")),
        "GET /alerts": NO_ALERTS,
        "POST /world/reset": sequence(
          () => new Promise<Response>((resolve) => (finish = resolve)),
          () => json({ detail: "demo_busy" }, { status: 503 }),
        ),
      },
    );
    await openMenu(/^Viewing as Rosa/);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Start the sandbox over/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Start over" }));

    await waitFor(() => expect(finish).toBeDefined());
    expect(nav.push).not.toHaveBeenCalled();
    finish(json(demoWorld("rosa")));
    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith("/sandbox/steward", undefined),
    );

    // A failed reset says so and goes nowhere.
    nav.push.mockReset();
    await openMenu(/^Viewing as Rosa/);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Start the sandbox over/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Start over" }));
    expect(
      await screen.findByText("Couldn't start the sandbox over just now"),
    ).toBeVisible();
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("the Time Machine in the header", () => {
  it("is anyone's in a sandbox, and asks nothing for a live-world account", async () => {
    const { backend } = setup(<TimeMachineSheet />, {
      "GET /world": () => json(demoWorld("arjun")),
      "GET /admin/time-machine": () =>
        json({ detail: "boom" }, { status: 503 }),
    });
    await waitFor(() =>
      expect(backend.calls("GET /admin/time-machine")).toBe(1),
    );
    cleanup();

    const live = setup(<TimeMachineSheet />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
    });
    await screen.findByRole("button", { name: "Time Machine" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(live.backend.calls("GET /admin/time-machine")).toBe(0);
  });
});

describe("the sandbox gate", () => {
  it("opens a sandbox straight away, with no sign-up", async () => {
    const { backend } = setup(
      <SandboxGate>
        <p>Inside</p>
      </SandboxGate>,
      {
        "GET /world": () => json(demoWorld(null)),
        "POST /demo/start": () => json(demoWorld("arjun")),
        "GET /alerts": NO_ALERTS,
      },
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Opening your sandbox…",
    );
    expect(await screen.findByText("Inside")).toBeVisible();
    expect(backend.calls("POST /demo/start")).toBe(1);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("says why a sandbox didn't open, and tries again", async () => {
    let attempts = 0;
    setup(
      <SandboxGate>
        <p>Inside</p>
      </SandboxGate>,
      {
        "GET /world": () => json(demoWorld(null)),
        "POST /demo/start": () =>
          ++attempts === 1
            ? json({ detail: "too_many_attempts" }, { status: 429 })
            : json(demoWorld("arjun")),
        "GET /alerts": NO_ALERTS,
      },
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many sandboxes from this network this hour.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Inside")).toBeVisible();
  });

  it("lets a visitor with a sandbox straight in", async () => {
    setup(
      <SandboxGate>
        <p>Inside</p>
      </SandboxGate>,
      { "GET /world": () => json(demoWorld("rosa")), "GET /alerts": NO_ALERTS },
    );
    expect(await screen.findByText("Inside")).toBeVisible();
  });

  it("opens a new sandbox when this one ends mid-session", async () => {
    function Page() {
      const { api } = useDataLayer();
      const me = useWorld().world?.me;
      return (
        <>
          <p>You are {me?.name}</p>
          <button type="button" onClick={() => void api.GET("/portfolio")}>
            Look at my stakes
          </button>
        </>
      );
    }
    const { backend } = setup(
      <SandboxGate>
        <Page />
      </SandboxGate>,
      {
        // The sandbox expired: the next request's 401 re-reads a world with nobody in it.
        "GET /world": sequence(
          () => json(demoWorld("rosa")),
          () => json(demoWorld(null)),
        ),
        "GET /portfolio": () =>
          json({ detail: "auth_required" }, { status: 401 }),
        "POST /demo/start": () => json(demoWorld("arjun")),
        "GET /alerts": NO_ALERTS,
      },
    );
    expect(await screen.findByText("You are rosa")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Look at my stakes" }));

    expect(await screen.findByText("You are arjun")).toBeVisible();
    expect(backend.calls("POST /demo/start")).toBe(1);
  });

  it("gives every sandbox page its alert notifications", async () => {
    FakeEventSource.reset();
    setup(
      <>
        <SandboxGate>
          <p>Inside</p>
        </SandboxGate>
        <Toaster />
      </>,
      { "GET /world": () => json(demoWorld("rosa")), "GET /alerts": NO_ALERTS },
    );
    expect(await screen.findByText("Inside")).toBeVisible();
    await waitFor(() => expect(FakeEventSource.instances).not.toHaveLength(0));

    act(() => {
      for (const source of FakeEventSource.instances) {
        source.open();
        source.emit(
          "alert",
          1,
          {
            alert_id: "a1",
            asset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            asset_name: "Xochimilco Wetland",
            kind: "news",
            title: "Fire near the wetland",
            message: "Smoke reported upstream.",
            severity: 4,
            report_id: null,
            url: null,
          },
          new Date().toISOString(),
        );
      }
    });

    expect(await screen.findByText("Fire near the wetland")).toBeVisible();
  });
});

describe("a browser coming back from before the redesign", () => {
  it("drops what the old scripted prototype kept", async () => {
    nav.pathname = "/";
    window.localStorage.setItem("ww-prototype-world", "{}");
    window.localStorage.setItem("ww-prototype-tour", "{}");
    window.sessionStorage.setItem("ww-prototype-demo", "1");
    window.localStorage.setItem("ww-steward-community:x", "kept");

    setup(<LeftoverDemo />, { "GET /world": () => json(WORLD) });

    await waitFor(() =>
      expect(window.localStorage.getItem("ww-prototype-world")).toBeNull(),
    );
    expect(window.localStorage.getItem("ww-prototype-tour")).toBeNull();
    expect(window.sessionStorage.getItem("ww-prototype-demo")).toBeNull();
    expect(window.localStorage.getItem("ww-steward-community:x")).toBe("kept");
  });
});
