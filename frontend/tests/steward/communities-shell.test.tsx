import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import StewardLayout from "@/app/sandbox/steward/layout";
import { TourProvider } from "@/components/proto/tour";
import {
  StewardCommunityProvider,
  useStewardCommunity,
} from "@/components/shell/steward-community";
import { WorldProvider } from "@/components/world-provider";
import type { MyCommunity, WorldOut } from "@/lib/api/types";
import { createDataLayer, queryKeys } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  BASE,
  community,
  fakeBackend,
  json,
  sequence,
  SIGNED_IN_WORLD,
} from "../lib/helpers";

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
  // jsdom lacks these; Radix menus ask for them.
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
  nav.pathname = "/steward";
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
const ROSA_ID = SIGNED_IN_WORLD.me!.id;
const REMEMBERED = `ww-steward-community:${ROSA_ID}`;

type Routes = Parameters<typeof fakeBackend>[0];

/** A Communities page: which community the provider picked for it. */
function Page() {
  const { active } = useStewardCommunity();
  return <p>Page content{active ? `: ${active.name}` : ""}</p>;
}

function setup(communities: MyCommunity[] = [], routes: Routes = {}) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    "GET /me/communities": () => json(communities),
    ...routes,
  });
  const layer = createDataLayer({ baseUrl: BASE, fetch: backend.fetch });
  render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>
          <StewardLayout>
            <Page />
          </StewardLayout>
        </TourProvider>
      </PrototypeProvider>
    </WorldProvider>,
  );
  return { backend, layer };
}

const showing = (name: string) => screen.findByText(`Page content: ${name}`);

describe("Communities: which community", () => {
  it("shows the community's pages, with no switcher over them", async () => {
    setup([SELVA, RIO]);
    expect(await showing("Selva Viva")).toBeVisible();
    // Communities lists them all; a community's page links back to it.
    expect(
      screen.queryByRole("button", { name: /switch community/i }),
    ).not.toBeInTheDocument();
  });

  it("opens on the remembered community, if still a member", async () => {
    window.localStorage.setItem(REMEMBERED, RIO.id);
    setup([SELVA, RIO]);
    expect(await showing("Río Claro")).toBeVisible();
  });

  it("lets the URL win over the remembered community", async () => {
    window.localStorage.setItem(REMEMBERED, SELVA.id);
    nav.search = `community=${RIO.id}`;
    setup([SELVA, RIO]);
    expect(await showing("Río Claro")).toBeVisible();
  });

  it.each([
    ["a tampered remembered ID", "", "not-a-member"],
    ["a community in the URL the account isn't in", "community=other", ""],
  ])("falls back to the first community for %s", async (_case, search, id) => {
    if (id) window.localStorage.setItem(REMEMBERED, id);
    nav.search = search;
    setup([SELVA, RIO]);
    expect(await showing("Selva Viva")).toBeVisible();
  });

  it("shows the remembered community from the first render", async () => {
    window.localStorage.setItem(REMEMBERED, RIO.id);
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
});

describe("Communities: none yet, or a failed read", () => {
  it("shows someone without a community how to start one", async () => {
    setup();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Start a community",
      }),
    ).toBeVisible();
    // Shrinkable columns: a long name can't widen the page at 390 px.
    expect(
      screen
        .getByRole("region", { name: "Start a community" })
        .querySelector(":scope > .grid"),
    ).toHaveClass(
      "grid-cols-[minmax(0,1fr)]",
      "lg:grid-cols-[minmax(0,1fr)_440px]",
    );
    expect(screen.queryByText(/Page content/)).not.toBeInTheDocument();
    // No account IDs to pass around in a sandbox, and no repeated sandbox line.
    expect(screen.queryByText(/account ID/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/play money/i)).not.toBeInTheDocument();
  });

  it("explains a failed communities request and retries", async () => {
    let fail = true;
    setup([], {
      "GET /me/communities": () =>
        fail ? json({ detail: "boom" }, { status: 503 }) : json([SELVA]),
    });
    expect(
      await screen.findByText("We couldn't load your communities"),
    ).toBeVisible();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await showing("Selva Viva")).toBeVisible();
  });
});

describe("Communities: switching who you are", () => {
  it("never shows one person's communities to the next", async () => {
    const ARJUN: WorldOut = {
      ...SIGNED_IN_WORLD,
      me: {
        ...SIGNED_IN_WORLD.me!,
        id: "88888888-8888-4888-8888-888888888888",
        name: "Arjun",
      },
    };
    let answerArjun!: (response: Response) => void;
    const { backend, layer } = setup([], {
      "GET /world": sequence(
        () => json(SIGNED_IN_WORLD),
        () => json(ARJUN),
      ),
      "GET /me/communities": sequence(
        () => json([SELVA, RIO]),
        () => new Promise<Response>((resolve) => (answerArjun = resolve)),
      ),
    });
    expect(await showing("Selva Viva")).toBeVisible();

    await act(() => layer.session.reload());
    // Arjun's answer hasn't come back: nothing of Rosa's, nothing guessed.
    await waitFor(() => expect(backend.calls("GET /me/communities")).toBe(2));
    expect(screen.queryByText(/Selva Viva/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Page content/)).not.toBeInTheDocument();

    await act(async () => answerArjun(json([])));
    expect(
      await screen.findByRole("heading", { name: "Start a community" }),
    ).toBeVisible();
    expect(screen.queryByText("Selva Viva")).not.toBeInTheDocument();
  });
});
