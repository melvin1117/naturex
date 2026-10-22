/**
 * Live world events (T29, dev-spec §6) with the transport hidden from screens.
 *
 * - SSE first: `EventSource` on `/api/events/stream`. Same-origin through the Next.js proxy,
 *   so the HttpOnly session cookie is sent (`EventSource` can't set headers). On a dropped
 *   connection the browser reconnects by itself after the server's `retry:` and sends
 *   `Last-Event-ID` (https://html.spec.whatwg.org/multipage/server-sent-events.html), so
 *   finite 300 s streams resume where they left off.
 * - A non-200 answer (503 `too_many_event_streams`, 401) or a wrong content type makes the
 *   browser give up (`readyState === CLOSED`), and `EventSource` can't read the status. That,
 *   `maxSseErrors` errors in a row, or a stream that stays silent past `silenceTimeoutMs`
 *   (the backend sends a heartbeat every ~15 s; a buffering proxy can swallow them) switches
 *   to polling `GET /events?since_id=` every 3 s. SSE is tried again later with backoff, and
 *   polling continues until the new stream proves itself with a first message.
 * - Events are delivered once, in id order: ids are a monotonic per-world cursor, so anything
 *   at or below the last delivered id (a replay after a transport switch) is dropped.
 *   `heartbeat` events only prove the connection is alive; they're never delivered.
 */
import type { StreamEvent, StreamEventType } from "./api/types";
import { isSessionExpired } from "./session";

export type LiveEventType = Exclude<StreamEventType, "heartbeat">;

/** `price_tick` payload as published by backend/app/routers/market.py. */
export interface PriceTickPayload {
  asset_id: string;
  /** Decimal as a string, never a float. */
  price: string;
  reason: string;
}

/**
 * `listing_status` payload as published by backend/app/services/listings.py (T58). Events
 * about a listing under review reach only its community and admins; `rating_failed` is not a
 * transition (the listing stays in `rating`) but says why it is stuck.
 */
export interface ListingStatusPayload {
  asset_id: string;
  community_id: string | null;
  transition:
    | "create"
    | "edit"
    | "submit"
    | "rated"
    | "revise"
    | "withdraw"
    | "suspend"
    | "resume"
    | "rating_failed";
  from: string | null;
  to: string;
  /** A code such as `confidence_below_70`; null when the status needs no explanation. */
  reason: string | null;
  run_id?: string | null;
  report_id?: string;
}

/**
 * `alert` payload as published by backend/app/services/alerts.py (T75). Alerts reach only the
 * asset's holders and its community's members; `GET /alerts` has the read state.
 */
export interface AlertPayload {
  alert_id: string;
  asset_id: string;
  asset_name: string;
  kind: "grade_change" | "health_change" | "news" | "verification";
  title: string;
  message: string;
  severity: number;
  report_id: string | null;
  url: string | null;
}

export interface LiveEventPayloads {
  price_tick: PriceTickPayload;
  rating_progress: Record<string, unknown>;
  alert: AlertPayload;
  listing_status: ListingStatusPayload;
}

export interface LiveEvent<K extends LiveEventType = LiveEventType> {
  id: number;
  type: K;
  payload: LiveEventPayloads[K];
  ts: string;
}

export type LiveEventHandler<K extends LiveEventType> = (
  event: LiveEvent<K>,
) => void;

export type Transport = "idle" | "connecting" | "sse" | "polling";

export const LIVE_EVENT_TYPES: readonly LiveEventType[] = [
  "rating_progress",
  "price_tick",
  "alert",
  "listing_status",
];

/** The part of the browser's `EventSource` the hub uses (easy to fake in tests). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;
type PollFetch = (url: string, init: RequestInit) => Promise<Response>;

const CLOSED = 2; // EventSource.CLOSED; the constant isn't available in every test env.

export interface EventHubOptions {
  /** `/api` in the browser (the same-origin proxy). */
  baseUrl?: string;
  /** Defaults to the global `EventSource`; null forces polling. */
  createEventSource?: EventSourceFactory | null;
  fetch?: PollFetch;
  /** Wait for the world before connecting (the bootstrap's `ensure`). */
  ensureSession?: () => Promise<unknown>;
  /** Called when a poll gets 401 `auth_required` (the bootstrap's `refresh`). */
  refreshSession?: () => Promise<unknown>;
  pollIntervalMs?: number;
  /** Errors in a row, without an `open` in between, before falling back to polling. */
  maxSseErrors?: number;
  /** Wait before trying SSE again after each fallback; the last value repeats. */
  sseRetryDelaysMs?: readonly number[];
  /** A stream with no message (heartbeats included) for this long is treated as broken. */
  silenceTimeoutMs?: number;
}

function defaultEventSource(): EventSourceFactory | null {
  if (typeof EventSource === "undefined") return null;
  return (url) => new EventSource(url, { withCredentials: true });
}

