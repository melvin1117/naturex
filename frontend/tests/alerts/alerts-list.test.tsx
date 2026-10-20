import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AlertsList } from "@/components/alerts-list";
import { WorldProvider } from "@/components/world-provider";
import type { AlertList, AlertOut } from "@/lib/api/types";
import { createDataLayer } from "@/lib/data-layer";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  SIGNED_IN_WORLD,
  WORLD,
} from "../lib/helpers";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portfolio",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const WETLAND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function alert(overrides: Partial<AlertOut> = {}): AlertOut {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    asset_id: WETLAND,
    asset_name: "Xochimilco Wetland",
    kind: "grade_change",
    title: "Xochimilco Wetland downgraded to BBB",
    message: "Health 72.0 → 64.5 (−7.5 points). Grade A → BBB.",
    severity: 4,
    url: null,
    report_id: "22222222-2222-4222-8222-222222222222",
    created_at: "2026-10-19T08:00:00Z",
    read_at: null,
    ...overrides,
  };
}

const NEWS = alert({
  id: "33333333-3333-4333-8333-333333333333",
  asset_id: FOREST,
  asset_name: "Osa Forest",
  kind: "news",
  title: "Fire reported near Osa Forest",
  message: "A fire burned part of the buffer zone.",
  severity: 5,
  url: "https://news.example.org/fire",
  report_id: null,
  created_at: "2026-10-18T08:00:00Z",
});

function list(alerts: AlertOut[]): AlertList {
  return {
    alerts,
    unread_count: alerts.filter((a) => a.read_at == null).length,
  };
}

type Routes = Parameters<typeof fakeBackend>[0];

function renderAlerts(
  routes: Routes = {},
  props: { assetIds?: ReadonlySet<string> } = {},
) {
  const backend = fakeBackend({
    "GET /world": () => json(SIGNED_IN_WORLD),
    "GET /alerts": () => json(list([alert(), NEWS])),
    ...routes,
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  render(
    <WorldProvider dataLayer={layer}>
      <AlertsList empty="No alerts yet." {...props} />
    </WorldProvider>,
  );
  return backend;
}

beforeEach(() => FakeEventSource.reset());

describe("AlertsList", () => {
  it("lists my alerts newest first, unread marked, with the asset and source", async () => {
    renderAlerts();

    const items = within(await screen.findByRole("list", { name: "Alerts" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items[0]).toContain("Xochimilco Wetland downgraded to BBB(unread)");
    expect(items[0]).toContain(
      "Health 72.0 → 64.5 (−7.5 points). Grade A → BBB.",
    );
    expect(items[1]).toContain("Fire reported near Osa Forest(unread)");
    expect(screen.getByText("2 unread")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Osa Forest" })).toHaveAttribute(
      "href",
      `/asset/${FOREST}`,
    );
    const source = screen.getByRole("link", { name: /Source/ });
    expect(source).toHaveAttribute("href", "https://news.example.org/fire");
    expect(source).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.getAllByRole("link", { name: /Source/ })).toHaveLength(1);
  });

  it("marks one alert read, then refetches", async () => {
    let read = false;
    const backend = renderAlerts({
      "GET /alerts": () =>
        json(
          list([
            alert({ read_at: read ? "2026-10-19T09:00:00Z" : null }),
            NEWS,
          ]),
        ),
      [`POST /alerts/${alert().id}/read`]: () => {
        read = true;
        return json(alert({ read_at: "2026-10-19T09:00:00Z" }));
      },
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Mark read: Xochimilco Wetland downgraded to BBB",
      }),
    );

    await screen.findByText("1 unread");
    expect(backend.calls(`POST /alerts/${alert().id}/read`)).toBe(1);
    expect(
      screen.queryByRole("button", {
        name: "Mark read: Xochimilco Wetland downgraded to BBB",
      }),
    ).not.toBeInTheDocument();
  });

  it("marks everything read", async () => {
    let read = false;
    const backend = renderAlerts({
      "GET /alerts": () =>
        json(
          list(
            [alert(), NEWS].map((a) =>
              read ? { ...a, read_at: "2026-10-19T09:00:00Z" } : a,
            ),
          ),
        ),
      "POST /alerts/read-all": () => {
        read = true;
        return json({ marked: 2 });
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Mark all read" }),
    );

    await screen.findByText("All read");
    expect(backend.calls("POST /alerts/read-all")).toBe(1);
    expect(
      screen.queryByRole("button", { name: "Mark all read" }),
    ).not.toBeInTheDocument();
  });

  it("refetches when a real alert event arrives", async () => {
    let alerts = [NEWS];
    const backend = renderAlerts({
      "GET /alerts": () => json(list(alerts)),
    });
    await screen.findByText("1 unread");
    await waitFor(() => expect(FakeEventSource.instances).not.toHaveLength(0));

    alerts = [alert(), NEWS];
    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      source.emit("alert", 7, {
        alert_id: alert().id,
        asset_id: WETLAND,
        asset_name: "Xochimilco Wetland",
        kind: "grade_change",
        title: alert().title,
        message: alert().message,
        severity: 4,
        report_id: null,
        url: null,
      });
    });

    await screen.findByText("2 unread");
    expect(backend.calls("GET /alerts")).toBeGreaterThanOrEqual(2);
  });

  it("shows only the given sites' alerts and no mark-all for a filtered list", async () => {
    renderAlerts({}, { assetIds: new Set([FOREST]) });

    await screen.findByText("Fire reported near Osa Forest");
    expect(
      screen.queryByText("Xochimilco Wetland downgraded to BBB"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("1 unread")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mark all read" }),
    ).not.toBeInTheDocument();
  });

  it("says so when there are none", async () => {
    renderAlerts({ "GET /alerts": () => json(list([])) });

    expect(await screen.findByText("No alerts yet.")).toBeInTheDocument();
  });

  it("never asks for alerts when signed out", async () => {
    const backend = renderAlerts({ "GET /world": () => json(WORLD) });

    await waitFor(() => expect(backend.calls("GET /world")).toBe(1));
    expect(backend.calls("GET /alerts")).toBe(0);
    expect(
      screen.getByRole("status", { name: "Loading alerts" }),
    ).toBeInTheDocument();
  });
});
