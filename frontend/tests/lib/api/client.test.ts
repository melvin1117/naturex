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
  WORLD,
  worldRequired,
} from "../helpers";

const PORTFOLIO = {
  cash_balance: "100.00",
  holdings: [],
  impact: { hectares: "0", tonnes_co2e: "0", community_payouts: "0" },
};

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

  it("re-bootstraps and retries once after a 401 world_required", async () => {
    const { api, calls } = setup({
      "GET /portfolio": sequence(worldRequired, () => json(PORTFOLIO)),
    });

    const { data, error } = await api.GET("/portfolio");

    expect(error).toBeUndefined();
    expect(data).toEqual(PORTFOLIO);
    expect(calls("GET /world")).toBe(2);
    expect(calls("GET /portfolio")).toBe(2);
  });

  it("doesn't loop when the retry is also a 401", async () => {
    const { api, calls } = setup({ "GET /portfolio": worldRequired });

    await expect(unwrap(api.GET("/portfolio"))).rejects.toMatchObject({
      status: 401,
      code: "world_required",
    });
    expect(calls("GET /world")).toBe(2);
    expect(calls("GET /portfolio")).toBe(2);
  });

  it("re-bootstraps only once when several requests hit world_required together", async () => {
    const { api, calls } = setup({
      "GET /portfolio": sequence(worldRequired, () => json(PORTFOLIO)),
      "GET /assets": sequence(worldRequired, () => json([])),
    });

    await Promise.all([api.GET("/portfolio"), api.GET("/assets")]);

    expect(calls("GET /world")).toBe(2);
  });

  it("resends the same body when retrying a POST", async () => {
    const order = {
      asset_id: "33333333-3333-4333-8333-333333333333",
      side: "buy" as const,
      qty: 2,
    };
    const { api, requests } = setup({
      "POST /orders": sequence(worldRequired, async (request) =>
        json({ echoed: await request.json() }),
      ),
    });

    const { data } = await api.POST("/orders", { body: order });

    expect(data).toEqual({ echoed: order });
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    expect(await posts[1]!.json()).toEqual(order);
  });

  it("ignores other 401s", async () => {
    const { api, calls } = setup({
      "GET /portfolio": () =>
        json({ detail: "auth_required" }, { status: 401 }),
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
