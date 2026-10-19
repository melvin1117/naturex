"use client";

/**
 * The React side of the data layer: one `DataLayer` (API client, world bootstrap, query
 * cache, live events) per browser tab, provided by `<DataLayerProvider>`. Screens don't use
 * this directly; they use the hooks in ./hooks.ts. Tests pass their own `createDataLayer()`.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  api as browserApi,
  browserSession,
  createApi,
  createBrowserSession,
  isBrowser,
  type ApiClient,
  type FetchFn,
} from "./api/client";
import type { AssetDetail } from "./api/types";
import { EventHub, type EventHubOptions } from "./events";
import { hashKey, QueryCache, type QueryKey } from "./query";
import type { SessionBootstrap, World } from "./session";

export interface DataLayer {
  api: ApiClient;
  session: SessionBootstrap;
  cache: QueryCache;
  events: EventHub;
}

/** Cache keys shared by hooks, mutations and live events. */
export const queryKeys = {
  assets: () => ["assets"] as const,
  asset: (id: string) => ["asset", id] as const,
  prices: (assetId: string) => ["prices", assetId] as const,
  report: (id: string) => ["report", id] as const,
  portfolio: () => ["portfolio"] as const,
};

export interface CreateDataLayerOptions {
  baseUrl?: string;
  fetch?: FetchFn;
  createEventSource?: EventHubOptions["createEventSource"];
  pollIntervalMs?: number;
}

export function createDataLayer(
  options: CreateDataLayerOptions = {},
): DataLayer {
  const baseUrl = options.baseUrl ?? "/api";
  const session = createBrowserSession(baseUrl, options.fetch);
  const fetch = options.fetch;
  return {
    api: createApi({ baseUrl, fetch, session }),
    session,
    cache: new QueryCache(),
    events: new EventHub({
      baseUrl,
      createEventSource: options.createEventSource,
      fetch: fetch && ((url, init) => fetch(new Request(url, init))),
      ensureSession: () => session.ensure(),
      refreshSession: () => session.refresh(),
      pollIntervalMs: options.pollIntervalMs,
    }),
  };
}

let browserLayer: DataLayer | undefined;

/** The tab-wide layer: shares `api` and `browserSession` with non-React code. */
export function getBrowserDataLayer(): DataLayer {
  browserLayer ??= {
    api: browserApi,
    session: browserSession,
    cache: new QueryCache(),
    events: new EventHub({
      ensureSession: () => browserSession.ensure(),
      refreshSession: () => browserSession.refresh(),
    }),
  };
  return browserLayer;
}

/**
 * Keep caches in step with live events. The asset's price is patched at once from the event
 * payload (the backend's number); the asset and everything derived from the price (P&L,
 * % change, history) are then refetched, coalesced so a burst of ticks costs one request
 * per query.
 */
export function wireLiveUpdates(cache: QueryCache, events: EventHub) {
  const queued = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue = (key: QueryKey) => {
    queued.set(hashKey(key), key);
    timer ??= setTimeout(() => {
      timer = null;
      const keys = [...queued.values()];
      queued.clear();
      keys.forEach((k) => cache.invalidate(k));
    }, 50);
  };
  const unsubscribe = events.subscribe(
    "price_tick",
    ({ payload }) => {
      cache.setData<AssetDetail>(queryKeys.asset(payload.asset_id), (asset) =>
        asset ? { ...asset, price: payload.price } : asset,
      );
      // Also refetch the asset itself: derived fields (primary float, wallet) move with the
      // trade, and a fetch already in flight may otherwise overwrite the patched price.
      queue(queryKeys.asset(payload.asset_id));
      queue(queryKeys.assets());
      queue(queryKeys.portfolio());
      queue(queryKeys.prices(payload.asset_id));
    },
    { retain: false },
  );
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

const DataLayerContext = createContext<DataLayer | null>(null);

/** Who the cache answers for: the world plus the signed-in account (or anonymous). */
export function viewerKey(world: World | null): string | null {
  return world ? `${world.id}:${world.me?.id ?? "anonymous"}` : null;
}

export function DataLayerProvider({
  value,
  children,
}: {
  value?: DataLayer;
  children: ReactNode;
}) {
  const [layer] = useState<DataLayer>(
    () => value ?? (isBrowser() ? getBrowserDataLayer() : createDataLayer()),
  );

  useEffect(() => wireLiveUpdates(layer.cache, layer.events), [layer]);

  // Cached answers belong to one (world, account) pair: the live world is shared by anonymous
  // visitors and every account, so signing in or out (or a session ending) makes them wrong
  // too, not only a different world.
  useEffect(() => {
    let viewer = viewerKey(layer.session.getSnapshot().world);
    return layer.session.subscribe(() => {
      const next = viewerKey(layer.session.getSnapshot().world);
      if (viewer && next && next !== viewer) layer.cache.invalidate();
      viewer = next ?? viewer;
    });
  }, [layer]);

  return (
    <DataLayerContext.Provider value={layer}>
      {children}
    </DataLayerContext.Provider>
  );
}

export function useDataLayer(): DataLayer {
  const layer = useContext(DataLayerContext);
  if (!layer) {
    throw new Error(
      "NatureX data hooks need <WorldProvider> (app/layout.tsx) or <DataLayerProvider>.",
    );
  }
  return layer;
}
