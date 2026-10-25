# ADR-0008: One sandbox experience: a welcome, a story, and one app with no sign-in

## Status
Accepted (2026-10-25). Amends [ADR-0005](./0005-accounts-roles-and-two-apps.md) §3 (the Time Machine row of the role matrix) and §5 (three apps) and [ADR-0007](./0007-sandbox-address.md) §2–§3 (the real app's screens and the sandbox bar). Changes [demo-plan](../specs/demo-plan.md) §3 and PRODUCT.md's operating context.

## Date
2026-10-25

## Context
- **A judge had to learn the org chart before seeing a rating.** The app showed three apps (Exchange, Stewards, Control room) with a switcher, three personas in a separate bar, a "What to try" guide, an "AI at work" page, a sign-in and a sign-up. Walking it cold, the first screen asked who you are before saying what WildWorth is.
- **Dead ends for sandbox personas.** Arjun opening the Control room got "doesn't have admin access"; the Stewards app offered a copyable account UUID; Bea had a panel on some pages and a header button on others.
- **"Play money" appeared three to five times per screen** (strip, subtitle, trade panel, footer, Bea's footnote).
- The product owner asked for a simple, immersive and intuitive experience: a welcome, "Show me how" and "Try it yourself"; no login or signup; Marketplace, Communities and Your stakes for everyone; Bea one tap away on every page; no "AI at work".

## Decision
### 1. Three places, in order
- **`/` is a welcome**, not an app page: Bea flies in over the hero wetland, one plain sentence says what WildWorth does, and two buttons lead on: **Show me how** (`/how`, the story; was `/judge`) and **Try it yourself** (`/sandbox`). The sandbox line appears once, at its foot.
- **`/sandbox/*` is the whole app.** Opening it without a sandbox starts one straight away (as Arjun), no intermediate screen. The real-app twins are gone: `app/(exchange)`, `app/steward` and `app/admin` moved under `app/sandbox`.
- **Old addresses redirect** (`next.config.ts`): `/judge` → `/how`; `/login`, `/register`, `/ai` → `/sandbox`; `/asset/*`, `/trace/*`, `/portfolio`, `/steward/*`, `/admin/*` → their `/sandbox` twin.

### 2. One shell for everyone
- **One bar:** WildWorth, then **Marketplace · Communities · Your stakes** (the Reviewer gets **Marketplace · Reviews**), then the Time Machine, the alerts bell, and who you are. No app names, no app switcher.
- **Who you are** is a menu on the avatar: Rosa (Community), Arjun (Supporter) or the Reviewer (WildWorth team), each with one line on what they do; plus "Start the sandbox over" and "Leave the sandbox".
- **Ask Bea** is a floating button on every page. Each opening starts a fresh chat; on a site's page she starts on that site, elsewhere across every site. The per-page Bea panels (site page, Your stakes) are removed.
- **The Time Machine** opens from the bar in a side sheet, for whoever you are (§3).
- **The footer** is one line: the prototype note and "Data sources" (a dialog with the attributions).
- **Removed:** the sign-in and sign-up pages and forms, the account menu, the app header, app switcher and sandbox strip, the sandbox bar's guide, "AI at work" (`/ai`), and the judge landing (`JudgeLanding`).

### 3. Anyone in a sandbox runs its Time Machine
- New action `SIMULATE` (`app/authz.py`) for `GET /admin/time-machine`, `POST /admin/simulate/quarter`, its job, `POST /admin/simulate/event` and `GET /admin/alerts`. In a sandbox world with a demo session, anyone may run it: a sandbox is one visitor's private copy, so it's the demo's control, not an operator's power. Elsewhere it is `OPERATE`'s rule (an impartial admin).
- `OPERATE` keeps suspend, resume and operator re-rates; `REVIEW_LISTING` keeps verification decisions (the Reviewer).

## Consequences
- **Good:** a judge reads what WildWorth is in one sentence, reaches a working app in one click and never meets a sign-in. Every page has the same three choices.
- **Real accounts are dormant, not deleted.** The backend's auth routes, the live world and their tests stay; nothing in the frontend reaches them. Bringing accounts back later means a header for them, not a rebuild.
- **The live world has no public page.** The deployed URL shows the welcome, the story and the sandbox only.
- **Slices still to come** (each its own PR): the trimmed story; the site page with the "How it was rated" drawer; the one-screen listing flow with drafts and optional documents, launched on the Reviewer's approval; Communities and Your stakes; then removing the code nothing reaches (the scripted prototype, its tour) and updating the specs.

## Alternatives considered
- **Keep a read-only live Marketplace beside the sandbox:** two kinds of page to explain to a judge for little gain. Rejected for the hackathon.
- **One "You" persona who does everything:** simpler label, but tabs start empty and members can't back their own community's site, so the core trade would need a second person anyway. Rejected; the switcher stays, inside the avatar menu.
- **Time Machine for the Reviewer only:** hides the demo's best moment behind a role switch. Rejected.
