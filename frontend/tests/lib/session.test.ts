import { describe, expect, it, vi } from "vitest";

import {
  createSessionBootstrap,
  forwardedCookieHeader,
  isSessionExpired,
  type CookieReader,
} from "@/lib/session";

import { SIGNED_IN_WORLD, WORLD } from "./helpers";

const store = (values: Record<string, string>): CookieReader => ({
  get: (name) => (name in values ? { value: values[name]! } : undefined),
});

describe("forwardedCookieHeader", () => {
  it("forwards only the session cookie", () => {
    expect(
      forwardedCookieHeader(
        store({ ww_session: "s-1", theme: "dark", _ga: "tracking" }),
      ),
    ).toBe("ww_session=s-1");
  });

  it("never forwards the retired nx_world cookie (T73)", () => {
    expect(forwardedCookieHeader(store({ nx_world: "w-1" }))).toBeUndefined();
  });

  it("returns undefined without session cookies", () => {
    expect(forwardedCookieHeader(store({ theme: "dark" }))).toBeUndefined();
  });
});

describe("isSessionExpired", () => {
  it("is true only for 401 auth_required", () => {
    expect(isSessionExpired(401, { detail: "auth_required" })).toBe(true);
    expect(isSessionExpired(401, { detail: "world_required" })).toBe(false);
    expect(isSessionExpired(403, { detail: "auth_required" })).toBe(false);
    expect(isSessionExpired(401, null)).toBe(false);
  });
});

describe("createSessionBootstrap", () => {
  it("is single-flight and caches the world", async () => {
    const load = vi.fn().mockResolvedValue(WORLD);
    const session = createSessionBootstrap(load);

    await Promise.all([session.ensure(), session.ensure()]);
    await session.ensure();

    expect(load).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({
      status: "ready",
      world: WORLD,
    });
    expect(session.generation).toBe(1);
  });

  it("reports loading, then error, and retries after a failure", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(WORLD);
    const session = createSessionBootstrap(load);
    const statuses: string[] = [];
    session.subscribe(() => statuses.push(session.getSnapshot().status));

    await expect(session.ensure()).rejects.toMatchObject({ status: 0 });
    await session.ensure();

    expect(statuses).toEqual(["loading", "error", "loading", "ready"]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("skips a refresh another caller already made", async () => {
    const load = vi.fn().mockResolvedValue(WORLD);
    const session = createSessionBootstrap(load);
    await session.ensure();
    const sentUnder = session.generation;

    await Promise.all([session.refresh(sentUnder), session.refresh(sentUnder)]);
    await session.refresh(sentUnder);

    expect(load).toHaveBeenCalledTimes(2);
    expect(session.generation).toBe(2);
  });

  it("stays ready with the old world when a refresh fails", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(WORLD)
      .mockRejectedValueOnce(new TypeError("offline"));
    const session = createSessionBootstrap(load);
    await session.ensure();

    await expect(session.refresh()).rejects.toMatchObject({ status: 0 });
    expect(session.getSnapshot()).toMatchObject({
      status: "ready",
      world: WORLD,
    });
  });
});

describe("reload (T61: after sign-in, sign-up or sign-out)", () => {
  it("never reuses a request sent with the old cookie", async () => {
    let resolveStale!: (world: typeof WORLD) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<typeof WORLD>((r) => (resolveStale = r)),
      )
      .mockResolvedValueOnce(SIGNED_IN_WORLD);
    const session = createSessionBootstrap(load);

    const stale = session.ensure();
    const fresh = session.reload();
    resolveStale(WORLD);
    await stale;

    await expect(fresh).resolves.toEqual(SIGNED_IN_WORLD);
    expect(load).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().world?.me?.name).toBe("Rosa");
  });

  it("still reloads when the stale request failed", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(WORLD);
    const session = createSessionBootstrap(load);

    const stale = session.ensure().catch(() => undefined);
    await expect(session.reload()).resolves.toEqual(WORLD);
    await stale;
    expect(load).toHaveBeenCalledTimes(2);
  });
});
