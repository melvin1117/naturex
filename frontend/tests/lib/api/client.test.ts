import { describe, expect, it } from "vitest";

import {
  createApi,
  createBrowserSession,
  defaultBaseUrl,
} from "@/lib/api/client";
import { unwrap } from "@/lib/api/errors";

import {
  BASE,
  fakeBackend,
  json,
  sequence,
  SIGNED_IN_WORLD,
  WORLD,
  authRequired,
} from "../helpers";

const PORTFOLIO = {
  cash_balance: "100.00",
  holdings: [],
  impact: { hectares: "0", tonnes_co2e: "0", community_payouts: "0" },
};

/** Signed in for the first GET /world, signed out (session ended) on every later one. */
function signedInSetup(routes: Parameters<typeof fakeBackend>[0]) {
  return setup({
    "GET /world": sequence(
      () => json(SIGNED_IN_WORLD),
      () => json(WORLD),
    ),
    ...routes,
  });
}

function setup(routes: Parameters<typeof fakeBackend>[0]) {
  const backend = fakeBackend({ "GET /world": () => json(WORLD), ...routes });
  const session = createBrowserSession(BASE, backend.fetch);
  const api = createApi({ baseUrl: BASE, fetch: backend.fetch, session });
  return { ...backend, session, api };
}

describe("api client", () => {
  it("creates a client with the default or a custom base URL", () => {
    expect(typeof createApi().GET).toBe("function");
    expect(typeof createApi("http://example.test").POST).toBe("function");
  });

  it("uses the same-origin /api proxy in the browser, so the sandbox cookie is sent", () => {
    expect(typeof window).toBe("object");
    expect(defaultBaseUrl()).toBe("/api");
  });
});

describe("world bootstrap middleware", () => {
  it("calls GET /world once, before anything else, for concurrent first requests", async () => {
    const { api, calls, requests } = setup({
      "GET /portfolio": () => json(PORTFOLIO),
      "GET /assets": () => json([]),
    });

    const [portfolio, assets] = await Promise.all([
      api.GET("/portfolio"),
      api.GET("/assets"),
    ]);

    expect(portfolio.data).toEqual(PORTFOLIO);
    expect(assets.data).toEqual([]);
    expect(calls("GET /world")).toBe(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/world");

    await api.GET("/assets");
    expect(calls("GET /world")).toBe(1);
  });

  it("doesn't bootstrap twice when a screen asks for GET /world itself", async () => {
    const { api, calls } = setup({});
    const { data } = await api.GET("/world");
    expect(data).toEqual(WORLD);
    expect(calls("GET /world")).toBe(1);
  });

  it("re-reads the world and retries a GET once after a signed-in 401 auth_required", async () => {
    const { api, calls } = signedInSetup({
      "GET /portfolio": sequence(authRequired, () => json(PORTFOLIO)),
    });

    const { data, error } = await api.GET("/portfolio");

    expect(error).toBeUndefined();
    expect(data).toEqual(PORTFOLIO);
    expect(calls("GET /world")).toBe(2);
    expect(calls("GET /portfolio")).toBe(2);
  });

  it("doesn't loop when the retry is also a 401", async () => {
    const { api, calls } = signedInSetup({ "GET /portfolio": authRequired });

    await expect(unwrap(api.GET("/portfolio"))).rejects.toMatchObject({
      status: 401,
      code: "auth_required",
    });
    expect(calls("GET /world")).toBe(2);
    expect(calls("GET /portfolio")).toBe(2);
  });

  it("re-reads the world only once when several requests hit auth_required together", async () => {
    const { api, calls } = signedInSetup({
      "GET /portfolio": sequence(authRequired, () => json(PORTFOLIO)),
      "GET /assets": sequence(authRequired, () => json([])),
    });

    await Promise.all([api.GET("/portfolio"), api.GET("/assets")]);

    expect(calls("GET /world")).toBe(2);
  });

  it("never replays a POST: it re-reads the world and returns the 401", async () => {
    const order = {
      asset_id: "33333333-3333-4333-8333-333333333333",
      side: "buy" as const,
      qty: 2,
    };
    const { api, calls, session } = signedInSetup({
      "POST /orders": sequence(authRequired, () => json({ placed: true })),
    });

    await expect(
      unwrap(api.POST("/orders", { body: order })),
    ).rejects.toMatchObject({ status: 401, code: "auth_required" });

    expect(calls("POST /orders")).toBe(1);
    expect(calls("GET /world")).toBe(2);
    expect(session.getSnapshot().world?.me).toBeNull();
  });

  it("an anonymous 401 is returned at once: no world re-read, no retry", async () => {
    const { api, calls } = setup({
      "GET /portfolio": authRequired,
      "POST /orders": authRequired,
    });

    const portfolio = await api.GET("/portfolio");
    const order = await api.POST("/orders", {
      body: { asset_id: WORLD.id, side: "buy", qty: 1 },
    });

    expect([portfolio.response.status, order.response.status]).toEqual([
      401, 401,
    ]);
    expect(calls("GET /world")).toBe(1);
    expect(calls("GET /portfolio")).toBe(1);
    expect(calls("POST /orders")).toBe(1);
  });

  it("ignores other 401s", async () => {
    const { api, calls } = setup({
      "GET /portfolio": () =>
        json({ detail: "invalid_token" }, { status: 401 }),
    });
    await api.GET("/portfolio");
    expect(calls("GET /world")).toBe(1);
    expect(calls("GET /portfolio")).toBe(1);
  });

  it("fails the request with the bootstrap's error when GET /world fails", async () => {
    const { api, calls } = setup({
      "GET /world": () =>
        json(
          { detail: "The demo is busy; try again in a few minutes" },
          { status: 503, headers: { "Retry-After": "300" } },
        ),
    });

    await expect(api.GET("/portfolio")).rejects.toMatchObject({
      status: 503,
      retryAfterSeconds: 300,
    });
    expect(calls("GET /portfolio")).toBe(0);
  });
});
