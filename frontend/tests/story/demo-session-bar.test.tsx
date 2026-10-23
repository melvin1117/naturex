import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DemoBar } from "@/components/proto/demo-bar";
import { TourProvider } from "@/components/proto/tour";
import { WorldProvider } from "@/components/world-provider";
import type { WorldOut } from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  json,
  WORLD,
} from "../lib/helpers";

const nav = vi.hoisted(() => ({ push: vi.fn(), pathname: "/" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

function demoWorld(persona: "rosa" | "arjun" | "admin"): WorldOut {
  return {
    ...WORLD,
    label: "visitor",
    me: {
      id: `00000000-0000-4000-8000-00000000000${persona.length}`,
      name: persona,
      email: null,
      kind: "persona",
      is_admin: persona === "admin",
      world_id: WORLD.id,
      persona,
    },
  };
}

function setup(routes: Parameters<typeof fakeBackend>[0]) {
  const backend = fakeBackend(routes);
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>{children}</TourProvider>
      </PrototypeProvider>
    </WorldProvider>
  );
  render(<DemoBar />, { wrapper });
  return { backend, layer };
}

beforeEach(() => {
  nav.push.mockReset();
  nav.pathname = "/";
  window.sessionStorage.clear();
});

describe("Demo bar in a no-sign-up demo session", () => {
  it("shows who you act as and switches persona through the API", async () => {
    const { backend, layer } = setup({
      "GET /world": () => json(demoWorld("arjun")),
      "POST /demo/persona": () => json(demoWorld("admin")),
    });

    const arjun = await screen.findByRole("radio", { name: /Arjun/ });
    expect(arjun).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Your private sandbox.")).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: /Admin/ }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/admin"));
    expect(backend.calls("POST /demo/persona")).toBe(1);
    expect(layer.session.getSnapshot().world?.me?.persona).toBe("admin");
    // The scripted demo is never involved in a real demo session.
    expect(window.sessionStorage.getItem("nx-prototype-demo")).toBeNull();
  });

  it("links back to the story and offers a reset", async () => {
    setup({ "GET /world": () => json(demoWorld("rosa")) });
    expect(
      await screen.findByRole("link", { name: /The story/ }),
    ).toHaveAttribute("href", "/judge");
    expect(
      screen.getByRole("button", { name: /Reset my demo/ }),
    ).toBeInTheDocument();
  });

  it("stays out of the way on the story itself", async () => {
    nav.pathname = "/judge";
    const { layer } = setup({ "GET /world": () => json(demoWorld("rosa")) });
    await waitFor(() =>
      expect(layer.session.getSnapshot().world).not.toBeNull(),
    );
    expect(screen.queryByRole("region", { name: "Demo mode" })).toBeNull();
  });
});
