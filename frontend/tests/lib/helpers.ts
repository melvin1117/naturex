import { vi } from "vitest";

import type { MyCommunity, WorldOut } from "@/lib/api/types";

export const BASE = "http://test.local/api";

export const WORLD: WorldOut = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "demo-1",
  created_at: "2026-10-07T00:00:00Z",
  personas: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      key: "investor",
      name: "Ana",
      role: "investor",
      cash_balance: "10000.00",
    },
  ],
  assets: [],
  me: null,
};

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

/** WORLD as seen by a signed-in account (`me` set). */
export const SIGNED_IN_WORLD: WorldOut = {
  ...WORLD,
  me: {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Rosa",
    email: "rosa@example.org",
    kind: "person",
    is_admin: false,
    world_id: WORLD.id,
  },
};

export const authRequired = () =>
  json({ detail: "auth_required" }, { status: 401 });

/** WORLD as seen by a platform admin. */
export const ADMIN_WORLD: WorldOut = {
  ...WORLD,
  me: {
    id: "55555555-5555-4555-8555-555555555555",
    name: "Ops",
    email: "ops@example.org",
    kind: "person",
    is_admin: true,
    world_id: WORLD.id,
  },
};

/** One row of `GET /me/communities`. */
export function community(overrides: Partial<MyCommunity> = {}): MyCommunity {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    name: "Selva Viva",
    country: "MX",
    description: null,
    created_at: "2026-10-18T00:00:00Z",
    role: "owner",
    ...overrides,
  };
}

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * A fake backend: routes are "METHOD /path" (path after BASE, without the query string).
 * Records every request so tests can count calls and inspect headers and bodies.
 */
export function fakeBackend(routes: Record<string, Handler>) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    requests.push(request.clone());
    const url = new URL(request.url);
    const path = url.pathname.replace(new URL(BASE).pathname, "");
    const handler = routes[`${request.method} ${path}`];
    if (!handler) return json({ detail: "Not Found" }, { status: 404 });
    return handler(request);
  });
  const calls = (route: string) =>
    requests.filter((r) => {
      const url = new URL(r.url);
      const path = url.pathname.replace(new URL(BASE).pathname, "");
      return `${r.method} ${path}` === route;
    }).length;
  return { fetch, requests, calls };
}

/** Respond with each handler in turn; the last one repeats. */
export function sequence(...handlers: Handler[]): Handler {
  let index = 0;
  return (request) => {
    const handler = handlers[Math.min(index, handlers.length - 1)]!;
    index += 1;
    return handler(request);
  };
}

type Listener = (event: MessageEvent<string>) => void;

/** A controllable stand-in for the browser's EventSource. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  static latest(): FakeEventSource {
    const latest = FakeEventSource.instances.at(-1);
    if (!latest) throw new Error("no EventSource created");
    return latest;
  }

  static reset() {
    FakeEventSource.instances = [];
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  open() {
    this.readyState = 1;
    this.#dispatch("open", new MessageEvent("open"));
  }

  /** Simulate a server-sent event, as `format_sse` writes it. */
  emit(type: string, id: number | null, payload: Record<string, unknown> = {}) {
    const data = JSON.stringify({
      id,
      type,
      payload,
      ts: "2026-10-07T00:00:00Z",
    });
    this.#dispatch(
      type,
      new MessageEvent(type, {
        data,
        lastEventId: id === null ? "" : String(id),
      }),
    );
  }

  /** readyState 0 = browser will reconnect; 2 = gave up (non-200 such as a 503). */
  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.#dispatch("error", new MessageEvent("error"));
  }

  #dispatch(type: string, event: MessageEvent<string>) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

export const createFakeEventSource = (url: string) => new FakeEventSource(url);
