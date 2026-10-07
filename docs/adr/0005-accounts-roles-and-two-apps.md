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
  - only its SHA-256 hash is stored, in `sessions`;
  - logout and admin revocation delete the row, so they take effect immediately.
- **Cookie:** `HttpOnly`, `Secure` outside development and test, `SameSite=Lax`, `Path=/`.
- **Session lifetime:**
  - Expiry: 7 days idle, 30 days absolute.
  - Demo sessions end with their sandbox world (7 days unseen).
  - A new session ID is issued on login and on persona switch.
- **CSRF:** `SameSite=Lax`, plus a check on state-changing requests (POST, PUT, PATCH, DELETE): the request must have an `Origin` (or, failing that, `Referer`) in `ALLOWED_ORIGINS`, and JSON routes reject anything that isn't `application/json`.
- **Rate limits:** stored in Postgres (`auth_attempts`), so they hold across instances and serverless.
  - Login: 10 attempts per 15 minutes per IP plus email hash.
  - Registration: 5 per hour per IP.
  - Errors are generic, e.g. "Email or password is incorrect".
- **Admins:** granted only through `ADMIN_EMAILS` (environment) or a CLI command, never through the API.
- **Out of scope for the hackathon:** email verification, password reset by email (an admin CLI reset instead), MFA, OAuth sign-in (a *Could*) and KYC.

### 2. Worlds: one live world plus demo sandboxes
- **The live world** is one persistent world, labelled `live`. Real accounts, communities, listings, orders and payouts live there.
  - Anonymous visitors browse it read-only.
  - It's seeded with the 3 curated sites, owned by seeded demo communities whose accounts have no password, so they can't sign in. That way the market isn't empty on day one.
- **Sandbox worlds** (T31) stay for demos: a private copy of the template per demo session, with personas, holdings and assets.
- **`world_id` comes from the session**, never from a client-supplied value:
  - an anonymous request reads the live world;
  - a password session uses the live world;
  - a demo session uses its sandbox world.
- **Users stay world-scoped:** a real person has one live account and can start any number of demo sessions. We don't add a global accounts table.

### 3. Roles and authorization
- **Any signed-in user can invest.** No role is needed to trade.
- **Community roles come from membership:** `communities` and `community_members(role: owner | steward)`. An asset belongs to one community (`assets.community_id`).
  - **Owner:** the user who registers the community. They manage members and launch the IPO.
  - **Stewards:** members who manage listings and evidence.
  - `assets.community_user_id` stays as the community's treasury account: it holds the retained stake and receives its dividends (T41).
- **Admins:** `users.is_admin`, scoped to their world. A demo persona with admin rights is admin only inside its own sandbox, so the Time Machine can't touch the live world.
- **The policy is pure and tested.** `app/authz.py` has `authorize(principal, action, resource) -> Allow | Deny(reason)`, covered by a test of every role × action, and routes call it through a `require(action)` dependency. Every mutating route must declare one; a test walks `app.routes` and fails if any route doesn't.
- **Errors:** 401 `auth_required` without a session; 403 with a reason code (e.g. `owner_only`, `insider_trading_blocked`) when the resource is visible but the action isn't allowed; 404 for anything in another world, so nothing reveals that it exists.
- **Rules that aren't just roles:**
  - **No insider trading:** members of a community can't trade its asset's shares. The retained stake earns dividends.
  - Orders always use the principal's user and ignore any user ID from the client.
  - The ledger tamper demo runs only in sandbox worlds with `DEMO_MODE`, never in the live world.

| Action | Anonymous | Signed-in user | Community steward (own community) | Community owner (own community) | Admin (own world) |
|---|---|---|---|---|---|
| Browse marketplace, asset, reports, prices, ledger, verify, agent trace | ✅ (live world) | ✅ | ✅ | ✅ | ✅ |
| Buy or sell shares | ❌ | ✅ (asset trading) | ❌ own asset | ❌ own asset | ✅ |
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
  - `auth_attempts` stores a hash of the email;
  - the ledger references user IDs only.
- **Retention:**
  - demo worlds are pruned after 7 days;
  - expired sessions and old `auth_attempts` rows are pruned;
  - `DELETE /me` (*Should*) deletes credentials and sessions and pseudonymises the name. Holdings and orders stay, linked to the anonymised user, so the market history stays consistent.

## Consequences
- **T31:** the `nx_world` cookie is retired. `CurrentWorld` is derived from the session, and `GET /world` returns the session's world.
- **Schema:** `users` gains `email`, `password_hash` and `is_admin`. `users.role` stays as a persona label but is no longer used for authorization. New tables: `communities`, `community_members`, `sessions`, `auth_attempts`, plus `assets.community_id`.
- **T17 (#81)** keeps its persona placeholder until T54/T56 land; T57 then moves every route onto the principal.
- **New tasks:** T54–T65 (`tasks/todo.md`). The listing lifecycle, IPO launch and live rating of new listings become *Must*, because real listings can't work without them.
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
