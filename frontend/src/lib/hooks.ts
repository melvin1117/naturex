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

import type { ApiClient } from "./api/client";
import { toApiError, unwrap, type ApiError } from "./api/errors";
import type {
  AssetCard,
  AssetDetail,
  LoginIn,
  MeOut,
  OrderCreate,
  OrderOut,
  PortfolioOut,
  RegisterIn,
  ReportOut,
  WorldOut,
} from "./api/types";
import {
  queryKeys,
  useDataLayer,
  viewerKey,
  type DataLayer,
} from "./data-layer";
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

/** The demo investor's cash, holdings and impact. Live: refreshes on `price_tick`. */
export function usePortfolio(): QueryResult<PortfolioOut> {
  useLiveConnection();
  return useApiQuery(queryKeys.portfolio(), (api, signal) =>
    unwrap(api.GET("/portfolio", { signal })),
  );
}

/** Buy or sell; on success the portfolio, the asset and the market list refetch. */
export function usePlaceOrder(): MutationResult<OrderCreate, OrderOut> {
  return useApiMutation(
    (api, order: OrderCreate) => unwrap(api.POST("/orders", { body: order })),
    {
      onSuccess: (order, _vars, { cache }) => {
        cache.invalidate(queryKeys.portfolio());
        cache.invalidate(queryKeys.asset(order.asset_id));
        cache.invalidate(queryKeys.prices(order.asset_id));
        cache.invalidate(queryKeys.assets());
      },
    },
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
    await unwrap(api.POST("/auth/logout"));
    await afterSessionChange(layer, null);
  });
}

export type { QueryStatus };
