/**
 * Data hooks for client components. Screens stay presentational: they get
 * `{ data, error, status, isLoading, isFetching, refetch }` from queries and
 * `{ mutate, isPending, error, data }` from mutations, with every error an `ApiError` whose
 * `message` is safe to show. See ./README.md.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { forgetCommunity } from "./active-community";
import type { ApiClient } from "./api/client";
import { toApiError, unwrap, type ApiError } from "./api/errors";
import type {
  AiUsage,
  AlertList,
  AlertOut,
  AlertsMarked,
  AssetCard,
  AssetCreate,
  AssetDetail,
  AssetOutlines,
  AssetSubmitted,
  AssetUpdate,
  IpoLaunch,
  IpoOut,
  IpoPreview,
  LedgerEntry,
  LedgerVerify,
  LoginIn,
  MeOut,
  MyCommunity,
  OrderCreate,
  OrderOut,
  PlaceSearchOut,
  PortfolioOut,
  PricePoint,
  QuoteOut,
  DemoPersona,
  RatingRun,
  RatingRunAccepted,
  RecordedRun,
  RegisterIn,
  ReportDiff,
  RunTrace,
  ReportOut,
  SiteImages,
  Story,
  WorldOut,
  WorldTrace,
} from "./api/types";
import {
  queryKeys,
  useDataLayer,
  viewerKey,
  type DataLayer,
} from "./data-layer";
import { DEMO_SITES } from "./demo-site-images";
import type { LiveEventHandler, LiveEventType, Transport } from "./events";
import {
  hashKey,
  IDLE_QUERY,
  type QueryKey,
  type QueryState,
  type QueryStatus,
} from "./query";
import type { SessionState } from "./session";

export interface QueryResult<T> extends QueryState<T> {
  isLoading: boolean;
  refetch: () => Promise<void>;
}

/** Keep the latest callback without re-running effects when it changes. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Any typed GET, cached under `key`. Refetches on mount (showing cached data meanwhile),
 * dedupes concurrent fetches of the same key and aborts when the last user unmounts.
 *
 * @example useApiQuery(["prices", id], (api, signal) =>
 *   unwrap(api.GET("/assets/{asset_id}/prices", { params: { path: { asset_id: id } }, signal })))
 */
export function useApiQuery<T>(
  key: QueryKey,
  fetcher: (api: ApiClient, signal: AbortSignal) => Promise<T>,
  { enabled = true }: { enabled?: boolean } = {},
): QueryResult<T> {
  const { api, cache } = useDataLayer();
  const hash = hashKey(key);
  const stableKey = useMemo(() => JSON.parse(hash) as QueryKey, [hash]);
  const fetcherRef = useLatest(fetcher);

  const subscribe = useCallback(
    (listener: () => void) => cache.subscribe(stableKey, listener),
    [cache, stableKey],
  );
  const getSnapshot = useCallback(
    () => cache.getState<T>(stableKey),
    [cache, stableKey],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, () => IDLE_QUERY);

  const refetch = useCallback(
    () => cache.fetch(stableKey, (signal) => fetcherRef.current(api, signal)),
    [api, cache, stableKey, fetcherRef],
  );

  useEffect(() => {
    if (enabled) void refetch();
  }, [enabled, refetch]);

  return { ...state, isLoading: state.status === "loading", refetch };
}

export type MutationStatus = "idle" | "pending" | "success" | "error";

export interface MutationResult<TVars, TData> {
  status: MutationStatus;
  data: TData | undefined;
  error: ApiError | null;
  isPending: boolean;
  /** Never rejects: on failure it resolves `undefined` and sets `error`. */
  mutate: (vars: TVars) => Promise<TData | undefined>;
  /** Rejects with an `ApiError` on failure. */
  mutateAsync: (vars: TVars) => Promise<TData>;
  reset: () => void;
}

type MutationState<TData> = {
  status: MutationStatus;
  data: TData | undefined;
  error: ApiError | null;
};

