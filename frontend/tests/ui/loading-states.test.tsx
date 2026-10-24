import { act, render, screen } from "@testing-library/react";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LoadingRegion,
  SLOW_AFTER_MS,
  SLOW_NOTE,
} from "@/components/loading-region";
import {
  IpoSkeleton,
  MachineRowsSkeleton,
  RouteSkeleton,
  ScreenSkeleton,
} from "@/components/page-skeletons";
import { TourProvider } from "@/components/proto/tour";
import { Skeleton } from "@/components/ui/skeleton";
import { HANDOFF_MS, resetLoadingChains } from "@/lib/loading-chain";
import { PrototypeProvider } from "@/lib/prototype/store";
import { skeletonKind } from "@/lib/route-skeleton";

declare global {
  interface ImportMeta {
    /** Vite's static glob import (vite/client isn't a direct dependency here). */
    glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  nav.pathname = "/";
  resetLoadingChains();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Like app/layout.tsx: the Marketplace heading offers the guided tour. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <PrototypeProvider>
      <TourProvider>{children}</TourProvider>
    </PrototypeProvider>
  );
}

/** The one region on screen. */
function region() {
  const regions = document.querySelectorAll("[data-slot=loading-region]");
  expect(regions).toHaveLength(1);
  return regions[0] as HTMLElement;
}

function Region({ label, name = "test" }: { label: string; name?: string }) {
  return (
    <LoadingRegion name={name} label={label}>
      <div data-testid="block" />
    </LoadingRegion>
  );
}

describe("LoadingRegion", () => {
  it("has one status, outside the blocks it hides from assistive tech", () => {
    render(<Region label="Loading the site…" />);
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent(/^Loading the site…$/);
    expect(statuses[0]).not.toHaveAttribute("aria-live");
    expect(screen.getByTestId("block").closest("[aria-hidden=true]")).not.toBe(
      null,
    );
    expect(statuses[0]!.closest("[aria-hidden=true]")).toBeNull();
    // Some screen readers hold announcements while a region is busy.
    expect(region()).not.toHaveAttribute("aria-busy");
  });

  it("mounts its status empty, then sets the text, so it's announced", () => {
    const html = renderToStaticMarkup(<Region label="Loading the site…" />);
    expect(html).toContain('<p role="status" class="sr-only"></p>');
    expect(html).not.toContain("Loading the site…");
  });

  it("says why after a long wait, in the same status", () => {
    vi.useFakeTimers();
    render(<Region label="Loading the site…" />);
    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS - 1));
    expect(screen.getByRole("status")).toHaveTextContent("Loading the site…");

    act(() => vi.advanceTimersByTime(1));
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent(SLOW_NOTE);
    expect(statuses[0]).toBeVisible();
    expect(statuses[0]).not.toHaveAttribute("aria-live");
    expect(SLOW_NOTE).not.toMatch(/free host/);
  });

  it("counts the wait from the first of consecutive regions", () => {
    vi.useFakeTimers();
    const view = render(<Region label="Checking your session…" />);
    act(() => vi.advanceTimersByTime(5000));
    // The next phase replaces the first one in the same commit.
    view.rerender(<Region key="page" label="Loading the site…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the site…");
    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS - 5000));
    expect(screen.getByRole("status")).toHaveTextContent(SLOW_NOTE);
  });

  it("starts a new wait after a quiet gap", () => {
    vi.useFakeTimers();
    const view = render(<Region label="Loading the site…" />);
    act(() => vi.advanceTimersByTime(5000));
    view.unmount();
    act(() => vi.advanceTimersByTime(HANDOFF_MS + 1));
    render(<Region label="Loading the site…" />);
    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS - 1));
    expect(screen.getByRole("status")).toHaveTextContent("Loading the site…");
    // A new wait announces its label again.
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-live");
  });

  it("doesn't announce a label the same wait already announced", () => {
    vi.useFakeTimers();
    const view = render(<Region label="Loading the site…" />);
    view.rerender(<Region key="b" label="Loading the site…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading the site…");
    expect(status).toHaveAttribute("aria-live", "off");

    view.rerender(<Region key="c" label="Opening your demo world…" />);
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-live");

    // The slow note is new: a muted status speaks up for it, once.
    view.rerender(<Region key="d" label="Loading the site…" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "off");
    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS));
    expect(screen.getByRole("status")).toHaveTextContent(SLOW_NOTE);
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-live");
    view.rerender(<Region key="e" label="Loading the site…" />);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole("status")).toHaveTextContent(SLOW_NOTE);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "off");
  });

  it("stops its timer when the content arrives", () => {
    vi.useFakeTimers();
    const view = render(<Region label="Loading…" />);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Skeleton", () => {
  it("pulses at 1.6 s and stops under reduced motion", () => {
    render(<Skeleton data-testid="bone" />);
    const bone = screen.getByTestId("bone");
    expect(bone).toHaveClass("animate-pulse", "motion-reduce:animate-none");
    expect(bone.style.animationDuration).toBe("1.6s");
  });
});

/** Every route `loading.tsx`, keyed by a sample URL for its folder. */
const LOADERS = Object.entries(
  import.meta.glob<{ default: ComponentType }>("/src/app/**/loading.tsx", {
    eager: true,
  }),
).map(([file, mod]) => {
  const route =
    file
      .replace(/^\/src\/app/, "")
      .replace(/\/loading\.tsx$/, "")
      .replace(/\/\([^)]+\)/g, "")
      .replace(/\[[^\]]+\]/g, "x") || "/";
  return { route, Loading: mod.default };
});

