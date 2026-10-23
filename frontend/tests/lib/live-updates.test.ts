import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { unwrap } from "@/lib/api/errors";
import { createDataLayer, queryKeys, wireLiveUpdates } from "@/lib/data-layer";

import {
  BASE,
  createFakeEventSource,
  fakeBackend,
  FakeEventSource,
  json,
  WORLD,
} from "./helpers";

const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";

/** A data layer whose asset, reports, ledger and prices queries are being watched. */
function setup() {
  const backend = fakeBackend({
    "GET /world": () => json(WORLD),
    [`GET /assets/${ASSET_ID}`]: () => json({ id: ASSET_ID, price: "10.00" }),
    [`GET /assets/${ASSET_ID}/reports`]: () => json([]),
    [`GET /ledger/${ASSET_ID}`]: () => json([]),
    [`GET /assets/${ASSET_ID}/prices`]: () => json([]),
  });
  const layer = createDataLayer({
    baseUrl: BASE,
    fetch: backend.fetch,
    createEventSource: createFakeEventSource,
  });
  const unwire = wireLiveUpdates(layer.cache, layer.events);
  const release = layer.events.retain();
  const watch = (key: readonly string[], path: string) => {
    layer.cache.subscribe(key, () => {});
    void layer.cache.fetch(key, (signal) =>
      unwrap(
        layer.api.GET(path as "/assets/{asset_id}", {
          params: { path: { asset_id: ASSET_ID } },
          signal,
        }),
      ),
    );
  };
  watch(queryKeys.asset(ASSET_ID), "/assets/{asset_id}");
  watch(queryKeys.reports(ASSET_ID), "/assets/{asset_id}/reports");
  watch(queryKeys.ledger(ASSET_ID), "/ledger/{asset_id}");
  watch(queryKeys.prices(ASSET_ID), "/assets/{asset_id}/prices");
  const counts = () => [
    backend.calls(`GET /assets/${ASSET_ID}`),
    backend.calls(`GET /assets/${ASSET_ID}/reports`),
    backend.calls(`GET /ledger/${ASSET_ID}`),
    backend.calls(`GET /assets/${ASSET_ID}/prices`),
  ];
  return { counts, cleanup: () => (unwire(), release()) };
}

beforeEach(() => FakeEventSource.reset());

