import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import JudgePage from "@/app/judge/page";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import type { WorldOut } from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
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

const WETLAND = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";

function sandbox(persona: "rosa" | "arjun" | "admin"): WorldOut {
  return {
    ...WORLD,
    label: "visitor",
    assets: [
      {
        id: WETLAND,
        site_key: story.site.key,
        name: story.site.name,
        status: "listed",
      },
    ],
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

function setup(routes: Routes) {
  const backend = fakeBackend({
    "GET /world": () => json(WORLD),
    "GET /story": () => json(story),
    "GET /media/demo-sites/wetland_mx/recorded-run.json": () =>
      json({ detail: "not_found" }, { status: 404 }),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
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
  return backend;
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
  const starts = backend.requests.filter((r) => r.url.endsWith("/demo/start"));
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
  it("opens a sandbox as Rosa and follows her live rating", async () => {
    const backend = setup({
      "POST /demo/start": () => json(sandbox("rosa")),
      [`POST /assets/${WETLAND}/rate`]: () =>
        json(
          { run_id: RUN, asset_id: WETLAND, status: "queued" },
          { status: 202 },
        ),
    });
    await skipToYourTurn();

    fireEvent.click(
      screen.getByRole("button", { name: /Rate the wetland, live/ }),
    );

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/trace/${RUN}`));
    expect(await personasStarted(backend)).toEqual(["rosa"]);
  });

  it("sends a running rating's visitor to the site instead", async () => {
    setup({
      "POST /demo/start": () => json(sandbox("rosa")),
      [`POST /assets/${WETLAND}/rate`]: () =>
        json({ detail: "run_in_progress" }, { status: 409 }),
    });
    await skipToYourTurn();

    fireEvent.click(
      screen.getByRole("button", { name: /Rate the wetland, live/ }),
    );

    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith(`/asset/${WETLAND}`),
    );
  });

  it.each([
    [/Back a community/, "arjun", "/"],
    [/Move time forward/, "admin", "/admin"],
    [/Run a community/, "rosa", "/steward"],
  ] as const)("%s starts as %s and opens %s", async (name, persona, home) => {
    const backend = setup({
      "POST /demo/start": () => json(sandbox(persona)),
    });
    await skipToYourTurn();

    fireEvent.click(screen.getByRole("button", { name }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(home));
    expect(await personasStarted(backend)).toEqual([persona]);
  });

  it("says plainly when every new sandbox is taken", async () => {
    setup({
      "POST /demo/start": () =>
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