function isPriceTick(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.asset_id === "string" && typeof payload.price === "string"
  );
}

function isAlert(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.alert_id === "string" &&
    typeof payload.asset_id === "string" &&
    typeof payload.title === "string"
  );
}

/** Narrow a raw `StreamEvent` to a deliverable `LiveEvent`, or null to drop it. */
export function toLiveEvent(raw: StreamEvent): LiveEvent | null {
  if (typeof raw.id !== "number" || raw.type === "heartbeat") return null;
  if (!(LIVE_EVENT_TYPES as readonly string[]).includes(raw.type)) return null;
  if (raw.type === "price_tick" && !isPriceTick(raw.payload)) return null;
  if (raw.type === "alert" && !isAlert(raw.payload)) return null;
  return raw as unknown as LiveEvent;
}

export class EventHub {
  readonly #baseUrl: string;
  readonly #createEventSource: EventSourceFactory | null;
  readonly #fetch: PollFetch;
  readonly #ensureSession: () => Promise<unknown>;
  readonly #refreshSession: () => Promise<unknown>;
  readonly #pollIntervalMs: number;
  readonly #maxSseErrors: number;
  readonly #sseRetryDelaysMs: readonly number[];
  readonly #silenceTimeoutMs: number;

  readonly #handlers = new Map<
    LiveEventType,
    Set<(event: LiveEvent) => void>
  >();
  readonly #transportListeners = new Set<() => void>();
  #retainers = 0;
  #transport: Transport = "idle";
  #lastId: number | null = null;

  #source: EventSourceLike | null = null;
  /** The current stream has delivered at least one message (heartbeats count). */
  #sourceProven = false;
  #sseErrors = 0;
  #sseAttempt = 0;
  #silenceTimer: ReturnType<typeof setTimeout> | null = null;
  #sseRetryTimer: ReturnType<typeof setTimeout> | null = null;

  #polling = false;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #pollController: AbortController | null = null;

  /** Bumped on stop, so callbacks from an old connection do nothing. */
  #epoch = 0;

