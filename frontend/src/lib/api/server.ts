/**
 * Server-only API client for React Server Components and route handlers. Import it only
 * from server code: it reads the incoming request's cookies with `cookies()` from
 * `next/headers` (async since Next.js 15:
 * https://nextjs.org/docs/app/api-reference/functions/cookies), which also opts the route
 * into dynamic rendering, so a visitor's data is never cached for another visitor.
 *
 * It never bootstraps: only the browser may call `GET /world`, because a world created here
 * would set a cookie the browser never receives (deps.py `current_world`). Without a cookie,
 * calls fail with `ApiError` 401 `world_required`; render client-side in that case.
 */
import { cookies } from "next/headers";

import { forwardedCookieHeader, type CookieReader } from "../session";
import {
  createApi,
  serverBaseUrl,
  type ApiClient,
  type FetchFn,
} from "./client";

/** Headers that carry the visitor's world/session cookies to the backend. */
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
