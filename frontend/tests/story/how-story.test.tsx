import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import JudgePage from "@/app/how/page";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";
import { dollars } from "@/lib/story";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  json,
  WORLD,
} from "../lib/helpers";
import story from "./story.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/how",
  useSearchParams: () => new URLSearchParams(),
}));

// Leaflet's animations wait on tiles and images jsdom never loads: the map is a stand-in whose
// every move has landed at once (the story's own logic is what's tested).
vi.mock("@/components/story/story-map", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  const done = () => Promise.resolve();
  return {
    StoryMap: forwardRef(function StoryMap(_props, ref) {
      useImperativeHandle(ref, () => ({
        flyToSite: done,
        drawBoundary: done,
        revealLandCover: done,
        hideLandCover: () => {},
        sweepViews: done,
        hideViews: () => {},
        markNorthEdge: done,
        reset: () => {},
      }));
      return null;
    }),
  };
});

function setup() {
  const live = fakeBackend({
    "GET /world": () => json(WORLD),
    "GET /story": () => json(story),
    "GET /media/demo-sites/wetland_mx/recorded-run.json": () =>
      json({ detail: "not_found" }, { status: 404 }),
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
  return live;
}

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // Reduced motion: every scene settles at once, so a test can walk the whole story.
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

/** The panel that holds each part: focus lands here when a part's button goes away. */
function panel() {
  return screen.getByRole("heading", { level: 1 }).closest("[tabindex='-1']");
}

/** A pattern matching `text` literally ("$21.47" has a `$`). */
const literally = (text: string) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

async function next(name: RegExp | string) {
  fireEvent.click(await screen.findByRole("button", { name }));
}

describe("/how", () => {
  it("opens straight on the rating, with where the wetland is", async () => {
    setup();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: `${Math.round(Number(story.site.area_ha))} hectares of wetland in ${story.site.place}. What is it worth alive?`,
      }),
    ).toBeVisible();
    expect(screen.getByRole("img", { name: "Part 1 of 4" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Skip to the sandbox/ }),
    ).toHaveAttribute("href", "/sandbox");
  });

  it("walks four parts, each ending on a question, into the sandbox", async () => {
    setup();
    await next(/Rate it/);
    await waitFor(() => expect(document.activeElement).toBe(panel()));

    await next(/Who pays for that\?/);
    expect(
      await screen.findByRole("img", { name: "Part 2 of 4" }),
    ).toBeVisible();
    // The opening price is the story API's, never the browser's.
    expect(
      screen.getByText(
        literally(`${dollars(story.market.opening_price)} a unit`),
      ),
    ).toBeVisible();
    await next(/Back it as Arjun/);
    await waitFor(() => expect(document.activeElement).toBe(panel()));
    expect(
      screen.getByText(
        literally(`${dollars(story.market.backing.paid)} to the community`),
      ),
    ).toBeVisible();

    await next(/What if the land changes\?/);
    expect(
      await screen.findByRole("img", { name: "Part 3 of 4" }),
    ).toBeVisible();
    await next(/Damage the north edge/);
    await next(/Restore it/);

    await next(/Can anyone fake a rating\?/);
    expect(
      await screen.findByRole("img", { name: "Part 4 of 4" }),
    ).toBeVisible();
    await next(/Try to turn the/);
    await next(/Want to try it yourself\?/);

    expect(
      await screen.findByRole("heading", { name: /Your turn/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: /Try it yourself/ }),
    ).toHaveAttribute("href", "/sandbox");
    // Nothing left to skip; and the old vocabulary is gone.
    expect(screen.queryByRole("link", { name: /Skip/ })).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Steward|Exchange/);
    expect(text.match(/play money/gi) ?? []).toHaveLength(0);
  });

  it("says play money once, where money first changes hands", async () => {
    setup();
    await next(/Rate it/);
    await next(/Who pays for that\?/);
    expect(await screen.findAllByText(/play money/i)).toHaveLength(1);
  });

  it("watches again from the start, with focus in the story", async () => {
    setup();
    await next(/Rate it/);
    for (const step of [
      /Who pays for that\?/,
      /Back it as Arjun/,
      /What if the land changes\?/,
      /Damage the north edge/,
      /Restore it/,
      /Can anyone fake a rating\?/,
      /Try to turn the/,
      /Want to try it yourself\?/,
    ])
      await next(step);
    await next("Watch again");

    expect(
      await screen.findByRole("img", { name: "Part 1 of 4" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Rate it/ })).toBeVisible();
    await waitFor(() => expect(document.activeElement).toBe(panel()));
  });
});