  constructor(options: EventHubOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "/api";
    this.#createEventSource =
      options.createEventSource === undefined
        ? defaultEventSource()
        : options.createEventSource;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#ensureSession = options.ensureSession ?? (() => Promise.resolve());
    this.#refreshSession = options.refreshSession ?? (() => Promise.resolve());
    this.#pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.#maxSseErrors = options.maxSseErrors ?? 3;
    this.#sseRetryDelaysMs = options.sseRetryDelaysMs ?? [
      15_000, 30_000, 60_000, 120_000,
    ];
    this.#silenceTimeoutMs = options.silenceTimeoutMs ?? 35_000;
  }

  get transport(): Transport {
    return this.#transport;
  }

  get lastEventId(): number | null {
    return this.#lastId;
  }

  onTransportChange(listener: () => void): () => void {
    this.#transportListeners.add(listener);
    return () => this.#transportListeners.delete(listener);
  }

  /**
   * Call `handler` for every new event of `type`. The connection opens with the first
   * retaining subscriber and closes with the last. `retain: false` listens without keeping
   * a connection open (used by the cache wiring). Returns the unsubscribe function.
   */
  subscribe<K extends LiveEventType>(
    type: K,
    handler: LiveEventHandler<K>,
    { retain = true }: { retain?: boolean } = {},
  ): () => void {
    const set = this.#handlers.get(type) ?? new Set();
    this.#handlers.set(type, set);
    const wrapped = handler as (event: LiveEvent) => void;
    set.add(wrapped);
    const release = retain ? this.retain() : () => {};
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(wrapped);
      release();
    };
  }

  /** Keep the connection open without a handler; returns the release function. */
  retain(): () => void {
    this.#retainers += 1;
    if (this.#retainers === 1) void this.#start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#retainers -= 1;
      if (this.#retainers === 0) this.#stop();
    };
  }

  /** Stop everything and drop every handler. */
  close() {
    this.#handlers.clear();
    this.#retainers = 0;
    this.#stop();
  }

  #setTransport(transport: Transport) {
    if (this.#transport === transport) return;
    this.#transport = transport;
    this.#transportListeners.forEach((listener) => listener());
  }

  async #start() {
    const epoch = this.#epoch;
    this.#setTransport("connecting");
    try {
      await this.#ensureSession();
    } catch {
      // No world yet (e.g. 503 busy): carry on; a 401 makes polling re-bootstrap.
    }
    if (epoch !== this.#epoch) return;
    if (this.#createEventSource) this.#openSse();
    else this.#startPolling();
  }

  #stop() {
    this.#epoch += 1;
    this.#closeSource();
    this.#stopPolling();
    if (this.#sseRetryTimer) clearTimeout(this.#sseRetryTimer);
    this.#sseRetryTimer = null;
    this.#sseAttempt = 0;
    this.#setTransport("idle");
  }

  // --- SSE ---------------------------------------------------------------------------

  #openSse() {
    const create = this.#createEventSource;
    if (!create) return;
    const query = this.#lastId === null ? "" : `?since_id=${this.#lastId}`;
    const source = create(`${this.#baseUrl}/events/stream${query}`);
    this.#source = source;
    this.#sourceProven = false;
    this.#sseErrors = 0;
    const current = () => this.#source === source;

    source.addEventListener("open", () => {
      if (!current()) return;
      this.#sseErrors = 0;
      this.#armSilenceTimer();
      if (!this.#polling) this.#setTransport("sse");
    });
    source.addEventListener("heartbeat", () => {
      if (current()) this.#onSseMessage();
    });
    for (const type of LIVE_EVENT_TYPES) {
      source.addEventListener(type, (message) => {
        if (!current()) return;
        this.#onSseMessage();
        this.#receiveRaw(message.data);
      });
    }
    source.addEventListener("error", () => {
      if (!current()) return;
      this.#sseErrors += 1;
      if (
        source.readyState === CLOSED ||
        this.#sseErrors >= this.#maxSseErrors
      ) {
        this.#fallBackToPolling();
      }
    });
  }

  /** Any message proves the stream works: reset backoff and hand over from polling. */
  #onSseMessage() {
    this.#sseErrors = 0;
    this.#armSilenceTimer();
    if (this.#sourceProven) return;
    this.#sourceProven = true;
    this.#sseAttempt = 0;
    this.#stopPolling();
    this.#setTransport("sse");
  }

  #armSilenceTimer() {
    if (this.#silenceTimer) clearTimeout(this.#silenceTimer);
    const source = this.#source;
    this.#silenceTimer = setTimeout(() => {
      this.#silenceTimer = null;
      if (this.#source === source) this.#fallBackToPolling();
    }, this.#silenceTimeoutMs);
  }

  #closeSource() {
    this.#source?.close();
    this.#source = null;
    this.#sourceProven = false;
    if (this.#silenceTimer) clearTimeout(this.#silenceTimer);
    this.#silenceTimer = null;
  }

  #fallBackToPolling() {
    this.#closeSource();
    this.#startPolling();
    if (!this.#createEventSource || this.#sseRetryTimer) return;
    const delays = this.#sseRetryDelaysMs;
    const delay = delays[Math.min(this.#sseAttempt, delays.length - 1)] ?? 0;
    this.#sseAttempt += 1;
    const epoch = this.#epoch;
    this.#sseRetryTimer = setTimeout(() => {
      this.#sseRetryTimer = null;
      // Keep polling until the new stream delivers its first message.
      if (epoch === this.#epoch) this.#openSse();
    }, delay);
  }

  // --- Delivery ----------------------------------------------------------------------

  #receiveRaw(data: string) {
    try {
      this.#deliver(JSON.parse(data) as StreamEvent);
    } catch (error) {
      console.error("NatureX events: unreadable event", error);
    }
  }

  #deliver(raw: StreamEvent) {
    const event = toLiveEvent(raw);
    if (!event) return;
    if (this.#lastId !== null && event.id <= this.#lastId) return;
    this.#lastId = event.id;
    this.#handlers.get(event.type)?.forEach((handler) => {
      try {
        handler(event);
      } catch (error) {
        console.error(`NatureX events: ${event.type} handler failed`, error);
      }
    });
  }

  // --- Polling -----------------------------------------------------------------------

  #startPolling() {
    this.#setTransport("polling");
    if (this.#polling) return;
    this.#polling = true;
    void this.#poll();
  }

  #stopPolling() {
    this.#polling = false;
    if (this.#pollTimer) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
    this.#pollController?.abort();
    this.#pollController = null;
  }

  async #poll() {
    const controller = new AbortController();
    this.#pollController = controller;
    const query = this.#lastId === null ? "" : `?since_id=${this.#lastId}`;
    let delay = this.#pollIntervalMs;
    try {
      const response = await this.#fetch(`${this.#baseUrl}/events${query}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (response.ok && Array.isArray(body)) {
        for (const raw of body as StreamEvent[]) this.#deliver(raw);
      } else if (isSessionExpired(response.status, body)) {
        await this.#refreshSession().catch(() => undefined);
      } else {
        const retryAfter = Number(response.headers.get("Retry-After"));
        if (retryAfter > 0) delay = Math.max(delay, retryAfter * 1000);
      }
    } catch {
      // Offline or aborted: try again on the next tick.
    } finally {
      if (this.#pollController === controller) this.#pollController = null;
    }
    if (this.#polling && !controller.signal.aborted) {
      this.#pollTimer = setTimeout(() => {
        this.#pollTimer = null;
        if (this.#polling) void this.#poll();
      }, delay);
    }
  }
}
