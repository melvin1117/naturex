# `src/lib`: the frontend data layer (T32)

Screens stay presentational: they call a hook and render `data`, `isLoading` or `error.message`. Everything else (the sandbox world, cookies, retries, live updates) happens here.

## Setup you get for free

`app/layout.tsx` wraps every page in `<WorldProvider>` (`components/world-provider.tsx`). It calls `GET /world` **once** when the app loads and always renders the page, so server HTML, static pages and the 404 page don't depend on the backend. Requests never go out before the `nx_world` cookie exists: the API client and live events wait for the world first. Screens never handle "no world yet".

For a section that shows world data, wrap it in `<WorldGate>`. It shows an accessible loading state until the world is ready, or an error with "Try again" if it can't be opened (e.g. 503 busy). Keep the gate around the data, not the whole page:

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
| `usePortfolio()`                                   | `PortfolioOut`                                                                       | Live: refetches on `price_tick`.                                                                          |
| `usePlaceOrder()`                                  | `mutate(order)`, `data` (`OrderOut`), `error`, `isPending`                           | Refetches the portfolio, the asset, its prices and the market list.                                       |
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

## Errors

Every failure is an `ApiError` (`api/errors.ts`): `status` (0 = offline), `code` (e.g. `world_required`, `owner_only`), `message` (safe to show; friendly text for 401, 403, 404, 409, 422 and 503), `detail` (raw, e.g. 422 field errors) and `retryAfterSeconds`.

## Live events

`lib/events.ts` opens one `EventSource` to `/api/events/stream` while any live hook is mounted. If it's refused (503 `too_many_event_streams`, which `EventSource` reports only as an error) or keeps failing, it polls `GET /events?since_id=` every 3 s and retries SSE later with backoff. Events arrive once and in order across both transports; heartbeats are dropped. On first connect the backend replays recent events, so handlers should be idempotent (set state from the payload rather than increment).

## Server components and route handlers

```ts
import { createServerApi } from "@/lib/api/server";

const api = await createServerApi(); // BACKEND_URL + the visitor's nx_world cookie
const { data, error } = await api.GET("/portfolio");
```

It forwards only the session cookies, never calls `GET /world` (a world made on the server would set a cookie the browser never gets), and doesn't retry. A first-time visitor has no world yet and gets a 401 `world_required`: render that part client-side with the hooks. The browser client is `api` from `@/lib/api`.

## Files

| File                                  | Role                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `api/schema.d.ts`, `api/openapi.json` | **Generated**: `./scripts/generate-client.sh`. Never edit.                                                                           |
| `api/client.ts`                       | The typed `openapi-fetch` client and its world middleware (wait for the world; on 401 `world_required` re-bootstrap and retry once). |
| `api/server.ts`                       | Server-only client with cookie forwarding.                                                                                           |
| `api/errors.ts`, `api/types.ts`       | `ApiError`, `unwrap()`, schema type aliases.                                                                                         |
| `session.ts`                          | World bootstrap (single-flight), cookie names, "expired" codes. **T55 swaps `nx_world` for `nx_session` here only.**                 |
| `query.ts`                            | The small query cache behind the hooks.                                                                                              |
| `events.ts`                           | SSE with polling fallback.                                                                                                           |
| `data-layer.tsx`, `hooks.ts`          | React context, cache wiring for live events, and the hooks.                                                                          |