/** Any typed POST; `onSuccess` invalidates or patches whatever the change affects. */
export function useApiMutation<TVars, TData>(
  mutationFn: (api: ApiClient, vars: TVars) => Promise<TData>,
  options: {
    onSuccess?: (data: TData, vars: TVars, layer: DataLayer) => void;
  } = {},
): MutationResult<TVars, TData> {
  const layer = useDataLayer();
  const fnRef = useLatest(mutationFn);
  const onSuccessRef = useLatest(options.onSuccess);
  const mounted = useRef(true);
  const [state, setState] = useState<MutationState<TData>>({
    status: "idle",
    data: undefined,
    error: null,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((next: MutationState<TData>) => {
    if (mounted.current) setState(next);
  }, []);

  const mutateAsync = useCallback(
    async (vars: TVars) => {
      update({ status: "pending", data: undefined, error: null });
      try {
        const data = await fnRef.current(layer.api, vars);
        onSuccessRef.current?.(data, vars, layer);
        update({ status: "success", data, error: null });
        return data;
      } catch (error) {
        const apiError = toApiError(error);
        update({ status: "error", data: undefined, error: apiError });
        throw apiError;
      }
    },
    [layer, fnRef, onSuccessRef, update],
  );

  const mutate = useCallback(
    (vars: TVars) => mutateAsync(vars).catch(() => undefined),
    [mutateAsync],
  );

  const reset = useCallback(
    () => update({ status: "idle", data: undefined, error: null }),
    [update],
  );

  return {
    ...state,
    isPending: state.status === "pending",
    mutate,
    mutateAsync,
    reset,
  };
}

/** Keep the live-event connection open while the calling component is mounted. */
function useLiveConnection(enabled = true) {
  const { events } = useDataLayer();
  useEffect(() => (enabled ? events.retain() : undefined), [events, enabled]);
}

/**
 * Live events, transport hidden. `subscribe(type, handler)` returns its unsubscribe;
 * `transport` is for diagnostics only ("sse" or "polling" look the same to screens).
 */
export function useEvents(): {
  subscribe: <K extends LiveEventType>(
    type: K,
    handler: LiveEventHandler<K>,
  ) => () => void;
  transport: Transport;
} {
  const { events } = useDataLayer();
  const transport = useSyncExternalStore(
    useCallback((listener) => events.onTransportChange(listener), [events]),
    () => events.transport,
    () => "idle" as const,
  );
  const subscribe = useCallback(
    <K extends LiveEventType>(type: K, handler: LiveEventHandler<K>) =>
      events.subscribe(type, handler),
    [events],
  );
  return { subscribe, transport };
}

/** Run `handler` for each new live event of `type` while mounted. */
export function useLiveEvent<K extends LiveEventType>(
  type: K,
  handler: LiveEventHandler<K>,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { events } = useDataLayer();
  const handlerRef = useLatest(handler);
  useEffect(() => {
    if (!enabled) return;
    return events.subscribe(type, (event) => handlerRef.current(event));
  }, [events, type, enabled, handlerRef]);
}

export interface WorldResult {
  status: SessionState["status"];
  world: WorldOut | null;
  personas: WorldOut["personas"];
  assets: WorldOut["assets"];
  error: ApiError | null;
  /** Try the bootstrap again after an error. */
  retry: () => Promise<void>;
  /** "Reset my demo": restore this world to the template; every cached query refetches. */
  resetWorld: () => Promise<WorldOut | undefined>;
  isResetting: boolean;
  resetError: ApiError | null;
}

/**
 * The session's world (live, or a demo sandbox) and `world.me`, the signed-in account or null.
 * Its personas' cash is a snapshot; use `usePortfolio` for live cash.
 */
export function useWorld(): WorldResult {
  const { session } = useDataLayer();
  const state = useSyncExternalStore(
    useCallback((listener) => session.subscribe(listener), [session]),
    () => session.getSnapshot(),
    () => SERVER_SESSION,
  );
  const reset = useApiMutation((api) => unwrap(api.POST("/world/reset")), {
    onSuccess: (world, _vars, layer) => {
      layer.session.set(world);
      layer.cache.invalidate();
    },
  });
  const retry = useCallback(
    () =>
      session.ensure().then(
        () => undefined,
        () => undefined,
      ),
    [session],
  );
  const resetMutate = reset.mutate;
  const resetWorld = useCallback(() => resetMutate(undefined), [resetMutate]);
  return {
    status: state.status,
    world: state.world,
    personas: state.world?.personas ?? EMPTY,
    assets: state.world?.assets ?? EMPTY,
    error: state.error,
    retry,
    resetWorld,
    isResetting: reset.isPending,
    resetError: reset.error,
  };
}

const EMPTY: never[] = [];
const SERVER_SESSION: SessionState = {
  status: "idle",
  world: null,
  error: null,
};

/** Marketplace cards. Live: prices refresh on `price_tick`. */
export function useAssets(): QueryResult<AssetCard[]> {
  useLiveConnection();
  return useApiQuery(queryKeys.assets(), (api, signal) =>
    unwrap(api.GET("/assets", { signal })),
  );
}

/** One asset; `id` may be undefined while a route param loads. Live: price updates. */
export function useAsset(id: string | undefined): QueryResult<AssetDetail> {
  useLiveConnection(Boolean(id));
  return useApiQuery(
    queryKeys.asset(id ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}", {
          params: { path: { asset_id: id ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(id) },
  );
}

export function useReport(id: string | undefined): QueryResult<ReportOut> {
  return useApiQuery(
    queryKeys.report(id ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/reports/{report_id}", {
          params: { path: { report_id: id ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(id) },
  );
}

/** What changed from report `prev` to report `id`, and the stored reasons why (T37). */
export function useReportDiff(
  id: string | undefined,
  prev: string | undefined,
): QueryResult<ReportDiff> {
  return useApiQuery(
    queryKeys.reportDiff(id ?? "", prev ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/reports/{report_id}/diff/{prev}", {
          params: { path: { report_id: id ?? "", prev: prev ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(id && prev) },
  );
}

/** Every report version of one asset, newest first. Live: refetches after a re-rate. */
export function useAssetReports(
  id: string | undefined,
): QueryResult<ReportOut[]> {
  return useApiQuery(
    queryKeys.reports(id ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/reports", {
          params: { path: { asset_id: id ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(id) },
  );
}

/** One asset's price history, oldest first. Live: refetches on `price_tick`. */
export function useAssetPrices(
  id: string | undefined,
): QueryResult<PricePoint[]> {
  useLiveConnection(Boolean(id));
  return useApiQuery(
    queryKeys.prices(id ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/prices", {
          params: { path: { asset_id: id ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(id) },
  );
}

/** One asset's Nature Ledger entries, oldest first. */
export function useLedger(
  id: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): QueryResult<LedgerEntry[]> {
  return useApiQuery(
    queryKeys.ledger(id ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/ledger/{asset_id}", {
          params: { path: { asset_id: id ?? "" } },
          signal,
        }),
      ),
    { enabled: enabled && Boolean(id) },
  );
}

/** Ask the backend to recompute the asset's hash chain; the entries refetch alongside. */
export function useVerifyLedger(
  id: string,
): MutationResult<void, LedgerVerify> {
  return useApiMutation(
    (api) =>
      unwrap(
        api.GET("/ledger/{asset_id}/verify", {
          params: { path: { asset_id: id } },
        }),
      ),
    {
      onSuccess: (_result, _vars, { cache }) =>
        cache.invalidate(queryKeys.ledger(id)),
    },
  );
}

/** A demo site's overlay and thumbnail metadata (bounds, legend, date windows, attributions). */
export function useSiteImages(
  siteKey: string | null | undefined,
): QueryResult<SiteImages> {
  return useApiQuery(
    queryKeys.siteImages(siteKey ?? ""),
    async (api, signal) =>
      // openapi-fetch widens the generated `bounds` tuples to number[][]; the schema is the same.
      (await unwrap(
        api.GET("/media/demo-sites/{site_key}/images.json", {
          params: { path: { site_key: siteKey ?? "" } },
          signal,
        }),
      )) as SiteImages,
    { enabled: Boolean(siteKey) },
  );
}

/** The demo investor's cash, holdings and impact. Live: refreshes on `price_tick`. */
export function usePortfolio(): QueryResult<PortfolioOut> {
  useLiveConnection();
  return useApiQuery(queryKeys.portfolio(), (api, signal) =>
    unwrap(api.GET("/portfolio", { signal })),
  );
}

/**
 * The signed-in account's communities and its role in each (`GET /me/communities`, T68), so
 * the shells know which apps to offer (T62). Idle for anonymous visitors, who have none.
 */
export function useMyCommunities(): QueryResult<MyCommunity[]> {
  const { session } = useDataLayer();
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  // Signed out, the key has no fetcher, so nothing ever asks for it.
  return useApiQuery(
    queryKeys.myCommunities(meId),
    (api, signal) => {
      // `cache.reset()` on sign-out refetches watched queries before screens re-render with
      // the new key: never ask as someone else.
      if (session.getSnapshot().world?.me?.id !== meId) {
        return Promise.reject(new Error("The account changed."));
      }
      return unwrap(api.GET("/me/communities", { signal }));
    },
    { enabled: meId != null },
  );
}

/**
 * One page of the signed-in account's alerts with their read state (T75), newest first:
 * `communityId` narrows to that community's sites (members only), `before` is the previous
 * page's `next_before`. Live: an `alert` event refetches every page (`wireLiveUpdates`). Idle
 * for anonymous visitors, who get no alerts.
 */
export function useAlerts({
  communityId,
  before,
}: { communityId?: string; before?: string } = {}): QueryResult<AlertList> {
  const { session } = useDataLayer();
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  useLiveConnection(meId != null);
  return useApiQuery(
    queryKeys.alerts(meId, communityId ?? null, before ?? null),
    (api, signal) => {
      if (session.getSnapshot().world?.me?.id !== meId) {
        return Promise.reject(new Error("The account changed."));
      }
      return unwrap(
        api.GET("/alerts", {
          params: { query: { community_id: communityId, before } },
          signal,
        }),
      );
    },
    { enabled: meId != null },
  );
}

/** Mark one alert read; the alerts list refetches. */
export function useMarkAlertRead(): MutationResult<string, AlertOut> {
  return useApiMutation(
    (api, alertId: string) =>
      unwrap(
        api.POST("/alerts/{alert_id}/read", {
          params: { path: { alert_id: alertId } },
        }),
      ),
    {
      onSuccess: (_d, _v, { cache }) => cache.invalidate(queryKeys.alertsAll()),
    },
  );
}

/** Mark every alert read (only `communityId`'s sites', if set); the alerts list refetches. */
export function useMarkAllAlertsRead(): MutationResult<
  { communityId?: string },
  AlertsMarked
> {
  return useApiMutation(
    (api, { communityId }: { communityId?: string }) =>
      unwrap(
        api.POST("/alerts/read-all", {
          params: { query: { community_id: communityId } },
        }),
      ),
    {
      onSuccess: (_d, _v, { cache }) => cache.invalidate(queryKeys.alertsAll()),
    },
  );
}

/**
 * Buy or sell; on success the portfolio, the asset, its quotes and the market list refetch.
 * Never retried: a failed POST is reported, not replayed (it may have filled).
 */
export function usePlaceOrder(): MutationResult<OrderCreate, OrderOut> {
  return useApiMutation(
    (api, order: OrderCreate) => unwrap(api.POST("/orders", { body: order })),
    {
      onSuccess: (order, _vars, { cache }) => {
        cache.invalidate(queryKeys.portfolio());
        cache.invalidate(queryKeys.asset(order.asset_id));
        cache.invalidate(queryKeys.prices(order.asset_id));
        cache.invalidate(queryKeys.quotes(order.asset_id));
        cache.invalidate(queryKeys.assets());
      },
    },
  );
}

/**
 * What an order would cost or pay now, slippage included, priced by the backend
 * (`GET /assets/{id}/quote`). Disabled until there's an asset and a positive whole `qty`.
 * Live: refetches on the asset's `price_tick` and after an order.
 */
export function useQuote(
  assetId: string | undefined,
  side: "buy" | "sell",
  qty: number,
  { enabled = true }: { enabled?: boolean } = {},
): QueryResult<QuoteOut> {
  const valid = Boolean(assetId) && Number.isSafeInteger(qty) && qty > 0;
  useLiveConnection(enabled && valid);
  return useApiQuery(
    queryKeys.quote(assetId ?? "", side, qty),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/quote", {
          params: { path: { asset_id: assetId ?? "" }, query: { side, qty } },
          signal,
        }),
      ),
    { enabled: enabled && valid },
  );
}

/**
 * After the session cookie changed: read `GET /world` again (so `world.me` updates) and drop
 * every cached answer, which belonged to the previous account. If the re-read fails, the auth
 * route's answer is still known: `me` from login or register, null after logout. Set it on the
 * current world, so screens and the cache never keep answering as the previous account.
 * `DataLayerProvider` resets the cache when the viewer changes; if it didn't, reset here.
 */
async function afterSessionChange(
  { session, cache }: DataLayer,
  me: MeOut | null,
) {
  const before = viewerKey(session.getSnapshot().world);
  try {
    await session.reload();
  } catch {
    const world = session.getSnapshot().world;
    if (world) session.set({ ...world, me });
  }
  if (viewerKey(session.getSnapshot().world) === before) cache.reset();
}

/**
 * No sign-up (T55): `POST /demo/start` opens a private sandbox and a demo session as `persona`
 * (a browser that already has one keeps its sandbox and only switches persona). The world and
 * cache then follow the new viewer, as after signing in.
 */
export function useStartDemo(): MutationResult<DemoPersona, WorldOut> {
  const layer = useDataLayer();
  return useApiMutation(async (api, persona: DemoPersona) => {
    const world = await unwrap(api.POST("/demo/start", { body: { persona } }));
    afterDemoSwitch(layer, world);
    return world;
  });
}

/** `POST /demo/persona`: act as another persona in the same sandbox (demo sessions only). */
export function useSwitchPersona(): MutationResult<DemoPersona, WorldOut> {
  const layer = useDataLayer();
  return useApiMutation(async (api, persona: DemoPersona) => {
    const world = await unwrap(
      api.POST("/demo/persona", { body: { persona } }),
    );
    afterDemoSwitch(layer, world);
    return world;
  });
}

function afterDemoSwitch({ session, cache }: DataLayer, world: WorldOut) {
  const before = viewerKey(session.getSnapshot().world);
  session.set(world);
  if (viewerKey(world) === before) cache.reset();
}

/** Whether to show model spend in dollars. Not in a no-sign-up demo session: a judge sees what
 * each model did and how long it took, never prices or the sandbox's hidden allowance. Hidden
 * until the world is known, so a demo session never flashes a price while it loads. */
export function useShowCost(): boolean {
  const { world } = useWorld();
  return world != null && !world.me?.persona;
}

/** `POST /assets/{id}/rate`: start a rating run now (a member of its community or an admin);
 * follow it at `/trace/{run_id}`. */
export function useRateNow(): MutationResult<string, RatingRunAccepted> {
  return useApiMutation((api, assetId: string) =>
    unwrap(
      api.POST("/assets/{asset_id}/rate", {
        params: { path: { asset_id: assetId } },
      }),
    ),
  );
}

/** The `/judge` story's data (`GET /story`): one site, every number from the product's code. */
export function useStory(): QueryResult<Story> {
  return useApiQuery(queryKeys.story(), (api, signal) =>
    unwrap(api.GET("/story", { signal })),
  );
}

/** `POST /auth/login`, then the world and cache follow the new account. */
export function useSignIn(): MutationResult<LoginIn, MeOut> {
  const layer = useDataLayer();
  return useApiMutation(async (api, body: LoginIn) => {
    const me = await unwrap(api.POST("/auth/login", { body }));
    await afterSessionChange(layer, me);
    return me;
  });
}

/** `POST /auth/register` (signs in too), then the world and cache follow the new account. */
export function useRegister(): MutationResult<RegisterIn, MeOut> {
  const layer = useDataLayer();
  return useApiMutation(async (api, body: RegisterIn) => {
    const me = await unwrap(api.POST("/auth/register", { body }));
    await afterSessionChange(layer, me);
    return me;
  });
}

/** `POST /auth/logout`, then the world (`me` becomes null) and the cache reset. */
export function useSignOut(): MutationResult<void, void> {
  const layer = useDataLayer();
  return useApiMutation(async (api) => {
    const meId = layer.session.getSnapshot().world?.me?.id;
    await unwrap(api.POST("/auth/logout"));
    if (meId) forgetCommunity(meId);
    await afterSessionChange(layer, null);
  });
}

/**
 * The opening offer (IPO) an owner would launch now (T64): every term of the price formula,
 * `launchable` and `blocked_reason`, priced by the backend (`GET /assets/{id}/ipo/preview`).
 * Idle until both inputs are valid. Live: refetches when the asset's rating run ends.
 */
export function useIpoPreview(
  assetId: string | undefined,
  totalShares: number | null,
  retainedPct: string | null,
  { enabled = true }: { enabled?: boolean } = {},
): QueryResult<IpoPreview> {
  const on =
    enabled && Boolean(assetId) && totalShares !== null && retainedPct !== null;
  useLiveConnection(on);
  return useApiQuery(
    queryKeys.ipoPreview(assetId ?? "", totalShares ?? 0, retainedPct ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/assets/{asset_id}/ipo/preview", {
          params: {
            path: { asset_id: assetId ?? "" },
            query: {
              total_shares: totalShares ?? undefined,
              retained_pct: retainedPct ?? undefined,
            },
          },
          signal,
        }),
      ),
    { enabled: on },
  );
}

/**
 * Launch the opening offer at the previewed price (`POST /assets/{id}/ipo`; `expected_price`
 * is required, so a newer report gets 409 `ipo_price_changed` instead of a surprise price).
 * Then the asset, its prices and ledger and the market list refetch. Never retried.
 */
export function useLaunchIpo(
  assetId: string,
): MutationResult<IpoLaunch, IpoOut> {
  return useApiMutation(
    (api, body: IpoLaunch) =>
      unwrap(
        api.POST("/assets/{asset_id}/ipo", {
          params: { path: { asset_id: assetId } },
          body,
        }),
      ),
    {
      onSuccess: (_ipo, _vars, { cache }) => {
        cache.invalidate(queryKeys.asset(assetId));
        cache.invalidate(queryKeys.prices(assetId));
        cache.invalidate(queryKeys.ledger(assetId));
        cache.invalidate(queryKeys.assets());
      },
    },
  );
}

// ----- The listing flow (T33): rating runs and the listing lifecycle writes (T58) -----

const RUN_ACTIVE = new Set<RatingRun["status"]>(["queued", "running"]);
/** While a run is active, refetch it this often even without events: a run whose worker died
 * only shows as failed (`stale`) when it is read again. */
const RUN_POLL_MS = 10_000;

/** A rating run (`GET /runs/{id}`). Live: refetches on each of its `rating_progress` events. */
export function useRatingRun(
  runId: string | null | undefined,
): QueryResult<RatingRun> {
  useLiveConnection(Boolean(runId));
  const query = useApiQuery(
    queryKeys.run(runId ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/runs/{run_id}", {
          params: { path: { run_id: runId ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(runId) },
  );
  const active = query.data ? RUN_ACTIVE.has(query.data.status) : false;
  const { refetch } = query;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refetch(), RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [active, refetch]);
  return query;
}

/**
 * A rating run's Agent Trace (`GET /runs/{id}/trace`, T28): its spans, model attempts, tokens,
 * latency and safe tool-result summaries. Live: a run's `rating_progress` events refetch it
 * (`queryKeys.runTrace` sits under `queryKeys.run`), and an active run is re-read every 10 s.
 */
export function useRunTrace(
  runId: string | null | undefined,
): QueryResult<RunTrace> {
  useLiveConnection(Boolean(runId));
  const query = useApiQuery(
    queryKeys.runTrace(runId ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/runs/{run_id}/trace", {
          params: { path: { run_id: runId ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(runId) },
  );
  const active = query.data ? RUN_ACTIVE.has(query.data.status) : false;
  const { refetch } = query;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refetch(), RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [active, refetch]);
  return query;
}

/**
 * The world's latest logged model calls (`GET /admin/trace`, up to 50, metadata only), for
 * the Agent Trace drawer away from a site.
 */
export function useWorldTrace(): QueryResult<WorldTrace> {
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  return useApiQuery(queryKeys.worldTrace(meId), (api, signal) =>
    unwrap(api.GET("/admin/trace", { signal })),
  );
}

/**
 * A demo site's recorded rating run (`GET /media/demo-sites/{site_key}/recorded-run.json`): a
 * real run committed as data, shown labelled "Recorded" until the visitor rates the site.
 * Only asked for demo sites; others have none.
 */
export function useRecordedRun(
  siteKey: string | null | undefined,
): QueryResult<RecordedRun> {
  const enabled = Boolean(siteKey && DEMO_SITES.some((s) => s.key === siteKey));
  return useApiQuery(
    queryKeys.recordedRun(siteKey ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/media/demo-sites/{site_key}/recorded-run.json", {
          params: { path: { site_key: siteKey ?? "" } },
          signal,
        }),
      ),
    { enabled },
  );
}

/** The AI control room: this world's calls per model, the deployment's spend and Tavily credits. */
export function useAiUsage(): QueryResult<AiUsage> {
  const { world } = useWorld();
  const meId = world?.me?.id ?? null;
  return useApiQuery(queryKeys.aiUsage(meId), (api, signal) =>
    unwrap(api.GET("/admin/ai-usage", { signal })),
  );
}

/**
 * The outlines of the world's public sites (`GET /assets/outlines`, simplified on the server)
 * for the listing map and its overlap hint. Fetched once per tab and kept: later mounts reuse
 * it, and a listing becoming public refetches it (`wireLiveUpdates`).
 */
export function useAssetOutlines(): QueryResult<AssetOutlines> {
  const { cache } = useDataLayer();
  const [cached] = useState(
    () => cache.getState(queryKeys.outlines()).status === "success",
  );
  return useApiQuery(
    queryKeys.outlines(),
    (api, signal) => unwrap(api.GET("/assets/outlines", { signal })),
    { enabled: !cached },
  );
}

/**
 * Refetch a listing and its ledger now, e.g. when its run ended or another run started without
 * a `listing_status` event reaching this tab.
 */
export function useRefreshListing(): (assetId: string) => void {
  const { cache } = useDataLayer();
  return useCallback(
    (assetId: string) => {
      cache.invalidate(queryKeys.asset(assetId));
      cache.invalidate(queryKeys.ledger(assetId));
    },
    [cache],
  );
}

/** Cache the listing a write returned (a new one too) and refresh its ledger. */
function afterListingWrite(asset: AssetDetail, { cache }: DataLayer) {
  cache.setData<AssetDetail>(queryKeys.asset(asset.id), () => asset, {
    seed: true,
  });
  cache.invalidate(queryKeys.ledger(asset.id));
}

/** `POST /assets`: a draft listing. The new listing is cached, so its page shows at once. */
export function useCreateListing(): MutationResult<AssetCreate, AssetDetail> {
  return useApiMutation(
    (api, body: AssetCreate) => unwrap(api.POST("/assets", { body })),
    { onSuccess: (asset, _vars, layer) => afterListingWrite(asset, layer) },
  );
}

/**
 * `GET /places/search`: find a place by name for the listing map (#215). A mutation, not a
 * query: it runs only when the steward submits a search (Nominatim forbids search-as-you-type).
 */
export function usePlaceSearch(): MutationResult<string, PlaceSearchOut> {
  return useApiMutation(
    (api, q: string) =>
      // openapi-fetch widens the `bbox` tuple to number[]; the schema says four numbers.
      unwrap(
        api.GET("/places/search", { params: { query: { q } } }),
      ) as Promise<PlaceSearchOut>,
  );
}

/** `PATCH /assets/{id}`: edit a draft (send only the fields that changed). */
export function useUpdateListing(): MutationResult<
  { assetId: string; body: AssetUpdate },
  AssetDetail
> {
  return useApiMutation(
    (api, { assetId, body }: { assetId: string; body: AssetUpdate }) =>
      unwrap(
        api.PATCH("/assets/{asset_id}", {
          params: { path: { asset_id: assetId } },
          body,
        }),
      ),
    { onSuccess: (asset, _vars, layer) => afterListingWrite(asset, layer) },
  );
}

/** `POST /assets/{id}/submit` (202 + `run_id`): the listing moves to `rating`. */
export function useSubmitListing(): MutationResult<string, AssetSubmitted> {
  return useApiMutation(
    (api, assetId: string) =>
      unwrap(
        api.POST("/assets/{asset_id}/submit", {
          params: { path: { asset_id: assetId } },
        }),
      ),
    {
      onSuccess: ({ asset_id }, _vars, { cache }) => {
        cache.invalidate(queryKeys.asset(asset_id));
        cache.invalidate(queryKeys.ledger(asset_id));
      },
    },
  );
}

/** `POST /assets/{id}/revise` (back to draft) or `…/withdraw` (final). */
export function useLeaveReview(
  action: "revise" | "withdraw",
): MutationResult<string, AssetDetail> {
  return useApiMutation(
    (api, assetId: string) => {
      const params = { params: { path: { asset_id: assetId } } };
      return unwrap(
        action === "revise"
          ? api.POST("/assets/{asset_id}/revise", params)
          : api.POST("/assets/{asset_id}/withdraw", params),
      );
    },
    { onSuccess: (asset, _vars, layer) => afterListingWrite(asset, layer) },
  );
}

export type { QueryStatus };
