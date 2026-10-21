import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AssetLoading from "@/app/(exchange)/asset/[id]/loading";
import PortfolioLoading from "@/app/(exchange)/portfolio/loading";
import AdminLoading from "@/app/admin/loading";
import ReviewLoading from "@/app/admin/verifications/[id]/loading";
import QueueLoading from "@/app/admin/verifications/loading";
import StewardScreenLoading from "@/app/steward/assets/[id]/loading";
import CommunityLoading from "@/app/steward/community/loading";
import ListLoading from "@/app/steward/list/loading";
import StewardLoading from "@/app/steward/loading";
import {
  LoadingRegion,
  SLOW_AFTER_MS,
  SLOW_NOTE,
} from "@/components/loading-region";
import {
  MachineRowsSkeleton,
  RouteSkeleton,
} from "@/components/page-skeletons";

const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}));

beforeEach(() => {
  nav.pathname = "/";
});

afterEach(() => {
  vi.useRealTimers();
});

/** The one region on screen, and its single status. */
function region() {
  const regions = document.querySelectorAll("[data-slot=loading-region]");
  expect(regions).toHaveLength(1);
  return regions[0] as HTMLElement;
}

describe("LoadingRegion", () => {
  it("announces what's loading once, and hides its blocks from assistive tech", () => {
    render(
      <LoadingRegion name="test" label="Loading the site…">
        <div data-testid="block" />
      </LoadingRegion>,
    );
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent(/^Loading the site…$/);
    expect(screen.getByTestId("block").closest("[aria-hidden=true]")).not.toBe(
      null,
    );
    // The status itself isn't inside the hidden part, and doesn't hold the region busy
    // (some screen readers wait for aria-busy to clear before announcing).
    expect(statuses[0]!.closest("[aria-hidden=true]")).toBeNull();
    expect(region()).not.toHaveAttribute("aria-busy");
  });

  it("says why after a long wait, in the same status", () => {
    vi.useFakeTimers();
    render(
      <LoadingRegion name="test" label="Loading the site…">
        <div />
      </LoadingRegion>,
    );
    act(() => vi.advanceTimersByTime(SLOW_AFTER_MS - 1));
    expect(screen.getByRole("status")).toHaveTextContent("Loading the site…");

    act(() => vi.advanceTimersByTime(1));
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toHaveTextContent(SLOW_NOTE);
    expect(statuses[0]).toBeVisible();
    expect(SLOW_NOTE).toMatch(/waking up/);
  });

  it("stops its timer when the content arrives", () => {
    vi.useFakeTimers();
    const view = render(
      <LoadingRegion name="test" label="Loading…">
        <div />
      </LoadingRegion>,
    );
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("route loading states", () => {
  it.each([
    ["asset page", AssetLoading, "asset", "Loading the site…"],
    ["portfolio", PortfolioLoading, "portfolio", "Loading your stakes…"],
    ["steward home", StewardLoading, "steward-home", "Loading your community…"],
    ["listing form", ListLoading, "page", "Loading the listing form…"],
    ["community settings", CommunityLoading, "page", "Loading your community…"],
    ["a steward screen", StewardScreenLoading, "screen", "Checking this site…"],
    ["Time Machine", AdminLoading, "time-machine", "Loading the Time Machine…"],
    ["verification queue", QueueLoading, "list", "Loading the queue…"],
    ["a listing review", ReviewLoading, "review", "Loading the review…"],
  ])(
    "%s: a page-shaped skeleton with one status",
    (_, Loading, shape, label) => {
      render(<Loading />);
      expect(region()).toHaveAttribute("data-skeleton", shape);
      const statuses = screen.getAllByRole("status");
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toHaveTextContent(label);
      // Never a spinner for a page (principle 9).
      expect(document.querySelector(".animate-spin")).toBeNull();
    },
  );

  it("keeps real navigation on the asset page while it loads", () => {
    render(<AssetLoading />);
    expect(screen.getByRole("link", { name: "Marketplace" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("names the portfolio before its numbers arrive", () => {
    render(<PortfolioLoading />);
    expect(
      screen.getByRole("heading", { name: "Your stakes", level: 1 }),
    ).toBeVisible();
  });
});

describe("RouteSkeleton", () => {
  it.each([
    ["/portfolio", "portfolio"],
    ["/steward", "steward-home"],
    ["/steward/assets/abc/ipo", "screen"],
    ["/admin", "time-machine"],
    ["/admin/verifications", "list"],
    ["/admin/verifications/abc", "review"],
    ["/steward/list", "page"],
  ])("draws %s's shape for a gate", (path, shape) => {
    nav.pathname = path;
    render(<RouteSkeleton label="Checking your session…" />);
    expect(region()).toHaveAttribute("data-skeleton", shape);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking your session…",
    );
  });
});

describe("MachineRowsSkeleton", () => {
  it("draws rows on the machine layer with one status", () => {
    render(<MachineRowsSkeleton label="Loading model calls…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading model calls…");
    expect(
      within(region()).getAllByRole("status", { hidden: true }),
    ).toHaveLength(1);
  });
});
