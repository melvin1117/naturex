import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AlertsBell } from "@/components/shell/alerts-bell";
import type { AlertList, AlertOut } from "@/lib/api/types";

import { renderExchange, stubBrowserApis } from "../exchange/render";
import { FakeEventSource, json, SIGNED_IN_WORLD } from "../lib/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(stubBrowserApis);
beforeEach(() => {
  FakeEventSource.reset();
  // The prototype world (and its scripted alerts) persists across renders.
  localStorage.clear();
});

const WETLAND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
    report_id: null,
    created_at: "2026-10-19T08:00:00Z",
    read_at: null,
    ...overrides,
  };
}

const NEWS = alert({
  id: "33333333-3333-4333-8333-333333333333",
  kind: "news",
  title: "Fire reported near the wetland",
  message: "A fire burned part of the buffer zone.",
  severity: 5,
});

const ALERT_EVENT = {
  alert_id: alert().id,
  asset_id: WETLAND,
  asset_name: "Xochimilco Wetland",
  kind: "grade_change",
  title: alert().title,
  message: alert().message,
  severity: 4,
  report_id: null,
  url: null,
};

function list(alerts: AlertOut[]): AlertList {
  return {
    alerts,
    unread_count: alerts.filter((a) => a.read_at == null).length,
    next_before: null,
  };
}

describe("Header bell, signed in (#199)", () => {
  it("shows the unread count from GET /alerts and opens the real alerts", async () => {
    renderExchange(<AlertsBell />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /alerts": () => json(list([alert(), NEWS])),
    });

    const bell = await screen.findByRole("button", {
      name: "Alerts, 2 unread",
    });
    // The Agent Trace opens from a site's page and "AI at work", not the header.
    expect(screen.queryByRole("button", { name: "Agent Trace" })).toBeNull();
    fireEvent.click(bell);

    const popover = await screen.findByRole("dialog", { name: "Your alerts" });
    const items = within(
      within(popover).getByRole("list", { name: "Alerts" }),
    ).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Xochimilco Wetland downgraded to BBB");
    expect(
      within(items[0]!).getByRole("link", { name: "Xochimilco Wetland" }),
    ).toHaveAttribute("href", `/asset/${WETLAND}`);
  });

  it("marks one alert read and updates the count", async () => {
    let read = false;
    const backend = renderExchange(<AlertsBell />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
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
    }).backend;

    fireEvent.click(
      await screen.findByRole("button", { name: "Alerts, 2 unread" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Mark read: Xochimilco Wetland downgraded to BBB",
      }),
    );

    expect(
      await screen.findByRole("button", { name: "Alerts, 1 unread" }),
    ).toBeInTheDocument();
    expect(backend.calls(`POST /alerts/${alert().id}/read`)).toBe(1);
  });

  it("marks everything read", async () => {
    let read = false;
    const { backend } = renderExchange(<AlertsBell />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
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
      await screen.findByRole("button", { name: "Alerts, 2 unread" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Mark all read" }),
    );

    expect(
      await screen.findByRole("button", { name: "Alerts, all read" }),
    ).toBeInTheDocument();
    expect(backend.calls("POST /alerts/read-all")).toBe(1);
  });

  it("updates and announces the count on a live alert event", async () => {
    let alerts = [NEWS];
    renderExchange(<AlertsBell />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /alerts": () => json(list(alerts)),
    });
    await screen.findByRole("button", { name: "Alerts, 1 unread" });
    // Nothing is announced for the count already there on load.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await waitFor(() => expect(FakeEventSource.instances).not.toHaveLength(0));

    alerts = [alert(), NEWS];
    act(() => {
      const source = FakeEventSource.latest();
      source.open();
      source.emit("alert", 9, {
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

    expect(
      await screen.findByRole("button", { name: "Alerts, 2 unread" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("2 unread alerts"),
    );
  });

  it("announces a count it announced before again", async () => {
    let alerts = [NEWS];
    renderExchange(<AlertsBell />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /alerts": () => json(list(alerts)),
    });
    await screen.findByRole("button", { name: "Alerts, 1 unread" });
    await waitFor(() => expect(FakeEventSource.instances).not.toHaveLength(0));
    const status = screen.getByRole("status");
    const heard: string[] = [];
    const observer = new MutationObserver(() =>
      heard.push(status.textContent ?? ""),
    );
    observer.observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const source = FakeEventSource.latest();
    act(() => source.open());
    const arrive = async (next: AlertOut[], id: number) => {
      alerts = next;
      act(() => source.emit("alert", id, ALERT_EVENT));
      await screen.findByRole("button", {
        name: `Alerts, ${next.length} unread`,
      });
    };

    await arrive([alert(), NEWS], 9);
    await waitFor(() => expect(status).toHaveTextContent("2 unread alerts"));
    await arrive([NEWS], 10);
    await arrive([alert(), NEWS], 11);
    await waitFor(() => expect(heard.at(-1)).toBe("2 unread alerts"));
    observer.disconnect();

    // Emptied before each announcement, so the repeated "2 unread alerts" is spoken again.
    expect(heard.filter(Boolean)).toEqual([
      "2 unread alerts",
      "2 unread alerts",
    ]);
    expect(heard.at(-2)).toBe("");
  });

  it("doesn't announce another account's count when the account changes", async () => {
    const other = {
      ...SIGNED_IN_WORLD,
      me: {
        ...SIGNED_IN_WORLD.me!,
        id: "55555555-5555-4555-8555-555555555555",
      },
    };
    let alerts = [NEWS];
    const { layer } = renderExchange(<AlertsBell />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /alerts": () => json(list(alerts)),
    });
    await screen.findByRole("button", { name: "Alerts, 1 unread" });

    alerts = [
      alert(),
      NEWS,
      alert({ id: "22222222-2222-4222-8222-222222222222" }),
    ];
    act(() => layer.session.set(other));

    expect(
      await screen.findByRole("button", { name: "Alerts, 3 unread" }),
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("shows a plain bell while the world loads", async () => {
    const { backend } = renderExchange(<AlertsBell />, {
      "GET /world": () => new Promise<Response>(() => {}),
    });
    await waitFor(() => expect(backend.calls("GET /world")).toBe(1));

    const bell = screen.getByRole("button", { name: "Alerts" });
    expect(bell).toBeDisabled();
    expect(bell).toHaveTextContent("");
    expect(
      screen.queryByRole("button", { name: /unread/ }),
    ).not.toBeInTheDocument();
    expect(backend.calls("GET /alerts")).toBe(0);
  });

  it("shows the Reviewer the bell too", async () => {
    renderExchange(<AlertsBell />, {
      "GET /world": () => json(SIGNED_IN_WORLD),
      "GET /alerts": () => json(list([])),
    });
    expect(
      await screen.findByRole("button", { name: "Alerts, all read" }),
    ).toBeInTheDocument();
  });
});