describe("wireLiveUpdates", () => {
  it("refetches the asset, reports, ledger and prices when a rating run ends", async () => {
    const { counts, cleanup } = setup();
    await waitFor(() => expect(counts()).toEqual([1, 1, 1, 1]));
    const source = FakeEventSource.latest();
    act(() => source.open());

    act(() => {
      // Progress steps and other assets' runs change nothing here.
      source.emit("rating_progress", 1, {
        asset_id: ASSET_ID,
        step: "earth_obs",
        status: "ok",
      });
      source.emit("rating_progress", 2, {
        asset_id: OTHER_ID,
        step: "done",
        status: "succeeded",
      });
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(counts()).toEqual([1, 1, 1, 1]);

    act(() =>
      source.emit("rating_progress", 3, {
        asset_id: ASSET_ID,
        step: "done",
        status: "failed",
      }),
    );
    await waitFor(() => expect(counts()).toEqual([2, 2, 2, 2]));
    cleanup();
  });

  it("refetches reports and the ledger on a re-rate tick, not on an order", async () => {
    const { counts, cleanup } = setup();
    await waitFor(() => expect(counts()).toEqual([1, 1, 1, 1]));
    const source = FakeEventSource.latest();
    act(() => source.open());

    act(() =>
      source.emit("price_tick", 1, {
        asset_id: ASSET_ID,
        price: "10.10",
        reason: "order",
      }),
    );
    await waitFor(() => expect(counts()).toEqual([2, 1, 1, 2]));

    act(() =>
      source.emit("price_tick", 2, {
        asset_id: ASSET_ID,
        price: "11.00",
        reason: "rerate",
      }),
    );
    await waitFor(() => expect(counts()).toEqual([3, 2, 2, 3]));
    cleanup();
  });

  it("refetches the asset's IPO previews when its rating run ends (T64)", async () => {
    let fetched = 0;
    const layer = createDataLayer({
      baseUrl: BASE,
      fetch: fakeBackend({ "GET /world": () => json(WORLD) }).fetch,
      createEventSource: createFakeEventSource,
    });
    const unwire = wireLiveUpdates(layer.cache, layer.events);
    const release = layer.events.retain();
    const watch = (assetId: string) => {
      const key = queryKeys.ipoPreview(assetId, 1_000_000, "51");
      layer.cache.subscribe(key, () => {});
      void layer.cache.fetch(
        key,
        async () => (fetched += assetId === ASSET_ID ? 1 : 0),
      );
    };
    watch(ASSET_ID);
    watch(OTHER_ID);
    await waitFor(() => expect(fetched).toBe(1));
    const source = FakeEventSource.latest();
    act(() => source.open());

    act(() =>
      source.emit("rating_progress", 1, {
        asset_id: ASSET_ID,
        step: "done",
        status: "succeeded",
      }),
    );
    await waitFor(() => expect(fetched).toBe(2));
    unwire();
    release();
  });
  it("refetches a run on its progress events, a listing on its status and the outlines on a launch (T33)", async () => {
    const RUN_ID = "88888888-8888-4888-8888-888888888888";
    const backend = fakeBackend({
      "GET /world": () => json(WORLD),
      [`GET /runs/${RUN_ID}`]: () => json({ run_id: RUN_ID }),
      [`GET /assets/${ASSET_ID}`]: () => json({ id: ASSET_ID }),
      [`GET /ledger/${ASSET_ID}`]: () => json([]),
      "GET /assets/outlines": () => json({ outlines: [], truncated: false }),
    });
    const layer = createDataLayer({
      baseUrl: BASE,
      fetch: backend.fetch,
      createEventSource: createFakeEventSource,
    });
    const unwire = wireLiveUpdates(layer.cache, layer.events);
    const release = layer.events.retain();
    const watch = (key: readonly string[], path: string) => {
      layer.cache.subscribe(key, () => {});
      void layer.cache.fetch(key, () =>
        layer.api.GET(path as "/world").then(({ data }) => data),
      );
    };
    watch(queryKeys.run(RUN_ID), `/runs/${RUN_ID}`);
    watch(queryKeys.asset(ASSET_ID), `/assets/${ASSET_ID}`);
    watch(queryKeys.ledger(ASSET_ID), `/ledger/${ASSET_ID}`);
    watch(queryKeys.outlines(), "/assets/outlines");
    const counts = () => [
      backend.calls(`GET /runs/${RUN_ID}`),
      backend.calls(`GET /assets/${ASSET_ID}`),
      backend.calls(`GET /ledger/${ASSET_ID}`),
      backend.calls("GET /assets/outlines"),
    ];
    await waitFor(() => expect(counts()).toEqual([1, 1, 1, 1]));
    const source = FakeEventSource.latest();
    act(() => source.open());

    act(() => {
      // A burst of steps (a duplicate too) costs one coalesced refetch.
      source.emit("rating_progress", 1, { run_id: RUN_ID, step: "started" });
      source.emit("rating_progress", 2, { run_id: RUN_ID, step: "earth_obs" });
      source.emit("rating_progress", 2, { run_id: RUN_ID, step: "earth_obs" });
    });
    await waitFor(() => expect(counts()).toEqual([2, 1, 1, 1]));

    act(() =>
      source.emit("listing_status", 3, {
        asset_id: ASSET_ID,
        transition: "submit",
        from: "draft",
        to: "rating",
      }),
    );
    await waitFor(() => expect(counts()).toEqual([2, 2, 2, 1]));

    act(() =>
      source.emit("listing_status", 4, {
        asset_id: ASSET_ID,
        transition: "rated",
        from: "rating",
        to: "listed",
      }),
    );
    // Listed isn't public yet: the outlines wait for the launch.
    await waitFor(() => expect(counts()).toEqual([2, 3, 3, 1]));

    act(() =>
      source.emit("price_tick", 5, {
        asset_id: ASSET_ID,
        price: "1.00",
        reason: "ipo",
      }),
    );
    await waitFor(() => expect(counts()).toEqual([2, 4, 3, 2]));
    unwire();
    release();
  });
});
