import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { QuarterResult } from "@/components/time-machine/quarter-result";
import { QuarterSection } from "@/components/time-machine/quarter-section";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";
import { QUARTER_NO_SITES } from "@/lib/empty-states";

import { stubBrowserApis } from "../exchange/render";
import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
} from "../lib/helpers";
import { DEMO_ADMIN_WORLD, HERO, QUARTER, STATE } from "./fixtures";

/** WP4 (#216): a quarter's result points at what changed; the timeline shows time passing. */

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(stubBrowserApis);
beforeEach(() => FakeEventSource.reset());

describe("QuarterResult", () => {
  it("links each site to its price and offers the Marketplace", () => {
    render(<QuarterResult result={QUARTER} />);
    expect(
      screen.getByRole("link", { name: "Xochimilco Wetland" }),
    ).toHaveAttribute("href", `/asset/${HERO}?tab=price`);
    expect(
      screen.getByRole("link", { name: "See Rated sites" }),
    ).toHaveAttribute("href", "/");
  });

  it("teaches what a quarter re-rates when no site was listed", () => {
    render(<QuarterResult result={{ ...QUARTER, assets: [] }} />);
    expect(screen.getByText(QUARTER_NO_SITES)).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("QuarterSection timeline", () => {
  function renderSection() {
    const backend = fakeBackend({
      "GET /world": () => json(DEMO_ADMIN_WORLD),
    });
    const layer = createDataLayer({
      baseUrl: BASE,
      fetch: backend.fetch,
      createEventSource: createFakeEventSource,
      pollIntervalMs: 60_000,
    });
    const tree = (step: number): ReactNode => (
      <WorldProvider dataLayer={layer}>
        <QuarterSection
          state={{
            ...STATE,
            step,
            current: STATE.timeline[step]!,
            next: STATE.timeline[step + 1] ?? null,
          }}
          listed={1}
          names={new Map()}
          onRefresh={() => {}}
        />
      </WorldProvider>
    );
    const view = render(tree(0));
    return { advance: (step: number) => view.rerender(tree(step)) };
  }

  function fills() {
    const items = within(
      screen.getByRole("list", { name: "Quarters" }),
    ).getAllByRole("listitem");
    return items.map(
      (item) =>
        item.querySelector("[data-filled]")?.getAttribute("data-filled") ??
        "empty",
    );
  }

  it("fills a segment reached while the panel is open, and only that one", () => {
    const { advance } = renderSection();
    expect(fills()).toEqual(["drawn", "empty", "empty"]);
    advance(1);
    expect(fills()).toEqual(["drawn", "new", "empty"]);
    const fresh = screen
      .getByRole("list", { name: "Quarters" })
      .querySelector("[data-filled=new]");
    // Transform only (a slide inside a clipped track), still under reduced motion.
    expect(fresh).toHaveClass(
      "slide-in-from-left",
      "motion-reduce:animate-none",
    );
  });
});
