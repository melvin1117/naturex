/**
 * The one typed API client. Types come from the generated schema.d.ts (never hand-edit it;
 * run ./scripts/generate-client.sh).
 *
 * - Browser: base URL `/api`, the same-origin proxy in next.config.ts, so the HttpOnly
 *   `nx_session` cookie is first-party and sent automatically. Every request first waits for
 *   the world bootstrap (`GET /world`, single-flight). A 401 `auth_required` on a request
 *   sent signed in re-reads the world; only GET and HEAD are then retried, once.
 * - Server (RSC, route handlers): use `createServerApi()` from `./server`, which calls
 *   `BACKEND_URL` directly and forwards the visitor's session cookies.
 */
import createClient, { type Client, type Middleware } from "openapi-fetch";

import {
  BOOTSTRAP_PATH,
  createSessionBootstrap,
  isSessionExpiredResponse,
  type SessionBootstrap,
} from "../session";
import { unwrap } from "./errors";
import type { paths } from "./schema";

export type ApiClient = Client<paths>;
export type FetchFn = (input: Request) => Promise<Response>;

export function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function serverBaseUrl(): string {
  return process.env.BACKEND_URL ?? "http://localhost:8000";
}

/**
 * Browser code goes through the same-origin `/api` proxy (next.config.ts) so the
 * `nx_session` cookie is sent. Server code calls the backend directly and must
 * forward the visitor's cookie itself (see ./server.ts).
 */
export function defaultBaseUrl(): string {
  return isBrowser() ? "/api" : serverBaseUrl();
}

// Late-bound so tests can replace globalThis.fetch after this module is imported.
const globalFetch: FetchFn = (input) => globalThis.fetch(input);

/** Methods safe to replay: they never change anything (RFC 9110 §9.2.1). */
const RETRYABLE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * openapi-fetch middleware (https://openapi-ts.dev/openapi-fetch/middleware-auth): wait for
 * the world before every request.
 *
 * A 401 `auth_required` on a request sent signed in (`world.me` set) means the session ended,
 * so the world is read again (`world.me` becomes null and screens show it). A GET or HEAD is
 * then retried once, straight to `fetch` so a second 401 is returned instead of looping. Other
 * methods are never replayed: the retry could run under a different account (signed in from
 * another tab), so their 401 goes to the caller. An anonymous 401 is expected (anonymous
 * visitors are read-only) and costs no extra request.
 */
export function worldMiddleware(session: SessionBootstrap): Middleware {
  const pending = new Map<
    string,
    { retry: Request | null; generation: number; signedIn: boolean }
  >();
  return {
    async onRequest({ request, schemaPath, id }) {
      const isBootstrap =
        schemaPath === BOOTSTRAP_PATH && request.method === "GET";
      if (!isBootstrap) await session.ensure();
      pending.set(id, {
        retry: RETRYABLE_METHODS.has(request.method) ? request.clone() : null,
        generation: session.generation,
        signedIn: session.getSnapshot().world?.me != null,
      });
      return undefined;
    },
    async onResponse({ response, id, options }) {
      const entry = pending.get(id);
      pending.delete(id);
      if (!entry?.signedIn || !(await isSessionExpiredResponse(response))) {
        return undefined;
      }
      await session.refresh(entry.generation).catch(() => undefined);
      return entry.retry ? options.fetch(entry.retry) : undefined;
    },
    onError({ id }) {
      pending.delete(id);
      return undefined;
    },
  };
}

export interface CreateApiOptions {
  baseUrl?: string;
  fetch?: FetchFn;
  /** Extra headers on every request, e.g. the forwarded `Cookie` on the server. */
  headers?: Record<string, string>;
  /** World bootstrap: defaults to `browserSession` in the browser and none on the server. */
  session?: SessionBootstrap | null;
  cache?: RequestCache;
}

export function createApi(options: CreateApiOptions | string = {}): ApiClient {
  const opts = typeof options === "string" ? { baseUrl: options } : options;
  const session =
    opts.session === undefined
      ? isBrowser()
        ? browserSession
        : null
      : opts.session;
  const client = createClient<paths>({
    baseUrl: opts.baseUrl ?? defaultBaseUrl(),
    credentials: "same-origin",
    fetch: opts.fetch ?? globalFetch,
    headers: opts.headers,
    cache: opts.cache,
  });
  if (session) client.use(worldMiddleware(session));
  return client;
}

/** A world bootstrap that calls `GET {baseUrl}/world` (a bare client, so no recursion). */
export function createBrowserSession(
  baseUrl = "/api",
  fetch: FetchFn = globalFetch,
): SessionBootstrap {
  const bare = createClient<paths>({
    baseUrl,
    credentials: "same-origin",
    fetch,
  });
  return createSessionBootstrap(() => unwrap(bare.GET(BOOTSTRAP_PATH)));
}

/** The browser's single world bootstrap, shared by `api` and the React data layer. */
export const browserSession: SessionBootstrap = createBrowserSession();

/** World-aware in the browser. On the server prefer `createServerApi()` (forwards cookies). */
export const api: ApiClient = createApi();
