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
- **Who you are** is a switcher in the bar ("Viewing as Rosa", everyone's avatars stacked, the current person in front): Rosa (Community), Arjun (Supporter) or the Reviewer (WildWorth team), each with one line on what they do; plus "Start the sandbox over" and "Leave the sandbox".
- **Ask Bea** is a floating button on every page. Each opening starts a fresh chat; on a site's page she starts on that site, elsewhere across every site. The per-page Bea panels (site page, Your stakes) are removed.
- **The Time Machine** opens from the bar in a side sheet, for whoever you are (§3).
- **The footer** is one line: the prototype note and "Data sources" (a dialog with the attributions).
- **Removed:** the sign-in and sign-up pages and forms, the account menu, the app header, app switcher and sandbox strip, the sandbox bar's guide, "AI at work" (`/ai`), and the judge landing (`JudgeLanding`).

### 3. Anyone in a sandbox runs its Time Machine
- New action `SIMULATE` (`app/authz.py`) for `GET /admin/time-machine`, `POST /admin/simulate/quarter`, its job, `POST /admin/simulate/event` and `GET /admin/alerts`. In a sandbox world with a demo session, anyone may run it: a sandbox is one visitor's private copy, so it's the demo's control, not an operator's power. Elsewhere it is `OPERATE`'s rule (an impartial admin).
- `OPERATE` keeps suspend, resume and operator re-rates; `REVIEW_LISTING` keeps verification decisions (the Reviewer).

### 4. A site's depth opens over it
- A site page is one short scroll: the hero, the Auditor's verdict with the models that worked on it, then **What the land does**, **Seen from above** and **News and satellite**, with **Back this site** beside them.
- **The Agent Trace and the Proof of Life drawer open over the page** instead of on their own pages, so the visitor never loses the site they were reading. The page's `?tab=` names the open drawer (`trace`, or `report` · `ledger` · `verification` · `photos` · `sources`), so links into a report, a ledger entry or the news keep working; `?tab=news` and `?tab=price` scroll to that part of the page.
- `/trace/<run>` and `/trace/recorded/<site>` stay as pages for deep links; nothing on the site page links to them.

### 5. A community sends its opening offer; the Reviewer's approval lists the site
- Listing is one screen a community can leave and come back to at the same step: **Name → Draw → Rate → Prove (optional) → Offer → Send for review**. Documents are optional in a sandbox (the live world's launch still needs a verified listing).
- **The community sends its offer instead of launching it** (`POST /assets/{id}/offer`): the units to issue and the share it keeps, at the price the rating sets. The terms are stored on the asset with `offer_sent_at`.
- **The Reviewer decides** (`GET /admin/offers`, then `…/offer/approve` or `…/offer/send-back` with a note). Approval launches the offer through the existing launch, at the price the latest report sets then, so its gates and ledger entry are unchanged; until then the site isn't public, so it isn't on the Marketplace. A note sends it back for the community to change and resend.
- **A decision names the offer it decides** (its `sent_at`, checked under the asset's lock): an offer sent again since the Reviewer read it is refused (`offer_changed`), so an approval never launches terms nobody saw. An offer the launch would refuse (priced at zero, a revoked verification) stays in the queue with why, to be sent back. A Reviewer never sees or decides their own community's offers. The community home says where an offer stands (`offer_in_review`, `offer_sent_back`).
- `POST /assets/{id}/ipo` stays for the operator's tools and older clients; the sandbox doesn't call it.
- The old opening-offer and verification pages (`/steward/assets/<id>/ipo` and `/verify`) redirect to the flow's Offer and Prove steps. The Reviewer's **Reviews** page opens on **Offers**; land documents are under **Documents**.

### 6. Communities and Your stakes say how things stand, in a sentence and a picture
- **Communities** (`/steward`) lists the communities you're in, each with a glimpse of its land and how many of its sites are on the Marketplace; **Start a community** opens the same form a newcomer sees (`?new=1`). Opening one (`?community=<id>`) shows its name, one sentence with its numbers (sites on the Marketplace, supporters, the fund) and a tile per site: its satellite view, where it stands (Draft, Being rated, Waiting for the Reviewer, Sent back with the note, On the Marketplace with its price) and the one place it leads. Drafts are withdrawn from their tile; **List more land** closes the grid.
- **Removed from the community's page:** the featured listing, the stat strip, Recovery plan, Quarterly payouts, Supporters, Members (still under **Edit community**), its alerts (the bell has them), decision notices (the tile and the flow's Prove step say it) and the community switcher. The **Listings** page redirects to the community's page.
- **Your stakes** opens on **Your money** (the total against the starting play money, then how it splits between the stakes, with what was paid and the change in value, and the sandbox balance) beside **What your stakes keep alive** (land, stored carbon and nature's services, attribution only); then **How each stake is doing**, a row per stake with its grade, its latest prices against what was paid, and paid, worth now and the change. The alerts panel is gone. *(Revised after the product owner's testing: one sentence hid what was paid and how each stake did.)*

## Consequences

- **Good:** a judge reads what WildWorth is in one sentence, reaches a working app in one click and never meets a sign-in. Every page has the same three choices.
- **Real accounts are dormant, not deleted.** The backend's auth routes, the live world and their tests stay; nothing in the frontend reaches them. Bringing accounts back later means a header for them, not a rebuild.
- **The live world has no public page.** The deployed URL shows the welcome, the story and the sandbox only.
- **Cleaned up:** the old opening-offer and verification screens, the control room, the sign-in helpers, the app switcher's rules, the scripted prototype (its browser-only world, tour, demo bar and fallback views) and the global trace sheet are gone. Pages that had a fallback for visitors without a session now wait for the sandbox gate, which opens one first; `RequireAccount` is now `ReviewerGate`, for the Reviewer's pages only. The trace drawer gained the routing table (which model does what) and the eval results that only the old sheet showed. The E2E is one sandbox journey plus an axe pass over every page.

## Alternatives considered
- **Keep a read-only live Marketplace beside the sandbox:** two kinds of page to explain to a judge for little gain. Rejected for the hackathon.
- **One "You" persona who does everything:** simpler label, but tabs start empty and members can't back their own community's site, so the core trade would need a second person anyway. Rejected; the switcher stays, inside the avatar menu.
- **Time Machine for the Reviewer only:** hides the demo's best moment behind a role switch. Rejected.
