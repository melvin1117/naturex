# ADR-0005: Accounts, roles and two app experiences

## Status
Proposed (2026-10-06). Changes [pm-spec](../specs/pm-spec.md) §2–§5 and Epic J, [dev-spec](../specs/dev-spec.md) §5, §6, §11 and §15, and [demo-plan](../specs/demo-plan.md) §3. Builds on T31 (per-visitor sandbox worlds).

## Date
2026-10-06

## Context
- **The judge tour is a showcase, not the product.** The real flows have to exist on their own:
  - a community registers, lists land, gets it rated, launches an IPO and manages its wallet;
  - investors sign up, buy and sell, and follow their holdings;
  - an operator runs re-ratings and handles abuse.
- **What exists today:**
  - every request is scoped to a per-visitor sandbox world (T31, `nx_world` cookie);
  - "who is acting" is a persona key with no credentials;
  - there are no authorization checks, so any visitor can act as any role;
  - T17 (#81) hardcodes the acting persona.
- **Two audiences with different jobs:** communities manage land and money, and investors browse and trade. One mixed navigation serves neither well.
- **Constraints:**
  - free tiers only;
  - hosting undecided (T20);
  - the browser reaches the API through the Next.js `/api` proxy, so cookies are first-party;
  - SSE (T29) authenticates with cookies, because `EventSource` can't send headers.

## Decision

### 1. Identity and sessions belong to the backend
- **Sign-in:** email and password, handled by FastAPI. Passwords are hashed with **argon2id via `pwdlib`**, as the FastAPI security tutorial recommends (https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/#password-hashing). An unknown email still runs a dummy-hash verify, so response time doesn't reveal which emails exist.
- **Sessions are server-side**, not JWTs:
  - a random 256-bit token (`secrets.token_urlsafe(32)`) is set in the `nx_session` cookie;
  - only its SHA-256 hash is stored, in `sessions`, with the session's `world_id` and `user_id`;
  - logout deletes the row and clears the cookie; logout and admin revocation take effect immediately, including on open SSE streams, which recheck the session on every poll and heartbeat.
- **Cookie:** `HttpOnly`, `Secure` outside development and test, `SameSite=Lax`, `Path=/`.
- **Session lifetime:**
  - Expiry: 7 days idle, 30 days absolute.
  - Demo sessions end with their sandbox world (7 days unseen).
  - A new session ID is issued on login; a persona switch revokes the old token and issues a new one.
- **CSRF:** `SameSite=Lax`, plus a check on every state-changing request (POST, PUT, PATCH, DELETE, multipart uploads included):
  - `Origin`, or failing that `Referer`, must match `ALLOWED_ORIGINS` exactly (scheme, host and port);
  - requests where both are absent, malformed or `null` are rejected;
  - JSON routes reject anything that isn't a JSON media type.
- **Rate limits:** stored in Postgres (`auth_attempts`), so they hold across instances and serverless.
  - **Two independent buckets:** per IP, and per account. The account key is an HMAC of the normalised email with `AUTH_RATE_LIMIT_SECRET`, so a guessed email can't be matched against the table.
  - **Client IP:** taken only through the configured trusted-proxy chain (`TRUSTED_PROXY_HOPS`); `X-Forwarded-For` is otherwise ignored.
  - **Atomic counting:** under an advisory lock; rows older than 24 h are pruned with expired sessions.
  - **Limits:** login 10 per 15 minutes per bucket; registration 5 per hour per IP.
  - Login errors are generic: "Email or password is incorrect".
- **Accepted risk, registration enumeration:** without email verification, registering an email that already exists reveals that it exists, however generic the error. For a play-money hackathon we accept this and say so. Email is therefore **never a claim of identity**: no permission depends on which email someone registered with.
- **Admins:** live-world admins are created only by a CLI command run by an operator (`python -m app.cli create-admin`, password read with `getpass`, never on the command line), before the public launch. Never through the API, and never by matching a registered email, because emails aren't verified. Demo admin personas exist only inside sandbox worlds.
- **Out of scope for the hackathon:** email verification, password reset by email (an admin CLI reset instead), MFA, OAuth sign-in (a *Could*) and KYC.

### 2. Worlds: one live world plus demo sandboxes
- **The live world** is one persistent world, labelled `live`. Real accounts, communities, listings, orders and payouts live there.
  - Anonymous visitors browse it read-only.
  - It's seeded with the 3 curated sites, owned by seeded demo communities whose accounts are personas with no password, so nobody can sign in as them. That way the market isn't empty on day one.
- **Sandbox worlds** (T31) stay for demos: a private copy of the template per demo session, with personas, holdings and assets.
- **`world_id` comes from the session**, never from a client-supplied value:
  - an anonymous request reads the live world;
  - a password session uses the live world;
  - a demo session uses its sandbox world.
- **Users stay world-scoped:** a real person has one live account and can start any number of demo sessions. We don't add a global accounts table.

### 3. Roles and authorization
- **Any signed-in user can invest.** No role is needed to trade.
- **Account kinds:** `users.kind` is `person` (signs in with a password), `persona` (demo or seeded, no password) or `treasury` (never signs in, never trades).
- **Community roles come from membership:** `communities` and `community_members(role: owner | steward)`. An asset belongs to one community (`assets.community_id`).
- **Tenant isolation is enforced by the database, not only by code:**
  - `communities`, `community_members` and `sessions` carry `world_id NOT NULL`;
  - their references are composite foreign keys `(world_id, …_id)`, backed by unique `(world_id, id)` on users, assets and communities, so a row can't link across worlds;
  - email is unique per world (a partial unique index on lower(email)).
  - **Owner:** the user who registers the community. They manage members and launch the IPO.
  - **Stewards:** members who manage listings and evidence.
  - **Treasury:** each community gets one `treasury` account when it's created. `assets.community_user_id` points to it. The IPO launch seeds its retained-stake holding in the same transaction, so quarterly payouts (T41) work for every real community. The Steward home shows IPO proceeds and community-fund payouts (`community_wallet`) and the treasury's retained-stake dividends as separate totals.
- **Admins:** `users.is_admin`, scoped to their world. A demo persona with admin rights is admin only inside its own sandbox, so the Time Machine can't touch the live world.
- **The policy is pure and tested.** `app/authz.py` has `authorize(principal, action, resource) -> Allow | Deny(reason)`, covered by a test of every role × action, and routes call it through a `require(action)` dependency. Every mutating route must declare one; a test walks `app.routes` and fails if any route doesn't.
- **Errors:** 401 `auth_required` without a session; 403 with a reason code (e.g. `owner_only`, `insider_trading_blocked`) when the resource is visible but the action isn't allowed; 404 for anything in another world, so nothing reveals that it exists. **Reads count too:** every route, GET included, loads resources by `(world_id, id)` before authorizing, and a route-inventory test plus a cross-world test per object endpoint keep it that way.
- **Rules that aren't just roles:**
  - **No insider trading:** members of a community can't trade its asset's shares; the retained stake earns dividends. Adding a member who already holds that asset's shares is refused (409 `member_has_holdings`), so nobody gets trapped in a position. Admins and treasury accounts can't trade at all; an operator who wants to invest uses a separate account.
  - Orders always use the principal's user and ignore any user ID from the client.
  - The ledger tamper demo runs only in sandbox worlds with `DEMO_MODE`, never in the live world.

| Action | Anonymous | Signed-in user | Community steward (own community) | Community owner (own community) | Admin (own world) |
|---|---|---|---|---|---|
| Browse marketplace, asset, reports, prices, ledger, verify, agent trace | ✅ (live world) | ✅ | ✅ | ✅ | ✅ |
| Buy or sell shares | ❌ | ✅ (asset trading) | ❌ own asset | ❌ own asset | ❌ |
| Portfolio, alerts, Copilot | ❌ | ✅ (own) | ✅ | ✅ | ✅ |
| Create a community | ❌ | ✅ (becomes owner) | ✅ | ✅ | ✅ |
| Draft or edit a listing, submit for rating, upload evidence | ❌ | ❌ | ✅ | ✅ | ❌ (suspend only) |
| Launch the IPO, manage members, edit the community | ❌ | ❌ | ❌ | ✅ | ❌ |
| Wallet, holders, payouts | ❌ | ❌ | ✅ | ✅ | ✅ (read) |
| Time Machine, inject events, suspend or resume an asset | ❌ | ❌ | ❌ | ❌ | ✅ |
| Ledger tamper demo | ❌ | ❌ | ❌ | ❌ | ✅ sandbox only |
| Reset my demo, switch persona | ❌ | demo sessions only | demo sessions only | demo sessions only | demo sessions only |

### 4. Judges get one-click demo sessions
- **`/judge` is the landing page**, linked from Devpost, the README and the "Try the demo" button. One click on *Explore as a community steward*, *Explore as an investor* or *Explore as the platform admin* calls `POST /demo/start {persona}`. That creates a sandbox world and a demo session, and opens the matching app.
- **Reset keeps you signed in:** "Reset my demo" keeps persona user IDs (mapped by `persona_key`) and recreates everything else, so the session stays valid. Pruning a stale world deletes its sessions first.
- **Demo bar:** a persistent bar reads "Demo mode · private sandbox", with a persona switcher (`POST /demo/persona`, demo sessions only) and "Reset my demo".
- **The guided tour (T45) is an optional overlay** on demo mode. It isn't the product.
- **Real accounts are still available:** judges can choose "Create a real account" to try real sign-up in the live world. No shared passwords are published.
- **The world-creation cap stays:** at most `SANDBOX_MAX_NEW_WORLDS_PER_HOUR`.

### 5. Two experiences in one Next.js app
| App | Routes | For | Main screens |
|---|---|---|---|
| **NatureX Exchange** | `/` (route group `(exchange)`) | Investors, everyone | Marketplace, asset page with trade panel, portfolio and impact, alerts, Copilot |
| **NatureX Steward** | `/steward` (route group `(steward)`) | Community owners and stewards | Community home (wallet, IPO proceeds, holders, payouts, alerts, stewardship actions), communities and members, list land (`/steward/list`), listing status, evidence upload, IPO launch |
| Control room | `/admin` | Admins | Time Machine, event presets, suspend or resume |
| Access | `/login`, `/register`, `/judge` | Everyone | Sign in, sign up, one-click demo |

- **What's shared:** one design system (T21), one generated API client, one session and one deployment. Each app has its own shell and navigation. An app switcher appears for users who belong to a community, and asset pages link between the two apps.
- **A split host can come later** (`steward.<domain>` rewritten to `/steward` by Next.js middleware) if hosting needs it. That would need the cookie scoped to the parent domain. It isn't needed for the hackathon.

### 6. Privacy
- **What we collect:** email, display name and a password hash, for sign-in only.
- **Where it never goes:**
  - emails never go into ledger payloads, LLM prompts or logs;
  - `auth_attempts` stores only an HMAC of the email;
  - **the public ledger contains no account identifiers at all.** User UUIDs are pseudonymous personal data, and the ledger is public and append-only. Payout entries record aggregates (revenue, community fund, dividends total, holder count) plus a hash commitment of the per-holder lines, which live in a private, erasable `payout_lines` table (T67). Today's T41 entries list per-holder payouts, which is fine in sandboxes but not for real accounts.
- **Retention:**
  - demo worlds are pruned after 7 days;
  - expired sessions and old `auth_attempts` rows are pruned;
  - `DELETE /me` (*Should*) deletes credentials and sessions and pseudonymises the name. Holdings and orders stay, linked to the anonymised user, so the market history stays consistent.

## Consequences
- **T31:** the `nx_world` cookie is retired. `CurrentWorld` is derived from the session, and `GET /world` returns the session's world.
- **Schema:** `users` gains `email`, `password_hash` and `is_admin`. `users.role` stays as a persona label but is no longer used for authorization. New tables: `communities`, `community_members`, `sessions`, `auth_attempts`, plus `assets.community_id`.
- **T17 (#81)** keeps its persona placeholder until T54/T56 land; T57 then moves every route onto the principal.
- **New tasks:** T54–T68 (`tasks/todo.md`, issues #97–#111). The listing lifecycle, IPO launch, live rating of new listings and the quarterly revenue split (D4) become *Must*, because real listings and the Steward home can't work without them.
- **Scope kept small:** communities are owner-only for the *Must*; adding and removing stewards is a *Should*.
- **Who may list which land** is handled by [ADR-0006](./0006-listing-verification.md): a visible verification checklist and reviewer decision, required before a live-world IPO.
- **Existing tasks that move:**
  - T18, T22 and T23 move into the Exchange app.
  - T33 moves into the Steward app.
  - T43 becomes admin-only.
  - T45 builds on `/judge`.
  - T46 covers both the real-account path and the demo path.
  - P02–P06 cover both apps, the sign-in screens, the Steward home and the judge landing.
- **Every task here touching auth, cookies, sessions or authorization gets a `security-and-hardening` review before its PR** (AGENTS.md step 4).

## Alternatives considered
- **JWT bearer tokens in browser storage:**
  - any XSS can read them;
  - they can't be revoked server-side;
  - `EventSource` can't send an `Authorization` header.

  Rejected.
- **Auth.js (NextAuth) in the frontend:**
  - authentication would live in Next.js while every decision lives in FastAPI;
  - the backend would have to verify tokens issued by Next.js;
  - that's two sources of truth.

  Rejected.
- **Hosted auth (Supabase Auth, Clerk):**
  - Pros: OAuth and password-reset email out of the box.
  - Cons: it adds a vendor that processes personal data, ties us to a host before T20, and still needs JWT verification in FastAPI.

  Kept as the path for OAuth later.
- **The `fastapi-users` library (MIT):**
  - Pros: it covers registration and login.
  - Cons: its user model and routers clash with world-scoped users and demo sessions.
  - A small module (pwdlib plus a sessions table, about 200 lines) with thorough tests is easier to audit.
- **Two separate Next.js apps:** double the builds, CI and deploys, and they'd need cross-subdomain cookies. Rejected; route groups give the same separation.
- **A global accounts table across worlds:** it would complicate the world isolation that T31 relies on, for no user-visible gain. Rejected.