describe("route loading states", () => {
  it("covers the Marketplace, asset page, portfolio, steward and admin routes", () => {
    const app = [
      "/",
      "/admin",
      "/admin/verifications",
      "/admin/verifications/x",
      "/asset/x",
      "/portfolio",
      "/steward",
      "/steward/assets/x",
      "/steward/assets/x/ipo",
      "/steward/community",
      "/steward/list",
      "/steward/listings",
    ];
    // ...and each one's twin in the sandbox (`/sandbox/*`).
    const twins = app.map((r) => (r === "/" ? "/sandbox" : `/sandbox${r}`));
    expect(LOADERS.map((l) => l.route).sort()).toEqual(
      [...app, ...twins].sort(),
    );
  });

  it("draws the Marketplace's skeleton only for the Marketplace", () => {
    // A loading.tsx is a Suspense boundary for every page below its folder: in
    // `(exchange)/` it would flash the Marketplace on the way to a site or Your stakes.
    const exchange = join(process.cwd(), "src/app/(exchange)");
    expect(existsSync(join(exchange, "loading.tsx"))).toBe(false);
    const market = join(exchange, "(market)");
    expect(existsSync(join(market, "loading.tsx"))).toBe(true);
    const below = readdirSync(market, { withFileTypes: true });
    expect(below.filter((entry) => entry.isDirectory())).toEqual([]);
    expect(below.map((entry) => entry.name).sort()).toEqual([
      "loading.tsx",
      "page.tsx",
    ]);
  });

  it.each(LOADERS.map((l) => [l.route, l.Loading] as const))(
    "%s: the gates' shape for the route, one status, no spinner",
    (route, Loading) => {
      // A screen folder's pages (`/steward/assets/x/verify`) share its loading state; the
      // opening offer has its own, with the checklist band (#216).
      const page = route.endsWith("/steward/assets/x")
        ? `${route}/verify`
        : route;
      render(<Loading />, { wrapper: Shell });
      expect(region()).toHaveAttribute("data-skeleton", skeletonKind(page));
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(document.querySelector(".animate-spin")).toBeNull();
    },
  );

  it.each([
    ["/", "Rated sites"],
    ["/admin", "Time Machine"],
    ["/admin/verifications", "Verified land"],
    ["/portfolio", "Your stakes"],
    ["/steward/listings", "Listings"],
  ])("%s draws its real heading", (route, heading) => {
    const { Loading } = LOADERS.find((l) => l.route === route)!;
    render(<Loading />, { wrapper: Shell });
    expect(
      screen.getByRole("heading", { name: heading, level: 1 }),
    ).toBeVisible();
  });

  it.each([
    ["/asset/x", "Rated sites", "/"],
    ["/steward/community", "Community home", "/steward"],
  ])("%s keeps its real back link", (route, name, href) => {
    const { Loading } = LOADERS.find((l) => l.route === route)!;
    render(<Loading />);
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  });
});

describe("RouteSkeleton", () => {
  it.each([
    ["/", "marketplace"],
    ["/asset/35df5b9e-90ff-4205-a82e-9ca6e0e06729", "asset"],
    ["/portfolio", "portfolio"],
    ["/steward", "steward-home"],
    ["/steward/community", "community-settings"],
    ["/steward/assets/abc/verify", "screen"],
    ["/steward/assets/abc/evidence", "screen"],
    ["/steward/assets/abc/ipo", "ipo"],
    ["/admin", "time-machine"],
    ["/admin/verifications", "queue"],
    ["/admin/verifications/abc", "review"],
    ["/steward/list", "page"],
    ["/steward/listings", "listings"],
  ])("draws %s's shape with the gate's label", (path, shape) => {
    nav.pathname = path;
    render(<RouteSkeleton label="Checking your session…" />, {
      wrapper: Shell,
    });
    expect(region()).toHaveAttribute("data-skeleton", shape);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your session…",
    );
  });
});

describe("IpoSkeleton", () => {
  /** The cards of a skeleton, in order: their radius, and their columns' parent. */
  function cards() {
    return [
      ...region().querySelectorAll<HTMLElement>(".bg-card.shadow-soft"),
    ].map((card) => ({
      radius: [...card.classList].find((c) => c.startsWith("rounded-")),
      inColumns: card.parentElement!.className.includes("lg:grid-cols-2"),
    }));
  }

  it("draws the opening offer's checklist band between the header and the columns", () => {
    render(<IpoSkeleton />);
    expect(region()).toHaveAttribute("data-skeleton", "ipo");
    expect(cards()).toEqual([
      { radius: "rounded-[1.75rem]", inColumns: false },
      { radius: "rounded-[1.75rem]", inColumns: true },
      { radius: "rounded-[1.75rem]", inColumns: true },
    ]);
  });

  it("keeps the other focused screens without it", () => {
    render(<ScreenSkeleton />);
    expect(region()).toHaveAttribute("data-skeleton", "screen");
    expect(cards().every((c) => c.inColumns)).toBe(true);
  });
});

describe("MachineRowsSkeleton", () => {
  it("draws rows on the machine layer with one status", () => {
    render(<MachineRowsSkeleton label="Loading model calls…" intro />);
    expect(region()).toHaveAttribute("data-skeleton", "machine-rows");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading model calls…",
    );
  });
});
