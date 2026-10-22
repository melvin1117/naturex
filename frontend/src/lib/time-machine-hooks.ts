"use client";

/**
 * Time Machine hooks for the admin panel (T43, T38's API). Kept apart from `hooks.ts`, like
 * the other screens' hooks; they follow its conventions.
 */
import { useEffect, useRef } from "react";

import { unwrap } from "./api/errors";
import type {
  QuarterJob,
  SentAlert,
  SimulateEvent,
  SimulateEventRequest,
  TimeMachine,
} from "./api/types";
import { queryKeys, useDataLayer } from "./data-layer";
import {
  useApiMutation,
  useApiQuery,
  useWorld,
  type MutationResult,
  type QueryResult,
} from "./hooks";
import {
  alertBatches,
  isJobActive,
  mergeSentAlerts,
  QUARTER_POLL_MS,
} from "./time-machine";

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
 * "Next quarter" (`period` is the next quarter as the admin saw it; the current one replays
 * it). Answers 202 with the job once the world has moved, so the Time Machine state refetches
 * at once; follow the job with `useQuarterJob`.
 */
export function useSimulateQuarter(): MutationResult<string, QuarterJob> {
  return useApiMutation(
    (api, period: string) =>
      unwrap(api.POST("/admin/simulate/quarter", { body: { period } })),
    {
      onSuccess: (job, _v, { cache }) => {
        // Seed the job as queued, so `useQuarterJob` sees it run and settle.
        cache.setData(queryKeys.quarterJob(job.id), () => job, { seed: true });
        cache.invalidate(["time-machine"]);
      },
    },
  );
}

const SETTLED_KEYS = new Set(["quarter-job", "sent-alerts"]);

/** A 4xx answer: the job is gone (404, e.g. a reset) or no longer the caller's to read. */
export function isRefused(error: { status: number } | null): boolean {
  return error !== null && error.status >= 400 && error.status < 500;
}

/**
 * A quarter job (`GET /admin/simulate/quarter/{id}`), read again every `QUARTER_POLL_MS`
 * while its latest read is queued or running and the tab is visible; never after a 4xx. A
 * read also resumes a job whose server process died. Once a job this hook saw running
 * settles, every other cached query refetches (any asset may have a new report, price, alert
 * and payout); opening on a finished job refetches nothing.
 */
export function useQuarterJob(jobId: string | null): QueryResult<QuarterJob> {
  const { cache } = useDataLayer();
  const query = useApiQuery(
    queryKeys.quarterJob(jobId ?? ""),
    (api, signal) =>
      unwrap(
        api.GET("/admin/simulate/quarter/{job_id}", {
          params: { path: { job_id: jobId ?? "" } },
          signal,
        }),
      ),
    { enabled: Boolean(jobId) },
  );
  const polling = isJobActive(query.data) && !isRefused(query.error);
  const { refetch } = query;
  useEffect(() => {
    if (!polling) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer ??= setInterval(() => void refetch(), QUARTER_POLL_MS);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.hidden) return stop();
      void refetch();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [polling, refetch]);

  const data = query.data;
  const seenRunning = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    if (isJobActive(data)) {
      seenRunning.current = data.id;
      return;
    }
    if (seenRunning.current !== data.id) return;
    seenRunning.current = null;
    // Not the jobs themselves nor the alerts they sent: those don't change any more.
    cache.invalidate((key) => !SETTLED_KEYS.has(String(key[0])));
  }, [data, cache]);
  return query;
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

/**
 * The alerts a quarter or event sent, as their recipients got them (`GET /admin/alerts`): in
 * parallel requests of at most 50 ids, merged newest first.
 */
export function useSentAlerts(
  ids: readonly string[],
): QueryResult<SentAlert[]> {
  return useApiQuery(
    queryKeys.sentAlerts(ids),
    async (api, signal) =>
      mergeSentAlerts(
        await Promise.all(
          alertBatches(ids).map((batch) =>
            unwrap(
              api.GET("/admin/alerts", {
                params: { query: { ids: batch } },
                signal,
              }),
            ),
          ),
        ),
      ),
    { enabled: ids.length > 0 },
  );
}
