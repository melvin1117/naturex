import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AlertToaster } from "@/components/proto/alert-toaster";
import { WorldProvider } from "@/components/world-provider";
import { createDataLayer } from "@/lib/data-layer";
import { PrototypeProvider } from "@/lib/prototype/store";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  SIGNED_IN_WORLD,
} from "../lib/helpers";

const sonner = vi.hoisted(() => ({ custom: vi.fn() }));
vi.mock("sonner", () => ({ toast: sonner }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function payload(id: string) {
  return {
    alert_id: id,
    asset_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    asset_name: "Xochimilco Wetland",
    kind: "news",
    title: `Alert ${id}`,
    message: "m",
    severity: 4,
    report_id: null,
    url: null,
  };
}

const NOW = Date.parse("2026-10-07T00:00:00Z");

beforeEach(() => {
  FakeEventSource.reset();
  sonner.custom.mockClear();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => vi.restoreAllMocks());

async function renderToaster() {
  const backend = fakeBackend({ "GET /world": () => json(SIGNED_IN_WORLD) });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <AlertToaster />
      </PrototypeProvider>
    </WorldProvider>,
  );
  await waitFor(() => expect(FakeEventSource.instances).not.toHaveLength(0));
  return FakeEventSource.latest();
}

describe("AlertToaster", () => {
  it("toasts each real alert once, even when a reconnect replays it", async () => {
    await renderToaster();

    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      source.emit("alert", 7, payload("a7"));
      // The browser reconnects with Last-Event-ID; the server may replay what it already sent.
      source.fail(0);
      source.open();
      source.emit("alert", 7, payload("a7"));
      source.emit("alert", 8, payload("a8"));
    });

    expect(sonner.custom).toHaveBeenCalledTimes(2);
  });

  it("doesn't toast the old alerts a new page's stream replays", async () => {
    const source = await renderToaster();

    act(() => {
      source.open();
      // Retained from earlier today: listed in Alerts, not news anymore.
      source.emit("alert", 3, payload("old"), "2026-10-06T21:00:00Z");
      source.emit("alert", 4, payload("just before"), "2026-10-06T23:59:50Z");
    });

    expect(sonner.custom).toHaveBeenCalledTimes(1);
  });
});
