import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrototypeAssetView } from "@/components/proto/prototype-asset-view";
import { TOUR_STEPS, useTour } from "@/components/proto/tour";
import { TraceSheet } from "@/components/proto/trace-sheet";
import { usePrototype } from "@/lib/prototype/store";
import { useRouter } from "next/navigation";
import { HERO_ID } from "@/lib/prototype/world";

import { renderExchange, stubBrowserApis } from "../exchange/render";
import { FakeEventSource, json } from "../lib/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/asset/${HERO_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(stubBrowserApis);
beforeEach(() => {
  FakeEventSource.reset();
  localStorage.clear();
});

const STEP = TOUR_STEPS.findIndex((s) => s.target === "trace-button");

/** The tour card's controls: go to the step, then its "do it for me" button. */
function TourAtTrace() {
  const tour = useTour();
  const store = usePrototype();
  const router = useRouter();
  return (
    <>
      <button type="button" onClick={() => tour.go(STEP)}>
        Tour step: Agent Trace
      </button>
      <button
        type="button"
        onClick={() => TOUR_STEPS[STEP]?.doIt?.({ ...store, router })}
      >
        Do it for me
      </button>
    </>
  );
}

describe("The tour's Agent Trace step", () => {
  it("lands on the hero site's trace card, and its action opens the run", async () => {
    expect(TOUR_STEPS[STEP]?.route).toBe(`/asset/${HERO_ID}`);
    const { container } = renderExchange(
      <>
        <TourAtTrace />
        <PrototypeAssetView id={HERO_ID} />
        <TraceSheet />
      </>,
      { "GET /world": () => json({ world: null }) },
    );
    // Even straight from a fresh sandbox the step lists and rates the site first.
    fireEvent.click(
      await screen.findByRole("button", { name: "Tour step: Agent Trace" }),
    );
    const card = await screen.findByRole("region", {
      name: "How the AI rated it",
    });
    const anchor = await within(card).findByRole("button", {
      name: "Open the Agent Trace",
    });
    expect(container.querySelector('[data-tour="trace-button"]')).toBe(anchor);

    act(() => screen.getByRole("button", { name: "Do it for me" }).click());
    expect(
      await screen.findByRole("dialog", { name: "Agent Trace" }),
    ).toBeInTheDocument();
  });
});
