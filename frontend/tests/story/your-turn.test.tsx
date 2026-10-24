import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import JudgePage from "@/app/judge/page";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import type { WorldOut } from "@/lib/api/types";
import { createDataLayer, type DataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  json,
  WORLD,
} from "../lib/helpers";
import story from "./story.json";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: nav.push,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/judge",
  useSearchParams: () => new URLSearchParams(),
}));

// The story starts the sandbox through the sandbox's own layer (`/api/sandbox`).
const sandboxLayer = vi.hoisted(() => ({ current: null as DataLayer | null }));
vi.mock("@/lib/data-layer", async (original) => ({
  ...(await original<typeof import("@/lib/data-layer")>()),
  getSandboxDataLayer: () => sandboxLayer.current!,
}));

function sandbox(persona: "rosa" | "arjun" | "admin"): WorldOut {
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

type Routes = Parameters<typeof fakeBackend>[0];

function setup(sandboxRoutes: Routes) {
  const live = fakeBackend({
    "GET /world": () => json(WORLD),
    "GET /story": () => json(story),
    "GET /media/demo-sites/wetland_mx/recorded-run.json": () =>
      json({ detail: "not_found" }, { status: 404 }),
  });
  // Anonymous in the sandbox channel until a demo starts: the session's first read.
  const box = fakeBackend({
    "GET /sandbox/world": () => json(WORLD),
    ...sandboxRoutes,
  });
  sandboxLayer.current = createDataLayer({
    baseUrl: `${BASE}/sandbox`,
    fetch: box.fetch,
    createEventSource: createFakeEventSource,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: live.fetch,
    createEventSource: createFakeEventSource,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>{children}</TourProvider>
      </PrototypeProvider>
    </WorldProvider>
  );
  render(<JudgePage />, { wrapper });
  return { live, box };
}

async function skipToYourTurn() {
  await screen.findByRole("heading", {
    level: 1,
    name: /This wetland is alive/,
  });
  fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
  await screen.findByRole("heading", { name: /Your turn/ });
}

async function personasStarted(backend: ReturnType<typeof fakeBackend>) {
  const starts = backend.requests.filter((r) =>
    r.url.endsWith("/sandbox/demo/start"),
  );
  return Promise.all(
    starts.map(async (r) => ((await r.json()) as { persona: string }).persona),
  );
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => nav.push.mockReset());

describe("/judge: your turn", () => {
  it("opens the visitor's sandbox on the marketplace, as the supporter", async () => {
    const { live, box } = setup({
      "POST /sandbox/demo/start": () => json(sandbox("arjun")),
    });
    await skipToYourTurn();

    fireEvent.click(screen.getByRole("button", { name: /Open my sandbox/ }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/sandbox"));
    expect(await personasStarted(box)).toEqual(["arjun"]);
    // Never through the real app's API: a real account here stays signed in.
    expect(live.calls("POST /demo/start")).toBe(0);
    expect(sandboxLayer.current!.session.getSnapshot().world?.me?.persona).toBe(
      "arjun",
    );
  });

  it("shows the loop as steps, each saying who does it", async () => {
    setup({});
    await skipToYourTurn();

    const steps = screen.getByRole("list", {
      name: "What you can do in your sandbox",
    });
    expect(steps).toHaveTextContent("List your land");
    expect(steps).toHaveTextContent("as Rosa (Community steward)");
    expect(steps).toHaveTextContent("as Arjun (Supporter)");
    expect(steps).toHaveTextContent("as Admin (WildWorth team)");
  });

  it.each([
    [/List your land/, "rosa", "/sandbox/steward/list"],
    [/Check it's theirs/, "admin", "/sandbox/admin/verifications"],
    [/Back a community/, "arjun", "/sandbox"],
    [/Move time forward/, "admin", "/sandbox/admin"],
  ] as const)("%s starts as %s at %s", async (name, persona, path) => {
    const { box } = setup({
      "POST /sandbox/demo/start": () => json(sandbox(persona)),
    });
    await skipToYourTurn();

    fireEvent.click(screen.getByRole("button", { name }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(path));
    expect(await personasStarted(box)).toEqual([persona]);
  });

  it("says plainly when every new sandbox is taken", async () => {
    setup({
      "POST /sandbox/demo/start": () =>
        json(
          { detail: "demo_busy" },
          { status: 429, headers: { "Retry-After": "600" } },
        ),
    });
    await skipToYourTurn();

    fireEvent.click(screen.getByRole("button", { name: /Back a community/ }));

    expect(
      await screen.findByText(/Every new sandbox for this hour is taken/),
    ).toBeVisible();
    expect(nav.push).not.toHaveBeenCalled();
  });
});
