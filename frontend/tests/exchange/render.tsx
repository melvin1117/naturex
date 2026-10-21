import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";

import { TourProvider } from "@/components/proto/tour";
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

/** jsdom lacks these; Recharts, Radix and Leaflet ask for them. */
export function stubBrowserApis() {
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
  Element.prototype.scrollIntoView ??= vi.fn();
  Element.prototype.scrollTo ??= vi.fn();
  Element.prototype.hasPointerCapture ??= () => false;
}

/** Render `ui` like app/layout.tsx does, against a fake backend. */
export function renderExchange(
  ui: ReactNode,
  routes: Parameters<typeof fakeBackend>[0] = {},
) {
  const backend = fakeBackend({ "GET /world": () => json(WORLD), ...routes });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
    pollIntervalMs: 60_000,
  });
  const utils = render(
    <WorldProvider dataLayer={layer}>
      <PrototypeProvider>
        <TourProvider>{ui}</TourProvider>
      </PrototypeProvider>
    </WorldProvider>,
  );
  return { ...utils, backend, layer };
}
