import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import StewardLayout from "@/app/sandbox/steward/layout";
import { ReviewerGate } from "@/components/reviewer-gate";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer, type DataLayer } from "@/lib/data-layer";
import { usePortfolio, useSignOut, useWorld } from "@/lib/hooks";

import {
  BASE,
  community,
  fakeBackend,
  json,
  sequence,
  SIGNED_IN_WORLD,
  WORLD,
} from "./lib/helpers";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
}));
const nav = vi.hoisted(() => ({ pathname: "/", search: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

beforeAll(() => {
  // jsdom lacks these; Radix menus ask for them.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = "/";
  nav.search = "";
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

type Routes = Parameters<typeof fakeBackend>[0];

function setup(ui: ReactNode, routes: Routes = {}) {
  const backend = fakeBackend({ "GET /world": () => json(WORLD), ...routes });
  const layer: DataLayer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
  });
  const utils = render(<WorldProvider dataLayer={layer}>{ui}</WorldProvider>);
  return { ...utils, backend, layer };
}

describe("ReviewerGate", () => {
  const Secret = () => <p>Your stakes</p>;

  it("waits for the sandbox's session rather than sending anyone to sign in", async () => {
    setup(
      <ReviewerGate>
        <Secret />
      </ReviewerGate>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Opening your sandbox…",
    );
    expect(screen.queryByText("Your stakes")).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("offers to switch to the Reviewer instead of looping on a 403", async () => {
    setup(
      <ReviewerGate>
        <Secret />
      </ReviewerGate>,
      { "GET /world": () => json(SIGNED_IN_WORLD) },
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Only the Reviewer sees this page",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Switch to the Reviewer" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("link", { name: "Go to the Marketplace" }),
    ).toHaveAttribute("href", "/");
    expect(screen.queryByText("Your stakes")).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("lets an admin into admin routes", async () => {
    setup(
      <ReviewerGate>
        <Secret />
      </ReviewerGate>,
      {
        "GET /world": () =>
          json({
            ...SIGNED_IN_WORLD,
            me: { ...SIGNED_IN_WORLD.me, is_admin: true },
          }),
      },
    );
    expect(await screen.findByText("Your stakes")).toBeVisible();
  });
});

describe("the Communities layout", () => {
  const Child = () => <p>Protected content</p>;

  it("/steward shows its children to a community member", async () => {
    nav.pathname = "/steward";
    setup(
      <StewardLayout>
        <Child />
      </StewardLayout>,
      {
        "GET /world": () => json(SIGNED_IN_WORLD),
        "GET /me/communities": () => json([community()]),
      },
    );
    // The layout's Suspense swaps its first render: check the settled page.
    await waitFor(() =>
      expect(screen.getByText("Protected content")).toBeVisible(),
    );
  });
});

describe("when GET /world fails after the session changed", () => {
  const serverError = () => json({ detail: "internal_error" }, { status: 500 });
  const portfolio = (cash: string) => () =>
    json({ cash_balance: cash, holdings: [], impact: {} });

  function Harness() {
    const { world } = useWorld();
    const cash = usePortfolio().data?.cash_balance ?? "none";
    const signOut = useSignOut();
    return (
      <>
        <p>
          Viewer {world?.me?.name ?? "anonymous"}, cash {cash}
        </p>
        <button onClick={() => void signOut.mutate()}>Out</button>
      </>
    );
  }

  it("after sign-out, drops the account locally and resets the cache", async () => {
    const { backend, layer } = setup(<Harness />, {
      "GET /world": sequence(() => json(SIGNED_IN_WORLD), serverError),
      "GET /portfolio": sequence(portfolio("10.00"), portfolio("0.00")),
      "POST /auth/logout": () => new Response(null, { status: 204 }),
    });
    expect(await screen.findByText("Viewer Rosa, cash 10.00")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Out" }));

    expect(
      await screen.findByText("Viewer anonymous, cash 0.00"),
    ).toBeVisible();
    expect(backend.calls("GET /portfolio")).toBe(2);
    expect(layer.session.getSnapshot().world?.me).toBeNull();
  });
});
