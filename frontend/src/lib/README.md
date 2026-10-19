# `src/lib`: the frontend data layer (T32)

Screens stay presentational: they call a hook and render `data`, `isLoading` or `error.message`. Everything else (the sandbox world, cookies, retries, live updates) happens here.

## Setup you get for free

`app/layout.tsx` wraps every page in `<WorldProvider>` (`components/world-provider.tsx`). It calls `GET /world` **once** when the app loads and always renders the page, so server HTML, static pages and the 404 page don't depend on the backend. The backend derives the world from the `nx_session` cookie (T73): anonymous visitors and password accounts get the live world, a demo session its own sandbox; `world.me` is the signed-in account or `null`. The API client and live events wait for the world first, so screens never handle "no world yet". Anonymous visitors are read-only: unsafe requests get 401 `auth_required`.

For a section that shows world data, wrap it in `<WorldGate>`. It shows an accessible loading state until the world is ready, or an error with "Try again" if it can't be opened (e.g. the backend is down). Keep the gate around the data, not the whole page:

```tsx
import { WorldGate } from "@/components/world-provider";

<h1>Portfolio</h1>
<WorldGate>
  <Holdings /> {/* uses usePortfolio() */}
</WorldGate>
```

## Hooks (client components only)

```tsx
"use client";
import { useAsset, usePlaceOrder } from "@/lib/hooks";

export function TradePanel({ id }: { id: string }) {
  const asset = useAsset(id);
  const order = usePlaceOrder();
  if (asset.isLoading) return <Spinner />;
  if (asset.error) return <Alert>{asset.error.message}</Alert>;
  return (
    <Button
      disabled={order.isPending}
      onClick={() => order.mutate({ asset_id: id, side: "buy", qty: 1 })}
    >
      Buy at {asset.data?.price}
    </Button>
  );
}
```

| Hook                                               | Returns                                                                              | Notes                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `useWorld()`                                       | `world`, `personas`, `assets`, `status`, `resetWorld()`, `isResetting`, `resetError` | "Reset my demo" refetches every query. Persona cash is a snapshot; use `usePortfolio` for live cash.      |
| `useAssets()`                                      | `AssetCard[]`                                                                        | Live: refetches on `price_tick`.                                                                          |
| `useAsset(id)`                                     | `AssetDetail`                                                                        | Skips while `id` is undefined. Live: `price` updates at once from `price_tick`, then the asset refetches. |
| `useReport(id)`                                    | `ReportOut`                                                                          |                                                                                                           |
| `useAssetReports(id)`                              | `ReportOut[]`                                                                        | Newest first. Live: refetches after a re-rate (`price_tick` with reason `rerate`).                        |
| `useAssetPrices(id)`                               | `PricePoint[]`                                                                       | Oldest first. Live: refetches on `price_tick`.                                                            |
| `useLedger(id)` / `useVerifyLedger(id)`            | `LedgerEntry[]` / `mutate()` → `LedgerVerify`                                        | Verify asks the backend to recompute the chain, then the entries refetch.                                 |
| `useSiteImages(siteKey)`                           | `SiteImages`                                                                         | A demo site's overlay bounds, legend, date windows and attributions; skips without a key.                 |
| `usePortfolio()`                                   | `PortfolioOut`                                                                       | Live: refetches on `price_tick`.                                                                          |
| `usePlaceOrder()`                                  | `mutate(order)`, `data` (`OrderOut`), `error`, `isPending`                           | Refetches the portfolio, the asset, its prices, its quotes and the market list. Never retried.            |
| `useQuote(id, side, qty)`                          | `QuoteOut`                                                                           | The backend's price for an order now (T18). Skips until `qty` is a positive integer. Live: `price_tick`.  |
| `useLiveEvent(type, handler)`                      |                                                                                      | Runs `handler` for each new `rating_progress`, `price_tick` or `alert`.                                   |
| `useEvents()`                                      | `subscribe(type, handler)`, `transport`                                              | `transport` is diagnostics only.                                                                          |
| `useApiQuery(key, fetcher)` / `useApiMutation(fn)` |                                                                                      | For any other endpoint; see below.                                                                        |

Query results: `{ data, error, status: "idle" | "loading" | "success" | "error", isLoading, isFetching, refetch }`. While refetching, the old `data` stays and `isFetching` is true. Requests are deduped per key and aborted when the last screen using them unmounts.

Mutations: `mutate(vars)` never throws (it sets `error` and resolves `undefined`); `mutateAsync(vars)` throws the `ApiError`.

