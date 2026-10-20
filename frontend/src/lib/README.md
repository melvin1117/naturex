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

| Hook                                                          | Returns                                                                              | Notes                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `useWorld()`                                                  | `world`, `personas`, `assets`, `status`, `resetWorld()`, `isResetting`, `resetError` | "Reset my demo" refetches every query. Persona cash is a snapshot; use `usePortfolio` for live cash.                                       |
| `useAssets()`                                                 | `AssetCard[]`                                                                        | Live: refetches on `price_tick`.                                                                                                           |
| `useAsset(id)`                                                | `AssetDetail`                                                                        | Skips while `id` is undefined. Live: `price` updates at once from `price_tick`, then the asset refetches.                                  |
| `useReport(id)`                                               | `ReportOut`                                                                          |                                                                                                                                            |
| `useAssetReports(id)`                                         | `ReportOut[]`                                                                        | Newest first. Live: refetches when a rating run ends (`rating_progress` step `done`) and on a `rerate` tick.                               |
| `useAssetPrices(id)`                                          | `PricePoint[]`                                                                       | Oldest first. Live: refetches on `price_tick`.                                                                                             |
| `useLedger(id)` / `useVerifyLedger(id)`                       | `LedgerEntry[]` / `mutate()` → `LedgerVerify`                                        | Verify asks the backend to recompute the chain, then the entries refetch.                                                                  |
| `useSiteImages(siteKey)`                                      | `SiteImages`                                                                         | A demo site's overlay bounds, legend, date windows and attributions; skips without a key.                                                  |
| `usePortfolio()`                                              | `PortfolioOut`                                                                       | Live: refetches on `price_tick`.                                                                                                           |
| `useMyCommunities()`                                          | `MyCommunity[]` (id, name, role `owner` \| `steward`)                                | `GET /me/communities`; idle for anonymous visitors. The shells use it to pick the apps to offer.                                           |
| `usePlaceOrder()`                                             | `mutate(order)`, `data` (`OrderOut`), `error`, `isPending`                           | Refetches the portfolio, the asset, its prices, its quotes and the market list. Never retried.                                             |
| `useQuote(id, side, qty)`                                     | `QuoteOut`                                                                           | The backend's price for an order now (T18). Skips until `qty` is a positive integer. Live: `price_tick`.                                   |
| `useIpoPreview(id, shares, retainedPct)`                      | `IpoPreview`                                                                         | T64: each IPO formula term, `launchable`, `blocked_reason`. Idle until inputs are valid. Live: run ends.                                   |
| `useLaunchIpo(id)`                                            | `mutate({ total_shares, retained_pct, expected_price })`, `data` (`IpoOut`)          | `expected_price` = the preview's `ipo_price` (else 409 `ipo_price_changed`). Never retried.                                                |
| `useVerificationPanel(id)` (`verification-hooks.ts`)          | `VerificationPublic`                                                                 | T70: "How this listing was verified": the API's badge, level, dates, reviewer role, check results, not-checked list, ledger entry. Public. |
| `useVerificationRuns(id)` / `useListingDocuments(id)`         | `VerificationRun[]` / `ListingDocument[]`                                            | The community's members and same-world admins (404 otherwise). Runs newest first, with checklist values and reasons.                       |
| `useDocumentPreview(id, doc)`                                 | `{ url, error, isLoading }`                                                          | The sanitised PNG preview as a blob URL (revoked on unmount); idle when `has_preview` is false.                                            |
| `useUploadDocument(id)` / `useSubmitVerification(id)`         | `mutate({ file, docType })` / `mutate(documentIds)`                                  | The upload body is the file itself. Submitting refetches the listing's verification, asset, ledger, IPO previews and the queue.            |
| `useReviewQueue(offset, limit)` / `useDecideVerification(id)` | `ReviewQueueItem[]` / `mutate({ decision, runId, reason })`                          | Admins. `decision`: `approve` (optional note), `reject` or `revoke` (reason required). Never retried.                                      |
| `useLiveEvent(type, handler)`                                 |                                                                                      | Runs `handler` for each new `rating_progress`, `price_tick` or `alert`.                                                                    |
| `useEvents()`                                                 | `subscribe(type, handler)`, `transport`                                              | `transport` is diagnostics only.                                                                                                           |
| `useApiQuery(key, fetcher)` / `useApiMutation(fn)`            |                                                                                      | For any other endpoint; see below.                                                                                                         |

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

