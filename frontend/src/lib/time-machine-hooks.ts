"use client";

/**
 * Time Machine hooks for the admin panel (T43, T38's API). Kept apart from `hooks.ts`, like
 * the other screens' hooks; they follow its conventions.
 */
import { unwrap } from "./api/errors";
import type {
  SentAlert,
  SimulateEvent,
  SimulateEventRequest,
  SimulateQuarter,
  TimeMachine,
} from "./api/types";
import { queryKeys } from "./data-layer";
import {
  useApiMutation,
  useApiQuery,
  useWorld,
  type MutationResult,
  type QueryResult,
} from "./hooks";

/** The world's quarter, the next one, the timeline and the presets. Admins only. */
export function useTimeMachine(): QueryResult<TimeMachine> {
  const { world } = useWorld();
  const me = world?.me;
  return useApiQuery(
    queryKeys.timeMachine(me?.id ?? null),
    (api, signal) => unwrap(api.GET("/admin/time-machine", { signal })),
    { enabled: Boolean(me?.is_admin) },
  );
}

/**
 * "Next quarter" (`period` is the next quarter as the admin saw it). Every asset may have a new
 * report, price, alert and payout, so on success every cached query refetches.
 */
export function useSimulateQuarter(): MutationResult<string, SimulateQuarter> {
  return useApiMutation(
    (api, period: string) =>
      unwrap(api.POST("/admin/simulate/quarter", { body: { period } })),
    { onSuccess: (_d, _v, { cache }) => cache.invalidate() },
  );
}

/** Inject an event preset into one asset; everything about that asset refetches. */
export function useSimulateEvent(): MutationResult<
  SimulateEventRequest,
  SimulateEvent
> {
  return useApiMutation(
    (api, body: SimulateEventRequest) =>
      unwrap(api.POST("/admin/simulate/event", { body })),
    { onSuccess: (_d, _v, { cache }) => cache.invalidate() },
  );
}

/** The alerts a quarter or event sent, as their recipients got them (`GET /admin/alerts`). */
export function useSentAlerts(
  ids: readonly string[],
): QueryResult<SentAlert[]> {
  return useApiQuery(
    queryKeys.sentAlerts(ids),
    (api, signal) =>
      unwrap(
        api.GET("/admin/alerts", {
          params: { query: { ids: [...ids] } },
          signal,
        }),
      ),
    { enabled: ids.length > 0 },
  );
}
