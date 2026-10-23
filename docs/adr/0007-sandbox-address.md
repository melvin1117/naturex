# ADR-0007: The sandbox gets its own address, and the homepage stays a homepage

## Status
Accepted (2026-10-23). Amends [ADR-0005](./0005-accounts-roles-and-two-apps.md) §1 (sessions), §4 (judge demo sessions) and §5 (routes). Changes [pm-spec](../specs/pm-spec.md) story C5, [dev-spec](../specs/dev-spec.md) §5 and §15, and [demo-plan](../specs/demo-plan.md) §3.

## Date
2026-10-23

## Context
- **A demo session took over the whole app.** ADR-0005 put demo sessions in the same `nx_session` cookie as real accounts, so the session decided the world for every URL. After a judge opened a sandbox, `/` was their sandbox's marketplace, with no way back to the real homepage. Starting a demo also signed out a real account in that browser.
- **The homepage wasn't a homepage.** Every page carried a bar: the scripted demo's persona switcher (Rosa, Arjun) for anonymous visitors, or the sandbox notice for accounts. The product owner asked for a simple homepage with a start / learn-more option instead.
- **Judges need the real flows, not a script.** They should list land, rate it and switch between people freely, with no sign-up, and always know who they are acting as.

## Decision
### 1. Two channels of one API
- Every route is also served under `/sandbox/*`. A pure-ASGI middleware (`app/channel.py`, outermost) strips the prefix and marks the request, so routes don't change.
- **The real app** reads `nx_session` (any session kind, so existing tests and tooling keep working). **The sandbox** reads `nx_demo` and resolves demo sessions only.
- Demo sessions start only through `/sandbox/demo/*` (403 `sandbox_path_only` otherwise). `/sandbox/auth/register` and `/login` are 403 `not_in_sandbox`; `/sandbox/auth/logout` ends only the demo session.
- A browser can hold both cookies: a real account trying the sandbox stays signed in.

### 2. The sandbox's URL space in the frontend
- Every app screen has a twin under `/sandbox` (`app/sandbox/*` re-export the real pages; a test checks none is missing). There the data layer talks to `/api/sandbox`.
- Screens keep writing app paths. Links (`components/app-link.tsx`), the router and `usePathname` (`lib/nav.ts`) add or strip the prefix inside the sandbox. Files the browser fetches itself (images, downloads) take the active channel's base (`useApiBase`).
- `/sandbox` without a sandbox offers to open one instead of showing the live world.

### 3. What the visitor sees
- **The real app has no demo bar.** `/` is the marketplace with "See how it works" (the story at `/judge`) and "Try it yourself" (`/sandbox`). Play money is still said everywhere: the footer on every shell ("Nothing here is a real security or investment"), the auth forms, the trade panel and the marketplace heading.
- **The sandbox bar** (under `/sandbox/*` only) shows who the visitor acts as, labelled with a role ("Rosa (Community steward)", "Arjun (Supporter)", "Admin (NatureX team)"), "What to try" (NatureX's loop as five steps, each opening its real screen as the right person), the story, Reset, and the way back to NatureX. The account menu offers "Leave the sandbox" instead of signing out, which would lose it.
- **The story ends with a guide, not a script:** "Open my sandbox" plus the same five steps.

## Consequences
- **Good:** the real app and the sandbox can't leak into each other by URL or cookie; judges always have a way home; real accounts survive trying the demo.
- **Cost:** about 30 one-line route twins and a codemod to `app-link`/`lib/nav`; new screens need a twin (the test catches it).
- **Leftovers:** a demo session already in `nx_session` from the previous version is signed out on the real app's pages (frontend cleanup). The scripted prototype demo (persona switcher, guided tour, `JudgeLanding`) is unreachable and can be removed in a follow-up.
- **Not changed:** the real channel still resolves a demo session in `nx_session`, which only tests and the leftover above create. Rejecting it in the backend would rewrite about 140 tests for no user-visible gain.

## Alternatives considered
- **Middleware rewrite of `/sandbox/*` onto the same routes** (no twin files): `usePathname` differs between server and client under rewrites, and links would still leave the sandbox. Rejected.
- **One cookie, with the world chosen by URL:** a real account and a demo couldn't coexist in one browser, and a stale demo would keep taking over the real app. Rejected.
- **Keep a slim "play money" banner on the real app:** the product owner asked for no extra bar; the footer and in-context labels carry the framing.
