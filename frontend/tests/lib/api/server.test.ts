import { afterEach, describe, expect, it, vi } from "vitest";

import { BASE, fakeBackend, json } from "../helpers";

const cookieValues: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name in cookieValues ? { name, value: cookieValues[name] } : undefined,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of Object.keys(cookieValues)) delete cookieValues[key];
});

describe("createServerApi", () => {
  it("calls BACKEND_URL directly and forwards only the visitor's world cookie", async () => {
    vi.stubEnv("BACKEND_URL", BASE);
    Object.assign(cookieValues, { nx_world: "w-123", other: "secret" });
    const backend = fakeBackend({ "GET /portfolio": () => json({ ok: true }) });
    const { createServerApi } = await import("@/lib/api/server");

    const api = await createServerApi({ fetch: backend.fetch });
    const { data } = await api.GET("/portfolio");

    expect(data).toEqual({ ok: true });
    const [request] = backend.requests;
    expect(request!.url).toBe(`${BASE}/portfolio`);
    expect(request!.headers.get("cookie")).toBe("nx_world=w-123");
    expect(backend.calls("GET /world")).toBe(0);
  });

  it("doesn't bootstrap or retry on the server", async () => {
    vi.stubEnv("BACKEND_URL", BASE);
    const backend = fakeBackend({
      "GET /portfolio": () =>
        json({ detail: "world_required" }, { status: 401 }),
    });
    const { createServerApi } = await import("@/lib/api/server");

    const api = await createServerApi({ fetch: backend.fetch });
    const { response } = await api.GET("/portfolio");

    expect(response.status).toBe(401);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]!.headers.get("cookie")).toBeNull();
  });
});

describe("forwardedHeaders", () => {
  it("is empty without session cookies", async () => {
    const { forwardedHeaders } = await import("@/lib/api/server");
    expect(forwardedHeaders({ get: () => undefined })).toEqual({});
  });
});
