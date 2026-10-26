import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioView } from "@/components/portfolio-view";
import { WorldGate, WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";
import { resetLoadingChains } from "@/lib/loading-chain";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  json,
  SIGNED_IN_WORLD,
} from "../lib/helpers";

/** WP4 (#216): data screens show their page-shaped skeleton while they load. */

vi.mock("next/navigation", () => ({
  usePathname: () => "/portfolio",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => resetLoadingChains());

const pending = () => new Promise<Response>(() => {});

function renderWithWorld(
  ui: ReactNode,
  routes: Parameters<typeof fakeBackend>[0],
) {
  const backend = fakeBackend(routes);
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  return render(<WorldProvider dataLayer={layer}>{ui}</WorldProvider>);
}

describe("WorldGate fallback", () => {
  it("shows the page's own loading state instead of the generic one", async () => {
    renderWithWorld(
      <WorldGate fallback={<p role="status">Page skeleton</p>}>
        <p>Gated</p>
      </WorldGate>,
      { "GET /world": pending },
    );
    expect(screen.getByRole("status")).toHaveTextContent("Page skeleton");
    expect(screen.queryByText(/Opening your demo world/)).toBeNull();
    expect(screen.queryByText("Gated")).toBeNull();
  });

  it("renders the gated section once the world exists", async () => {
    renderWithWorld(
      <WorldGate fallback={<p role="status">Page skeleton</p>}>
        <p>Gated</p>
      </WorldGate>,
      { "GET /world": () => json(SIGNED_IN_WORLD) },
    );
    expect(await screen.findByText("Gated")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps a deliberate empty fallback empty", () => {
    const { container } = renderWithWorld(
      <WorldGate fallback={null}>
        <p>Gated</p>
      </WorldGate>,
      { "GET /world": pending },
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("PortfolioView loading", () => {
  it("draws the portfolio's shape with one status under the real heading", async () => {
    renderWithWorld(<PortfolioView />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /portfolio": pending,
    });
    expect(await screen.findByText("Loading your stakes…")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(
      document.querySelector("[data-skeleton=portfolio]"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Your stakes", level: 1 }),
    ).toBeVisible();
  });
});
