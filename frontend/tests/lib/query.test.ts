import { describe, expect, it, vi } from "vitest";

import { QueryCache } from "@/lib/query";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const KEY = ["asset", "a1"] as const;

describe("QueryCache", () => {
  it("moves idle → loading → success and dedupes concurrent fetches", async () => {
    const cache = new QueryCache();
    const gate = deferred<string>();
    const fetcher = vi.fn(() => gate.promise);
    cache.subscribe(KEY, () => {});

    expect(cache.getState(KEY).status).toBe("idle");
    const first = cache.fetch(KEY, fetcher);
    const second = cache.fetch(KEY, fetcher);
    expect(cache.getState(KEY)).toMatchObject({
      status: "loading",
      isFetching: true,
    });

    gate.resolve("data");
    await Promise.all([first, second]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.getState(KEY)).toMatchObject({
      status: "success",
      data: "data",
      isFetching: false,
    });
  });

  it("stores failures as ApiError", async () => {
    const cache = new QueryCache();
    await cache.fetch(KEY, () => Promise.reject(new TypeError("offline")));
    expect(cache.getState(KEY)).toMatchObject({
      status: "error",
      error: { status: 0 },
    });
  });

  it("aborts the request when the last subscriber leaves, and refetches on return", async () => {
    const cache = new QueryCache();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<string>(() => {});
    });
    const unsubscribe = cache.subscribe(KEY, () => {});
    void cache.fetch(KEY, fetcher);

    unsubscribe();

    expect(signal?.aborted).toBe(true);
    expect(cache.getState(KEY)).toMatchObject({
      status: "idle",
      isFetching: false,
    });

    // React StrictMode remounts straight away: a fresh fetch must start.
    cache.subscribe(KEY, () => {});
    void cache.fetch(KEY, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.getState(KEY).status).toBe("loading");
  });

  it("keeps the old data while refetching", async () => {
    const cache = new QueryCache();
    cache.subscribe(KEY, () => {});
    await cache.fetch(KEY, async () => "v1");
    const gate = deferred<string>();
    void cache.fetch(KEY, () => gate.promise);
    expect(cache.getState(KEY)).toMatchObject({
      status: "success",
      data: "v1",
      isFetching: true,
    });
    gate.resolve("v2");
    await vi.waitFor(() => expect(cache.getState(KEY).data).toBe("v2"));
  });

  it("refetches watched queries on invalidate and drops unwatched ones", async () => {
    const cache = new QueryCache();
    const watched = vi.fn(async () => "w");
    const unwatched = vi.fn(async () => "u");
    cache.subscribe(["asset", "a1"], () => {});
    await cache.fetch(["asset", "a1"], watched);
    await cache.fetch(["asset", "a2"], unwatched);
    await cache.fetch(["portfolio"], unwatched);

    cache.invalidate(["asset"]);

    expect(watched).toHaveBeenCalledTimes(2);
    expect(cache.getState(["asset", "a2"]).status).toBe("idle");
    expect(cache.getState(["portfolio"]).status).toBe("success");
  });

  it("refetches once after invalidations that arrive during a fetch", async () => {
    const cache = new QueryCache();
    cache.subscribe(KEY, () => {});
    const gate = deferred<string>();
    const fetcher = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue("fresh");
    void cache.fetch(KEY, fetcher);

    cache.invalidate(KEY);
    cache.invalidate(KEY);
    gate.resolve("stale");

    await vi.waitFor(() => expect(cache.getState(KEY).data).toBe("fresh"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("patches cached data with setData and ignores missing entries", async () => {
    const cache = new QueryCache();
    const listener = vi.fn();
    cache.subscribe(KEY, listener);
    await cache.fetch(KEY, async () => ({ price: "1.00" }));

    cache.setData<{ price: string }>(KEY, (a) => a && { ...a, price: "2.00" });
    cache.setData(["asset", "missing"], () => ({ price: "9.99" }));

    expect(cache.getState(KEY).data).toEqual({ price: "2.00" });
    expect(cache.getState(["asset", "missing"]).data).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });
});
