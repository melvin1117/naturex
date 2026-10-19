import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import AssetPage from "@/app/(exchange)/asset/[id]/page";
import MarketplacePage from "@/app/(exchange)/page";
import PortfolioPage from "@/app/(exchange)/portfolio/page";
import AdminPage from "@/app/admin/page";
import DevTradePage from "@/app/dev/trade/page";
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

import { BASE, fakeBackend, json, WORLD } from "./lib/helpers";

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
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: fakeBackend({ "GET /world": () => json(WORLD) }).fetch,
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
    ["/steward/list", ListPage, "List your land"],
    ["/admin", AdminPage, "Time Machine"],
    ["/judge", JudgePage, "The bees never sent an invoice."],
    ["/dev/ui", DevUiPage, "UI kit"],
    ["/dev/trade", DevTradePage, "Trade panel"],
    ["404", NotFound, "Page not found"],
  ])("%s renders its heading", (_path, Page, heading) => {
    render(<Page />, { wrapper: Providers });
    expect(
      screen.getByRole("heading", { level: 1, name: heading }),
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

  it("/asset/[id] shows the site from the sandbox", async () => {
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

  it("/asset/[id] explains an unknown site", async () => {
    render(await AssetPage({ params: Promise.resolve({ id: "nope" }) }), {
      wrapper: Providers,
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Site not found" }),
    ).toBeInTheDocument();
  });
});
