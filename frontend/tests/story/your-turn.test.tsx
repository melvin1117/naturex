import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import JudgePage from "@/app/how/page";
import { TourProvider } from "@/components/proto/tour";
import { YourTurn } from "@/components/story/judge-story";
import { WorldProvider } from "@/components/world-provider";
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

describe("/how", () => {
  it("opens straight on the rating: the welcome already set the scene", async () => {
    setup();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: /hectares of wetland\. What is it worth alive\?/,
      }),
    ).toBeVisible();
    expect(screen.getByRole("img", { name: "Part 1 of 4" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Rate it/ })).toBeVisible();
  });

  it("can be skipped straight into the sandbox, without starting one itself", async () => {
    const live = setup();
    await screen.findByRole("heading", { level: 1 });

    expect(
      screen.getByRole("link", { name: /Skip to the sandbox/ }),
    ).toHaveAttribute("href", "/sandbox");
    expect(live.calls("POST /demo/start")).toBe(0);
  });
});

describe("/how: your turn", () => {
  it("leads into the sandbox with one link, no sign-up step", () => {
    const replay = vi.fn();
    render(<YourTurn onReplay={replay} />);

    expect(
      screen.getByRole("heading", { name: /Your turn/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Try it yourself/ }),
    ).toHaveAttribute("href", "/sandbox");
    fireEvent.click(screen.getByRole("button", { name: "Watch again" }));
    expect(replay).toHaveBeenCalledOnce();
  });
});
