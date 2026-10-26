import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import AssetPage from "@/app/sandbox/(exchange)/asset/[id]/page";
import MarketplacePage from "@/app/sandbox/(exchange)/(market)/page";
import PortfolioPage from "@/app/sandbox/(exchange)/portfolio/page";
import AdminPage from "@/app/sandbox/admin/page";
import DevUiPage from "@/app/dev/ui/page";
import JudgePage from "@/app/how/page";
import HomePage from "@/app/page";
import NotFound from "@/app/not-found";
import ListPage from "@/app/sandbox/steward/list/page";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";
import story from "./story/story.json";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  json,
  WORLD,
} from "./lib/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
// Live data is covered in tests/lib; these sections need the backend.
vi.mock("@/components/data-layer-panel", () => ({
  DataLayerPanel: () => null,
}));
vi.mock("@/components/demo-site-images", () => ({
  DemoSiteImages: () => null,
}));

beforeAll(() => {
  // jsdom lacks these; Recharts and the rating pipeline ask for them.
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

function Providers({ children }: { children: ReactNode }) {
  // Like app/layout.tsx: wired screens read an (empty) world from a fake backend.
  const backend = fakeBackend({
    "GET /world": () => json(WORLD),
    "GET /assets": () => json([]),
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  return <WorldProvider dataLayer={layer}>{children}</WorldProvider>;
}

function StoryProviders({ children }: { children: ReactNode }) {
  const backend = fakeBackend({
    "GET /world": () => json(WORLD),
    "GET /story": () => json(story),
    "GET /media/demo-sites/wetland_mx/recorded-run.json": () =>
      json({ detail: "not_found" }, { status: 404 }),
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  return <WorldProvider dataLayer={layer}>{children}</WorldProvider>;
}

describe("routes", () => {
  it.each([
    ["/", HomePage, "Welcome to WildWorth."],
    ["/sandbox", MarketplacePage, "Marketplace"],
    ["/sandbox/portfolio", PortfolioPage, "Your stakes"],
    ["/sandbox/admin", AdminPage, "Time Machine"],
    ["/dev/ui", DevUiPage, "UI kit"],
    ["404", NotFound, "Page not found"],
  ])("%s renders its heading", (_path, Page, heading) => {
    render(<Page />, { wrapper: Providers });
    expect(
      screen.getByRole("heading", { level: 1, name: heading }),
    ).toBeInTheDocument();
  });

  it("/how tells the story from GET /story", async () => {
    render(<JudgePage />, { wrapper: StoryProviders });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading the satellite view…",
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: /What is it worth alive\?/,
      }),
    ).toBeInTheDocument();
  });

  it("/steward/list waits for the sandbox's session, never a scripted flow", async () => {
    render(<ListPage />, { wrapper: Providers });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading the listing form…",
    );
    // The world answered without a person: still waiting for the sandbox gate.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Loading the listing form…",
      ),
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("/asset/[id] explains an id that isn't a site", async () => {
    render(await AssetPage({ params: Promise.resolve({ id: "nope" }) }), {
      wrapper: Providers,
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Site not found" }),
    ).toBeInTheDocument();
  });

  it("/asset/[id] with a real asset ID reads the API", async () => {
    render(
      await AssetPage({
        params: Promise.resolve({ id: "44444444-4444-4444-8444-444444444444" }),
      }),
      { wrapper: Providers },
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Site not found" }),
    ).toBeInTheDocument();
  });
});
