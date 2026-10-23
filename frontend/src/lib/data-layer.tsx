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
import { SANDBOX_API_BASE } from "./sandbox";

export interface DataLayer {
  /** Where `api` sends requests: `/api`, or `/api/sandbox` for the visitor's sandbox. */
  baseUrl: string;
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
  reports: (assetId: string) => ["reports", assetId] as const,
  /** Two sealed reports never change, so a diff is never invalidated (T37). */
  reportDiff: (id: string, prev: string) => ["report-diff", id, prev] as const,
  ledger: (assetId: string) => ["ledger", assetId] as const,
  siteImages: (siteKey: string) => ["site-images", siteKey] as const,
  portfolio: () => ["portfolio"] as const,
  /** Every quote of one asset (a prefix, for invalidation). */
  quotes: (assetId: string) => ["quote", assetId] as const,
  quote: (assetId: string, side: "buy" | "sell", qty: number) =>
    ["quote", assetId, side, qty] as const,
  /** Per account: a sign-out or account switch never reuses another account's answer. */
  myCommunities: (meId: string | null) => ["me", meId, "communities"] as const,
  /** Every IPO preview of one asset (a prefix, for invalidation; T64). */
  ipoPreviews: (assetId: string) => ["ipo-preview", assetId] as const,
  ipoPreview: (assetId: string, totalShares: number, retainedPct: string) =>
    ["ipo-preview", assetId, totalShares, retainedPct] as const,
  /** Every query of one community (a prefix, for invalidation), T63. */
  community: (id: string) => ["community", id] as const,
  communityProfile: (id: string) => ["community", id, "profile"] as const,
  /** The Steward home (T63) and a community's members (T68). */
  communitySummary: (id: string) => ["community", id, "summary"] as const,
  communityMembers: (id: string) => ["community", id, "members"] as const,
  /** A rating run (`GET /runs/{id}`, T27). */
  run: (runId: string) => ["run", runId] as const,
  /** A run's Agent Trace (T34); under `run`, so a run's progress refetches it too. */
  runTrace: (runId: string) => ["run", runId, "trace"] as const,
  /** The world's latest logged model calls (`GET /admin/trace`), per account. */
  worldTrace: (meId: string | null) => ["world-trace", meId] as const,
  /** The AI control room (`GET /admin/ai-usage`): this world's model calls, per account. */
  aiUsage: (meId: string | null) => ["ai-usage", meId] as const,
  /** A demo site's recorded run (curated data: the same for every account). */
  recordedRun: (siteKey: string) => ["recorded-run", siteKey] as const,
  story: () => ["story"] as const,
  /** Public sites' simplified boundaries for the listing map (T33). */
  outlines: () => ["outlines"] as const,
  /** Every verification query of one listing (a prefix, for invalidation; T70). */
  verification: (assetId: string) => ["verification", assetId] as const,
  verificationPanel: (assetId: string) =>
    ["verification", assetId, "panel"] as const,
  verificationRuns: (assetId: string) =>
    ["verification", assetId, "runs"] as const,
  verificationDocuments: (assetId: string) =>
    ["verification", assetId, "documents"] as const,
  /** Its own prefix: a decision refetches the run, never the (unchanged) preview images. */
  documentPreview: (assetId: string, documentId: string) =>
    ["document-preview", assetId, documentId] as const,
  /** Every field evidence query of one listing (a prefix, for invalidation; T40). */
  fieldEvidence: (assetId: string) => ["field-evidence", assetId] as const,
  fieldEvidencePhotos: (assetId: string) =>
    ["field-evidence", assetId, "photos"] as const,
  fieldEvidenceSummary: (assetId: string) =>
    ["field-evidence", assetId, "summary"] as const,
  /** Its own prefix: a re-encoded photo never changes, so it's never refetched on a change. */
  fieldPhotoImage: (assetId: string, photoId: string) =>
    ["field-photo-image", assetId, photoId] as const,
  /** Every page of the reviewer queue, for every account (a prefix, for invalidation). */
  reviewQueueAll: () => ["review-queue"] as const,
  /** One page of the reviewer queue, per account. */
  reviewQueue: (meId: string | null, offset: number) =>
    ["review-queue", meId, offset] as const,
  /** One page of decided listings (#211), per account and level ("all" for every level). */
  decidedVerifications: (meId: string | null, level: string, offset: number) =>
    ["review-queue", meId, "decided", level, offset] as const,
  /** One listing's queue item, with its AI suggestion (T71). */
  reviewQueueItem: (meId: string | null, assetId: string) =>
    ["review-queue", meId, "asset", assetId] as const,
  /** The signed-in account's alerts (T75); `alertsAll` is the prefix for invalidation. */
  alertsAll: () => ["alerts"] as const,
  alerts: (
    meId: string | null,
    communityId: string | null,
    before: string | null,
  ) => ["alerts", meId, communityId, before] as const,
  /** The admin's Time Machine state (T43). */
  timeMachine: (meId: string | null) => ["time-machine", meId] as const,
  /** A Time Machine quarter job (#201). */
  quarterJob: (id: string) => ["quarter-job", id] as const,
  /** Alerts a Time Machine quarter or event sent (T43). */
  sentAlerts: (ids: readonly string[]) => ["sent-alerts", ...ids] as const,
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
    baseUrl,
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
let sandboxLayer: DataLayer | undefined;

/** The sandbox's layer (`/api/sandbox`, the API's sandbox channel): one per tab, so the demo
 * session `POST /demo/start` set is already known when the visitor lands in `/sandbox`. */
export function getSandboxDataLayer(): DataLayer {
  if (!isBrowser()) return createDataLayer({ baseUrl: SANDBOX_API_BASE });
  sandboxLayer ??= createDataLayer({ baseUrl: SANDBOX_API_BASE });
  return sandboxLayer;
}

/** The tab-wide layer: shares `api` and `browserSession` with non-React code. */
export function getBrowserDataLayer(): DataLayer {
  browserLayer ??= {
    baseUrl: "/api",
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
 * % change, history, quotes) are then refetched, coalesced so a burst of ticks costs one request
 * per query. A finished rating run refetches the asset's reports, ledger and prices.
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
      queue(queryKeys.quotes(payload.asset_id));
      // A re-rate comes with a new report version and its ledger entry.
      if (payload.reason === "rerate") {
        queue(queryKeys.reports(payload.asset_id));
        queue(queryKeys.ledger(payload.asset_id));
      }
      // A launch makes a listing public, so it joins the public outlines.
      if (payload.reason === "ipo") queue(queryKeys.outlines());
    },
    { retain: false },
  );
  // A rating run's final event (step "done": succeeded, degraded or failed) means a new
  // report, its ledger entry and possibly a re-anchored price. Replays just refetch again.
  const unsubscribeRuns = events.subscribe(
    "rating_progress",
    ({ payload }) => {
      const assetId = payload.asset_id;
      if (payload.step !== "done" || typeof assetId !== "string") return;
      queue(queryKeys.asset(assetId));
      queue(queryKeys.reports(assetId));
      queue(queryKeys.ledger(assetId));
      queue(queryKeys.prices(assetId));
      queue(queryKeys.assets());
      queue(queryKeys.ipoPreviews(assetId));
    },
    { retain: false },
  );
  // Every progress event of a run refetches it (T33's live pipeline: duplicates and replays
  // only cost a coalesced refetch); a listing's status change (T58) refetches the listing and
  // its ledger, which records the transition.
  const unsubscribeRunSteps = events.subscribe(
    "rating_progress",
    ({ payload }) => {
      if (typeof payload.run_id === "string")
        queue(queryKeys.run(payload.run_id));
    },
    { retain: false },
  );
  const unsubscribeListings = events.subscribe(
    "listing_status",
    ({ payload }) => {
      queue(queryKeys.asset(payload.asset_id));
      queue(queryKeys.ledger(payload.asset_id));
      // A verification decision (#216) can open or close the opening offer.
      queue(queryKeys.ipoPreviews(payload.asset_id));
    },
    { retain: false },
  );
  // An alert (T75) reaches only its holders and community, so it's always about this account.
  const unsubscribeAlerts = events.subscribe(
    "alert",
    () => queue(queryKeys.alertsAll()),
    { retain: false },
  );
  return () => {
    unsubscribe();
    unsubscribeRuns();
    unsubscribeRunSteps();
    unsubscribeListings();
    unsubscribeAlerts();
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
  // too, not only a different world. Reset, not invalidate: the previous account's data must
  // not stay on screen while the new answers load.
  useEffect(() => {
    let viewer = viewerKey(layer.session.getSnapshot().world);
    return layer.session.subscribe(() => {
      const next = viewerKey(layer.session.getSnapshot().world);
      if (viewer && next && next !== viewer) layer.cache.reset();
      viewer = next ?? viewer;
    });
  }, [layer]);

  return (
    <DataLayerContext.Provider value={layer}>
      {children}
    </DataLayerContext.Provider>
  );
}

/** The layer if one is provided, else null (for code that also runs without one). */
export function useOptionalDataLayer(): DataLayer | null {
  return useContext(DataLayerContext);
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