Anything else, typed from the generated client:

```ts
const prices = useApiQuery(queryKeys.prices(id), (api, signal) =>
  unwrap(
    api.GET("/assets/{asset_id}/prices", {
      params: { path: { asset_id: id } },
      signal,
    }),
  ),
);
```

Use the keys in `queryKeys` (`data-layer.tsx`) so mutations and live events refresh your data.

## Signing in (T61)

```tsx
const signIn = useSignIn(); // also useRegister(), useSignOut()
await signIn.mutateAsync({ email, password }); // then world.me is the account
```

Each calls the auth route, then re-reads `GET /world` (`session.reload()`) and resets the cache (`QueryCache.reset()`), so `useWorld().world.me` and every query follow the new account and nothing from the previous one stays on screen. The session is the HttpOnly `nx_session` cookie only; never store a token or `me` in browser storage.

`lib/auth.ts` has the pure helpers: `safeReturnPath(next)` (same-origin relative paths only; use it for every `?next=`), `loginHref(path)`, `validateAuthInput` and `authFailure` (form messages for 401, 409, 422, 429, 403, 503 and network errors). Wrap a page that needs an account in `<RequireAccount>` (`<RequireAccount admin>` for platform admins; `allowPrototypeDemo` only for prototype screens that the scripted demo must keep open until T65, never `/admin`); the backend still authorizes every request.

## Errors

Every failure is an `ApiError` (`api/errors.ts`): `status` (0 = offline), `code` (e.g. `auth_required`, `owner_only`), `message` (safe to show; friendly text for 401, 403, 404, 409, 422 and 503), `detail` (raw, e.g. 422 field errors) and `retryAfterSeconds`.

## Live events

`lib/events.ts` opens one `EventSource` to `/api/events/stream` while any live hook is mounted. If it's refused (503 `too_many_event_streams`, which `EventSource` reports only as an error) or keeps failing, it polls `GET /events?since_id=` every 3 s and retries SSE later with backoff. Events arrive once and in order across both transports; heartbeats are dropped. On first connect the backend replays recent events, so handlers should be idempotent (set state from the payload rather than increment).

## Server components and route handlers

```ts
import { createServerApi } from "@/lib/api/server";

const api = await createServerApi(); // BACKEND_URL + the visitor's nx_session cookie
const { data, error } = await api.GET("/portfolio");
```

It forwards only the session cookie, never calls `GET /world` (the browser owns the world snapshot) and doesn't retry. Without a session, reads see the live world and signed-in-only calls get a 401 `auth_required`: render those parts client-side with the hooks. The browser client is `api` from `@/lib/api`.

## Files

| File                                  | Role                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/schema.d.ts`, `api/openapi.json` | **Generated**: `./scripts/generate-client.sh`. Never edit.                                                                                                                                  |
| `api/client.ts`                       | The typed `openapi-fetch` client and its world middleware (wait for the world; on a signed-in 401 `auth_required` re-read it and retry GET/HEAD once).                                      |
| `api/server.ts`                       | Server-only client with cookie forwarding.                                                                                                                                                  |
| `api/errors.ts`, `api/types.ts`       | `ApiError`, `unwrap()`, schema type aliases.                                                                                                                                                |
| `session.ts`                          | World bootstrap (single-flight), the forwarded cookie, "expired" codes. Session changes (T55 demo sessions) belong here.                                                                    |
| `query.ts`                            | The small query cache behind the hooks; `reset()` when the account changes.                                                                                                                 |
| `events.ts`                           | SSE with polling fallback.                                                                                                                                                                  |
| `data-layer.tsx`, `hooks.ts`          | React context, cache wiring for live events, and the hooks.                                                                                                                                 |
| `auth.ts`                             | Sign-in helpers: safe return paths, the protected-route rule, form validation and error messages (T61).                                                                                     |
| `trade.ts`                            | Trade panel helpers (T18): units input, validation against the quote and portfolio, order error messages, money and per-unit formatting, `assetHref`. Parses API decimals for display only. |
| `dev-routes.ts`                       | `devRoutesEnabled()`: `/dev/*` harness pages are a 404 in production unless `NATUREX_DEV_ROUTES=true`.                                                                                      |
| `report-facts.ts`                     | `reportFacts(ReportOut)`: the report card's numbers from the stored report and its `rating` snapshot (null when missing, never made up).                                                    |
| `market-cards.ts`, `asset-detail.ts`  | Marketplace cards (sort, grade filter, media-route thumbnails) and asset-page helpers (boundary, prices, events).                                                                           |