## App shells and roles (T62)

`app/(exchange)`, `app/steward` and `app/admin` each have a layout with the shell header (`components/shell/app-header.tsx`; the prototype's Copilot, Agent Trace and alerts go in its `tools` slot from `components/proto/header-tools.tsx`) and a `<main id="main">` that the skip link in `app/layout.tsx` jumps to (standalone pages such as `/login` and `/judge` have one too). The root layout also holds the demo bar slot (T65): the sandbox notice on every page, plus the scripted demo's controls for anonymous visitors.

What the header offers comes from `appAccess()` in `navigation.ts` (pure, unit-tested), through `useAppAccess()` (`components/shell/app-switcher.tsx`):

| Visitor                    | Apps offered                                | Also                                                                           |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Anonymous                  | Exchange                                    | Steward app too in the scripted prototype demo (T61)                           |
| Signed in, no community    | Exchange                                    | "Create a community" → `/steward`, whose empty state has the create form (T63) |
| Community owner or steward | Exchange, Steward app                       | Community switcher in the Steward header if more than one                      |
| Platform admin             | Exchange, Admin (+ Steward app if a member) | "Create a community" without one                                               |

Nothing that depends on `/me/communities` shows until it answers; if it fails, signed-in accounts still get the Steward app link, whose error screen explains and retries. This only decides what the UI shows: the backend authorizes every request (a non-admin on `/admin` gets `RequireAccount`'s 403 message, and every admin route checks `is_admin`).

Steward pages read the community they show with `useStewardCommunity()` (`components/shell/steward-community.tsx`): `{ communities, active, select(id), href(path) }`. The `?community=<id>` URL parameter wins, then the one remembered for this account (`localStorage` key `nx-steward-community:<account id>`, only the ID, cleared on sign-out; `lib/active-community.ts`), then the account's first community; each only if `/me/communities` lists it. `select` puts the choice in the URL and remembers it; build Steward links with `href("/steward/...")` so they keep the parameter, which lets pages link to a community and keeps two tabs from disagreeing. `<StewardGate>` shows a signed-in account without a community the "Start a community" empty state, with the create form (T63), instead of the pages.

`useMyCommunities()` is cached per account (`queryKeys.myCommunities(me.id)`) and never fetched while signed out. **Roles change only when this query refetches:** anything that creates, joins or leaves a community (T63's create form, adding or removing a steward) must invalidate it, e.g. `onSuccess: (_d, _v, { cache }) => cache.invalidate(queryKeys.myCommunities(meId))`, or the header keeps the old roles until the next page load.

## Steward home and communities (T63)

`lib/community-hooks.ts` (kept out of `hooks.ts` so parallel Steward tasks don't collide):

| Hook                                              | Returns                         | Notes                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useCommunitySummary(id)`                         | `CommunitySummary`              | `GET /communities/{id}/summary`: listings and `next_action`, wallet, holders (never named), payouts, recommendations. Live: trades (one refetch per 3 s burst), runs, status. |
| `useCommunity(id)`                                | `CommunityOut`                  | `GET /communities/{id}`: the profile, for the settings form.                                                                                                                  |
| `useCommunityMembers(id)`                         | `CommunityMember[]`             | Members and same-world admins only.                                                                                                                                           |
| `useCreateCommunity()` / `useUpdateCommunity(id)` | `mutate(body)` → `CommunityOut` | Both invalidate `myCommunities(meId)` (and, on edit, every `queryKeys.community(id)` query), so the header and switcher follow.                                               |
| `useAddSteward(id)` / `useRemoveMember(id)`       | `mutate(userId)`                | By account ID; removing yourself (leaving) also refreshes `myCommunities`.                                                                                                    |

`lib/community.ts` has the pure helpers: `validateCommunity` (the backend's name, country and description rules), `communityFailure` / `memberFailure` (409 `community_name_taken`, `community_limit_reached`, 422 field errors…), and `listingAction(next_action, assetId, communityId, status)`, the one place that knows the Steward links: the listing flow `/steward/list?community=<id>&asset=<id>` (T33, resumes that listing), the IPO screen `/steward/assets/<id>/ipo?community=<id>` (T64) and the public page `/asset/<id>`. Stewards are added by account ID: `<AccountIdCopy>` (`components/account-id.tsx`) shows the signed-in account's ID with Copy on the "Start a community" state and the settings page, and the account menu has "Copy account ID" everywhere.

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
| `navigation.ts`                       | The apps, their navigation and `appAccess()`: which apps a visitor is offered (T62).                                                                                                        |
| `trade.ts`                            | Trade panel helpers (T18): units input, validation against the quote and portfolio, order error messages, money and per-unit formatting, `assetHref`. Parses API decimals for display only. |
| `report-facts.ts`                     | `reportFacts(ReportOut)`: the report card's numbers from the stored report and its `rating` snapshot (null when missing, never made up).                                                    |
| `ipo.ts`, `use-ipo-offer.ts`          | IPO launch screen (T64): offering bounds (tested against `openapi.json`), parsing, refusals in words; `useIpoOffer` debounces the preview and decides what can launch.                      |
| `use-debounced.ts`                    | `useDebounced(value, ms)`: a value once it stops changing (trade quotes, IPO previews). Memoize objects and tuples.                                                                         |
| `market-cards.ts`, `asset-detail.ts`  | Marketplace cards (sort, grade filter, media-route thumbnails) and asset-page helpers (boundary, prices, events).                                                                           |

## The listing flow (T33)

`/steward/list?community=<id>[&asset=<id>]` is `components/listing/` (one file per step, `listing-screen.tsx` ties them together). Its pure helpers are `lib/listing/` (unit-tested): `boundary.ts` (GeoJSON in and out, typed coordinates, hints that mirror T36 and stay cheap on big boundaries), `details.ts`, `errors.ts` (`listingFailure()` for every T58 error code and T36's 422 problems), `pipeline.ts` (`pipelineView()`), `outcome.ts` (`listingOutcome()`), `links.ts` and `draft-storage.ts` (a new listing kept in `sessionStorage` per account and community until it's saved, so a sign-in or reload doesn't lose it).

| Hook                                                                                 | Calls                                                                      | Notes                                                                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `useCreateListing()`, `useUpdateListing()`, `useSubmitListing()`, `useLeaveReview()` | `POST /assets`, `PATCH /assets/{id}`, `…/submit`, `…/revise`, `…/withdraw` | Each caches the listing it gets back (`setData(…, { seed: true })`); send only changed fields to `PATCH`.       |
| `useRatingRun(runId)`                                                                | `GET /runs/{id}`                                                           | Refetched on each of its `rating_progress` events and every 10 s while active (a dead run only reads as stale). |
| `useRefreshListing()`                                                                | —                                                                          | Refetch a listing and its ledger, e.g. when its run ended without a `listing_status` event reaching this tab.   |
| `useAssetOutlines()`                                                                 | `GET /assets/outlines`                                                     | Public sites' boundaries simplified on the server; fetched once per tab, refetched when a site is listed.       |

The pipeline is only ever what `GET /runs/{id}` rebuilds: live events trigger refetches (coalesced by `wireLiveUpdates`), so duplicates, replays and their order don't matter. The run to follow is the one just submitted, else the listing's `latest_run_id` (members and admins, listings under review only); an event from another run of the listing re-reads the listing to learn which run is latest.
