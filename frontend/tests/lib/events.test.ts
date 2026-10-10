import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventHub, type LiveEvent } from "@/lib/events";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  sequence,
  worldRequired,
} from "./helpers";

type PollRoutes = Parameters<typeof fakeBackend>[0];

function setup(
  routes: PollRoutes = {},
  extra: Partial<ConstructorParameters<typeof EventHub>[0]> = {},
) {
  const backend = fakeBackend({ "GET /events": () => json([]), ...routes });
  const refreshSession = vi.fn(async () => undefined);
  const hub = new EventHub({
    baseUrl: BASE,
    createEventSource: createFakeEventSource,
    fetch: (url, init) => backend.fetch(new Request(url, init)),
    refreshSession,
    pollIntervalMs: 3000,
    maxSseErrors: 3,
    sseRetryDelaysMs: [10_000, 20_000],
    ...extra,
  });
  const pollUrls = () =>
    backend.requests
      .filter((r) => new URL(r.url).pathname.endsWith("/events"))
      .map((r) => new URL(r.url).search);
  return { hub, backend, refreshSession, pollUrls };
}

const tick = (id: number, price = "10.00") => ({
  id,
  type: "price_tick",
  payload: { asset_id: "a1", price, reason: "trade" },
  ts: "2026-10-07T00:00:00Z",
});

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EventHub over SSE", () => {
  it("delivers typed events, skips heartbeats and duplicate ids", async () => {
    const { hub } = setup();
    const ticks: LiveEvent<"price_tick">[] = [];
    const alerts = vi.fn();
    hub.subscribe("price_tick", (event) => ticks.push(event));
    hub.subscribe("alert", alerts);
    await flush();

    const source = FakeEventSource.latest();
    expect(source.url).toBe(`${BASE}/events/stream`);
    source.open();
    expect(hub.transport).toBe("sse");

    source.emit("price_tick", 1, {
      asset_id: "a1",
      price: "10.50",
      reason: "trade",
    });
    source.emit("heartbeat", null);
    source.emit("price_tick", 1, {
      asset_id: "a1",
      price: "10.50",
      reason: "trade",
    });
    source.emit("alert", 2, { title: "Fire nearby" });

    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ id: 1, payload: { price: "10.50" } });
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(hub.lastEventId).toBe(2);
  });

  it("drops malformed price ticks", async () => {
    const { hub } = setup();
    const handler = vi.fn();
    hub.subscribe("price_tick", handler);
    await flush();
    FakeEventSource.latest().emit("price_tick", 1, {
      asset_id: "a1",
      price: 10.5,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("closes the connection when the last subscriber leaves", async () => {
    const { hub } = setup();
    const offA = hub.subscribe("price_tick", () => {});
    const offB = hub.subscribe("alert", () => {});
    await flush();
    const source = FakeEventSource.latest();

    offA();
    expect(source.closed).toBe(false);
    offB();
    expect(source.closed).toBe(true);
    expect(hub.transport).toBe("idle");
  });

  it("passive listeners don't open a connection", async () => {
    const { hub } = setup();
    hub.subscribe("price_tick", () => {}, { retain: false });
    await flush();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("lets the browser reconnect on its own after a dropped stream", async () => {
    const { hub, backend } = setup();
    hub.subscribe("price_tick", () => {});
    await flush();
    const source = FakeEventSource.latest();
    source.open();

    source.fail(0); // stream ended after 300 s; browser reconnects with Last-Event-ID
    source.open();
    source.fail(0);

    expect(hub.transport).toBe("sse");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(backend.requests).toHaveLength(0);
  });
});

describe("EventHub polling fallback", () => {
  it("polls when SSE is refused (503 → CLOSED), dedupes, then retries SSE", async () => {
    const { hub, backend, pollUrls } = setup({
      "GET /events": sequence(
        () => json([tick(5), tick(6, "11.00")]),
        () => json([tick(7, "12.00")]),
      ),
    });
    const prices: string[] = [];
    hub.subscribe("price_tick", (event) => prices.push(event.payload.price));
    await flush();
    const first = FakeEventSource.latest();
    first.open();
    first.emit("price_tick", 5, tick(5).payload);

    first.fail(2);
    await flush();

    expect(first.closed).toBe(true);
    expect(hub.transport).toBe("polling");
    expect(pollUrls()).toEqual(["?since_id=5"]);
    expect(prices).toEqual(["10.00", "11.00"]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(pollUrls()).toEqual(["?since_id=5", "?since_id=6"]);
    expect(prices).toEqual(["10.00", "11.00", "12.00"]);

    await vi.advanceTimersByTimeAsync(7000); // SSE retry after 10 s
    const second = FakeEventSource.latest();
    expect(second).not.toBe(first);
    expect(second.url).toBe(`${BASE}/events/stream?since_id=7`);
    second.open();
    expect(hub.transport).toBe("polling"); // not proven yet: keep polling

    second.emit("heartbeat", null);
    expect(hub.transport).toBe("sse");
    const polls = backend.requests.length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(backend.requests.length).toBe(polls);
  });

  it("falls back when an open stream stays silent (a buffering proxy)", async () => {
    const { hub, pollUrls } = setup({}, { silenceTimeoutMs: 35_000 });
    hub.subscribe("price_tick", () => {});
    await flush();
    const source = FakeEventSource.latest();
    source.open();
    await vi.advanceTimersByTimeAsync(20_000);
    source.emit("heartbeat", null);
    await vi.advanceTimersByTimeAsync(34_000);
    expect(hub.transport).toBe("sse");

    await vi.advanceTimersByTimeAsync(1000);

    expect(source.closed).toBe(true);
    expect(hub.transport).toBe("polling");
    expect(pollUrls()).toHaveLength(1);
  });

  it("falls back after repeated errors without an open", async () => {
    const { hub } = setup();
    hub.subscribe("alert", () => {});
    await flush();
    const source = FakeEventSource.latest();

    source.fail(0);
    source.fail(0);
    expect(hub.transport).toBe("connecting");
    source.fail(0);
    await flush();

    expect(hub.transport).toBe("polling");
    expect(source.closed).toBe(true);
  });

  it("backs off further each time SSE fails again", async () => {
    const { hub } = setup();
    hub.subscribe("alert", () => {});
    await flush();
    FakeEventSource.latest().fail(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.latest().fail(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("re-bootstraps the world when a poll gets 401 world_required", async () => {
    const { hub, refreshSession } = setup({
      "GET /events": sequence(worldRequired, () => json([tick(1)])),
    });
    const handler = vi.fn();
    hub.subscribe("price_tick", handler);
    await flush();
    FakeEventSource.latest().fail(2);
    await flush();

    expect(refreshSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("waits for Retry-After when polling is told to slow down", async () => {
    const { hub, pollUrls } = setup(
      {
        "GET /events": sequence(
          () =>
            json(
              { detail: "busy" },
              { status: 503, headers: { "Retry-After": "10" } },
            ),
          () => json([]),
        ),
      },
      { sseRetryDelaysMs: [60_000] },
    );
    hub.subscribe("alert", () => {});
    await flush();
    FakeEventSource.latest().fail(2);
    await flush();
    expect(pollUrls()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(pollUrls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7000);
    expect(pollUrls()).toHaveLength(2);
  });

  it("polls straight away when EventSource isn't available", async () => {
    const { hub, pollUrls } = setup({}, { createEventSource: null });
    hub.subscribe("alert", () => {});
    await flush();
    expect(hub.transport).toBe("polling");
    expect(pollUrls()).toEqual([""]);
  });

  it("stops polling and timers on close", async () => {
    const { hub, pollUrls } = setup();
    hub.subscribe("alert", () => {});
    await flush();
    FakeEventSource.latest().fail(2);
    await flush();

    hub.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(pollUrls()).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(hub.transport).toBe("idle");
  });
});
