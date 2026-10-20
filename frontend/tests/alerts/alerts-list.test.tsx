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

function list(
  alerts: AlertOut[],
  next_before: string | null = null,
): AlertList {
  return {
    alerts,
    unread_count: alerts.filter((a) => a.read_at == null).length,
    next_before,
  };
}

type Routes = Parameters<typeof fakeBackend>[0];

function renderAlerts(
  routes: Routes = {},
  props: { communityId?: string } = {},
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

  it("asks the API for one community's alerts and marks only those read", async () => {
    const COMMUNITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let read = false;
    const backend = renderAlerts(
      {
        "GET /alerts": (request) => {
          const query = new URL(request.url).searchParams;
          expect(query.get("community_id")).toBe(COMMUNITY);
          // The server's count covers every unread alert of the community, not just this page.
          return json({
            ...list([read ? { ...NEWS, read_at: "x" } : NEWS]),
            unread_count: read ? 0 : 3,
          });
        },
        "POST /alerts/read-all": (request) => {
          expect(new URL(request.url).searchParams.get("community_id")).toBe(
            COMMUNITY,
          );
          read = true;
          return json({ marked: 3 });
        },
      },
      { communityId: COMMUNITY },
    );

    expect(await screen.findByText("3 unread")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));

    await screen.findByText("All read");
    expect(backend.calls("POST /alerts/read-all")).toBe(1);
  });

  it("shows older alerts a page at a time", async () => {
    const OLDEST = alert({
      id: "44444444-4444-4444-8444-444444444444",
      title: "Oldest alert",
      created_at: "2026-10-01T08:00:00Z",
    });
    const backend = renderAlerts({
      "GET /alerts": (request) => {
        const before = new URL(request.url).searchParams.get("before");
        if (before === null) return json(list([alert(), NEWS], NEWS.id));
        expect(before).toBe(NEWS.id);
        return json({ ...list([OLDEST]), unread_count: 3 });
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Show older alerts" }),
    );

    const older = await screen.findByRole("list", { name: "Older alerts" });
    expect(within(older).getByText("Oldest alert")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show older alerts" }),
    ).not.toBeInTheDocument();
    expect(backend.calls("GET /alerts")).toBeGreaterThanOrEqual(2);
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
