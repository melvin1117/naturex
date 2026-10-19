/**
 * Server-only API client for React Server Components and route handlers. Import it only
 * from server code: it reads the incoming request's cookies with `cookies()` from
 * `next/headers` (async since Next.js 15:
 * https://nextjs.org/docs/app/api-reference/functions/cookies), which also opts the route
 * into dynamic rendering, so a visitor's data is never cached for another visitor.
 *
 * It never bootstraps or retries: the browser owns the world snapshot. Without a session,
 * reads see the live world and signed-in-only calls fail with `ApiError` 401 `auth_required`
 * (deps.py `current_world`); render those parts client-side.
 */
import { cookies } from "next/headers";

import { forwardedCookieHeader, type CookieReader } from "../session";
import {
  createApi,
  serverBaseUrl,
  type ApiClient,
  type FetchFn,
} from "./client";

/** Headers that carry the visitor's session cookie to the backend. */
export function forwardedHeaders(store: CookieReader): Record<string, string> {
  const cookie = forwardedCookieHeader(store);
  return cookie ? { Cookie: cookie } : {};
}

export async function createServerApi(
  options: { fetch?: FetchFn } = {},
): Promise<ApiClient> {
  const store = await cookies();
  return createApi({
    baseUrl: serverBaseUrl(),
    headers: forwardedHeaders(store),
    session: null,
    cache: "no-store",
    fetch: options.fetch,
  });
}
