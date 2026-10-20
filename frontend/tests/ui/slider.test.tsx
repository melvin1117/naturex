import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ListingFlow } from "@/components/proto/listing-flow";
import { TourProvider } from "@/components/proto/tour";
import { Slider } from "@/components/ui/slider";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";
import {
  createInitialWorld,
  rateDraft,
  registerCommunity,
} from "@/lib/prototype/world";

import { BASE, fakeBackend, json, WORLD } from "../lib/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/steward/list",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

// `ui/slider.tsx` is locally changed (T64): the name goes on the focusable thumb.
describe("Slider", () => {
  it("names a single thumb from aria-label", () => {
    render(<Slider value={[5]} aria-label="Volume" />);
    expect(screen.getByRole("slider", { name: "Volume" })).toBeInTheDocument();
  });

  it("names a single thumb from aria-labelledby", () => {
    render(
      <>
        <span id="label">Community keeps</span>
        <Slider value={[51]} aria-labelledby="label" />
      </>,
    );
    expect(
      screen.getByRole("slider", { name: "Community keeps" }),
    ).toBeInTheDocument();
  });

  it("leaves a range's name on the root, not on each thumb", () => {
    const { container } = render(
      <Slider value={[10, 20]} aria-label="Price range" />,
    );
    const thumbs = screen.getAllByRole("slider");
    expect(thumbs).toHaveLength(2);
    for (const thumb of thumbs) {
      expect(thumb).not.toHaveAccessibleName("Price range");
    }
    expect(container.querySelector('[data-slot="slider"]')).toHaveAttribute(
      "aria-label",
      "Price range",
    );
  });

  it("is named in the listing flow's opening offer", async () => {
    const world = rateDraft(
      registerCommunity(createInitialWorld("steward"), "Selva Viva"),
    );
    window.localStorage.setItem("nx-prototype-world", JSON.stringify(world));
    const layer = createDataLayer({
      baseUrl: BASE,
      fetch: fakeBackend({ "GET /world": () => json(WORLD) }).fetch,
    });
    render(
      <WorldProvider dataLayer={layer}>
        <PrototypeProvider>
          <TourProvider>
            <ListingFlow />
          </TourProvider>
        </PrototypeProvider>
      </WorldProvider>,
    );
    expect(
      await screen.findByRole("slider", {
        name: "Share the community keeps",
      }),
    ).toBeInTheDocument();
  });
});
