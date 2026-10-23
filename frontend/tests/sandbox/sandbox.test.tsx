import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Link from "@/components/app-link";
import { DemoBar } from "@/components/proto/demo-bar";
import { TourProvider } from "@/components/proto/tour";
import { SandboxGate } from "@/components/sandbox/sandbox-gate";
import { WorldProvider } from "@/components/world-provider";
import type { WorldOut } from "@/lib/api/types";
import { createDataLayer, type DataLayer } from "@/lib/data-layer";
import { useRouter } from "@/lib/nav";
import { PrototypeProvider } from "@/lib/prototype/store";
import { appPath, isSandboxPath, sandboxHref } from "@/lib/sandbox";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  json,
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

function setup(ui: ReactNode, routes: Parameters<typeof fakeBackend>[0]) {
  const backend = fakeBackend(routes);
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  sandboxLayer.current = layer;
  render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>{ui}</TourProvider>
      </PrototypeProvider>
    </WorldProvider>,
  );
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

  it("has a twin of every app screen", () => {
    const app = join(__dirname, "../../src/app");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });
    const screens = ["(exchange)", "admin", "steward"].flatMap((root) =>
      files(join(app, root)).map((f) => relative(app, f)),
    );
    const twins = new Set(
      files(join(app, "sandbox")).map((f) => relative(join(app, "sandbox"), f)),
    );
    expect(screens.filter((f) => !twins.has(f))).toEqual([]);
  });
});

describe("the sandbox bar", () => {
  it("says who's who, switches persona and stays in the sandbox", async () => {
    const { backend } = setup(<DemoBar />, {
      "GET /world": () => json(demoWorld("arjun")),
      "POST /demo/persona": () => json(demoWorld("admin")),
    });

    const arjun = await screen.findByRole("radio", {
      name: "Arjun (Supporter)",
    });
    expect(arjun).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: "Rosa (Community steward)" }),
    ).toHaveTextContent("Rosa(Community steward)");

    fireEvent.click(
      screen.getByRole("radio", { name: "Admin (NatureX team)" }),
    );

    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith("/sandbox/admin", undefined),
    );
    expect(backend.calls("POST /demo/persona")).toBe(1);
  });

  it("leads back to NatureX, the story, a guide and a reset", async () => {
    setup(<DemoBar />, { "GET /world": () => json(demoWorld("rosa")) });

    const home = await screen.findByRole("link", { name: /NatureX/ });
    expect(home).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "The story" })).toHaveAttribute(
      "href",
      "/judge",
    );
    expect(screen.getByRole("button", { name: "Reset" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "What to try" }));
    expect(
      await screen.findByRole("list", {
        name: "What you can do in your sandbox",
      }),
    ).toHaveTextContent("Move time forward");
  });
});

describe("the sandbox gate", () => {
  it("offers to open a sandbox instead of the live world", async () => {
    setup(
      <SandboxGate>
        <p>Inside</p>
      </SandboxGate>,
      {
        "GET /world": () => json(demoWorld(null)),
        "POST /demo/start": () => json(demoWorld("arjun")),
      },
    );

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Your own NatureX, live, with no sign-up.",
      }),
    ).toBeVisible();
    expect(screen.queryByText("Inside")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Back to NatureX/ }),
    ).toHaveAttribute("href", "/");

    fireEvent.click(screen.getByRole("button", { name: /Open my sandbox/ }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/sandbox"));
    expect(await screen.findByText("Inside")).toBeVisible();
  });

  it("lets a visitor with a sandbox straight in", async () => {
    setup(
      <SandboxGate>
        <p>Inside</p>
      </SandboxGate>,
      { "GET /world": () => json(demoWorld("rosa")) },
    );
    expect(await screen.findByText("Inside")).toBeVisible();
  });
});
