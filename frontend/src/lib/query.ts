/**
 * A small query cache behind `useApiQuery`: dedupes concurrent fetches per key, keeps the
 * last data while refetching, aborts a fetch when its last subscriber unmounts, and lets
 * mutations and live events invalidate or patch entries. Framework-free so it's easy to
 * test; the React bindings live in ./hooks.ts.
 */
import { toApiError, type ApiError } from "./api/errors";

export type QueryKey = readonly (
  string | number | boolean | null | undefined
)[];
export type QueryStatus = "idle" | "loading" | "success" | "error";

export interface QueryState<T> {
  status: QueryStatus;
  data: T | undefined;
  error: ApiError | null;
  /** True during any fetch, including background refetches that keep the old data. */
  isFetching: boolean;
}

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

interface Entry {
  key: QueryKey;
  state: QueryState<unknown>;
  listeners: Set<() => void>;
  fetcher?: Fetcher<unknown>;
  controller?: AbortController;
  promise?: Promise<void>;
  /** Invalidated while a fetch was in flight: fetch again when it settles. */
  stale: boolean;
}

export const IDLE_QUERY: QueryState<never> = Object.freeze({
  status: "idle",
  data: undefined,
  error: null,
  isFetching: false,
});

export function hashKey(key: QueryKey): string {
  return JSON.stringify(key);
}

function startsWith(key: QueryKey, prefix: QueryKey): boolean {
  return prefix.every((part, index) => key[index] === part);
}

export type QueryFilter = QueryKey | ((key: QueryKey) => boolean);

export class QueryCache {
  #entries = new Map<string, Entry>();

  #entry(key: QueryKey): Entry {
    const hash = hashKey(key);
    let entry = this.#entries.get(hash);
    if (!entry) {
      entry = { key, state: IDLE_QUERY, listeners: new Set(), stale: false };
      this.#entries.set(hash, entry);
    }
    return entry;
  }

  #set(entry: Entry, patch: Partial<QueryState<unknown>>) {
    entry.state = { ...entry.state, ...patch };
    entry.listeners.forEach((listener) => listener());
  }

  getState<T>(key: QueryKey): QueryState<T> {
    return (this.#entries.get(hashKey(key))?.state ??
      IDLE_QUERY) as QueryState<T>;
  }

  #cancel(entry: Entry) {
    if (!entry.controller) return;
    entry.controller.abort();
    entry.controller = undefined;
    entry.promise = undefined;
    entry.stale = false;
    this.#set(entry, {
      status: entry.state.status === "loading" ? "idle" : entry.state.status,
      isFetching: false,
    });
  }

  subscribe(key: QueryKey, listener: () => void): () => void {
    const entry = this.#entry(key);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      // Nobody is watching any more: cancel the request (abort-on-unmount).
      if (entry.listeners.size === 0) this.#cancel(entry);
    };
  }

  /** Fetch now, or join the fetch already in flight for this key. */
  fetch<T>(key: QueryKey, fetcher: Fetcher<T>): Promise<void> {
    const entry = this.#entry(key);
    entry.fetcher = fetcher as Fetcher<unknown>;
    if (entry.promise) return entry.promise;

    const controller = new AbortController();
    entry.controller = controller;
    entry.stale = false;
    this.#set(entry, {
      status: entry.state.data === undefined ? "loading" : entry.state.status,
      isFetching: true,
    });

    const promise = fetcher(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        this.#set(entry, {
          status: "success",
          data,
          error: null,
          isFetching: false,
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        this.#set(entry, {
          status: "error",
          error: toApiError(error),
          isFetching: false,
        });
      },
    );
    entry.promise = promise.finally(() => {
      if (entry.controller !== controller) return; // cancelled or superseded
      entry.promise = undefined;
      entry.controller = undefined;
      if (entry.stale && entry.listeners.size > 0 && entry.fetcher) {
        void this.fetch(entry.key, entry.fetcher);
      }
    });
    return entry.promise;
  }

  /** Patch cached data (e.g. a live `price_tick`). Missing entries are left alone. */
  setData<T>(
    key: QueryKey,
    update: (previous: T | undefined) => T | undefined,
  ) {
    const entry = this.#entries.get(hashKey(key));
    if (!entry || entry.state.data === undefined) return;
    this.#set(entry, { data: update(entry.state.data as T) });
  }

  /**
   * Mark matching queries out of date. Watched ones refetch (once, even if invalidated many
   * times while a fetch is in flight); unwatched ones are dropped and refetch on next use.
   */
  invalidate(filter: QueryFilter = () => true) {
    const matches =
      typeof filter === "function"
        ? filter
        : (key: QueryKey) => startsWith(key, filter);
    for (const [hash, entry] of this.#entries) {
      if (!matches(entry.key)) continue;
      if (entry.listeners.size === 0) {
        if (!entry.promise) this.#entries.delete(hash);
        continue;
      }
      if (entry.promise) entry.stale = true;
      else if (entry.fetcher) void this.fetch(entry.key, entry.fetcher);
    }
  }
}
