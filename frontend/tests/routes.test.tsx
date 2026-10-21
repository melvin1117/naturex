import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import AssetPage from "@/app/(exchange)/asset/[id]/page";
import MarketplacePage from "@/app/(exchange)/(market)/page";
import PortfolioPage from "@/app/(exchange)/portfolio/page";
import AdminPage from "@/app/admin/page";
import DevUiPage from "@/app/dev/ui/page";
import JudgePage from "@/app/judge/page";
import LoginPage from "@/app/login/page";
import NotFound from "@/app/not-found";
import RegisterPage from "@/app/register/page";
import ListPage from "@/app/steward/list/page";
import StewardPage from "@/app/steward/page";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

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
  return (
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>{children}</TourProvider>
      </PrototypeProvider>
    </WorldProvider>
  );
}

const noSearch = { searchParams: Promise.resolve({}) };

describe("routes", () => {
  it.each([
    ["/", MarketplacePage, "Marketplace"],
    ["/portfolio", PortfolioPage, "Your stakes"],
    ["/steward", StewardPage, "Get paid for keeping your land alive"],
    ["/admin", AdminPage, "Time Machine"],
    ["/judge", JudgePage, "The bees never sent an invoice."],
    ["/dev/ui", DevUiPage, "UI kit"],
    ["404", NotFound, "Page not found"],
  ])("%s renders its heading", (_path, Page, heading) => {
    render(<Page />, { wrapper: Providers });
    expect(
      screen.getByRole("heading", { level: 1, name: heading }),
    ).toBeInTheDocument();
  });

  it("/steward/list shows a loader, then the prototype flow to an anonymous demo visitor", async () => {
    render(<ListPage />, { wrapper: Providers });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading the listing form…",
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "List your land" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["/login", LoginPage, "Sign in"],
    ["/register", RegisterPage, "Create your account"],
  ])("%s renders its heading", async (_path, Page, heading) => {
    render(await Page(noSearch), { wrapper: Providers });
    expect(
      screen.getByRole("heading", { level: 1, name: heading }),
    ).toBeInTheDocument();
  });

  it("/asset/[id] shows a prototype site from the scripted sandbox", async () => {
    render(
      await AssetPage({ params: Promise.resolve({ id: "sumidero-forest" }) }),
      {
        wrapper: Providers,
      },
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Sumidero Canyon Restoration Forest",
      }),
    ).toBeInTheDocument();
  });

  it("/asset/[id] explains an unknown prototype site", async () => {
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
