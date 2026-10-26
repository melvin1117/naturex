# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary design audience: a hackathon judge seeing WildWorth cold.** They arrive from Devpost with no login, spend 3–7 minutes, land on the welcome at `/`, watch the story at `/how` (skippable) and then try it in their own sandbox at `/sandbox`. Many only watch the 3-minute video. When needs conflict, the judge's first-time comprehension wins over density or power-user speed.

In the sandbox the judge switches instantly between people from the avatar menu (no login):

| Persona | Role | Job on WildWorth |
|---|---|---|
| **Rosa, Community** | Leads a cooperative that owns a wetland near an industrial zone | Prove the wetland is worth more alive; get funded without selling the land |
| **Arjun, Supporter** | Backs nature with play money | Find trustworthy, comparable ratings; know quickly when something goes wrong |
| **Reviewer, WildWorth team** | Checks new listings | Approve a listing so it opens on the Marketplace |

The **Time Machine** (next quarter; fire, encroachment or restoration) is open to whoever the visitor is, from the bar.

**Bea, the field guide,** answers a visitor's questions about a site from its own Record (see Brand Commitments).

Mia (curious retail user) is a secondary persona: simple UI, visible impact.

## Product Purpose

WildWorth is the AI rating agency for living nature, with a sandbox exchange. A community lists its land; NVIDIA Nemotron agents (on Nebius Token Factory) rate it from satellite data and local news; the asset gets a grade, a value range and a confidence score; supporters take play-money stakes; and ratings keep updating as the land heals or is damaged.

Its purpose is to make keeping nature alive pay more than destroying it. Success for this build: a judge understands the full loop (list → rate → fund → monitor → explain) without instructions, and believes the numbers are honest.

Built for the Nebius × NVIDIA Global AI Hackathon (Best Apps & Agents track); submission Oct 29, 2026; judging Dec 1–15, 2026. Design is 25% of the score ("a complete, coherent product, not a PoC feel").

## Positioning

"A rating agency first, an exchange second." Every grade is computed by deterministic, tested formulas; the AI orchestrates, classifies, explains and audits, and may move a score only within ±10 with cited evidence. Every rating is sealed into a hash-chained record, **The Record**, and every model call is visible in the Agent Trace. Each quarter a site gets a **Proof of Life**: its rating report and seal. The claim is **measured, not claimed**: numbers come with ranges, confidence and their evidence.

## Operating Context

- **One link, no sign-up (ADR-0008):** `/` is a welcome (Bea, one sentence, two buttons). "Show me how" plays the story at `/how` on one real wetland (every step skippable); "Try it yourself" opens a private sandbox at `/sandbox/*` straight away. "Start the sandbox over" restores it. There are no sign-in pages.
- **Explore freely:** in the sandbox everyone has the same pages (Marketplace, Communities, Your stakes; the Reviewer has Reviews), every person is one click away in the avatar menu, and Bea is a floating button on every page.
- **Video:** recorded with Playwright at ~125% browser zoom, 1080p+. Screens must read well in a recording.
- **Free hosting (if used, dev-spec §21):** the backend may be asleep; a "Waking up… ~30 s" state is part of the experience. When the LLM budget or Earth Engine is unavailable, live steps fall back to cached results with a clear notice, never an error.
- **Local run** for technical judges: without keys the app runs in clearly labelled mock mode.

## Capabilities and Constraints

- One app, in the sandbox (ADR-0008): **Marketplace** (`/sandbox`), **Communities** (`/sandbox/steward`), **Your stakes** (`/sandbox/portfolio`) and, for the Reviewer, **Reviews** (`/sandbox/admin/verifications`). No app names or switcher.
- Screens: the welcome (`/`), the story (`/how`), the Marketplace, List your land (`/sandbox/steward/list`, map drawing + form + rating progress), site page (`/sandbox/asset/[id]`: Proof of Life, chart, trade panel, alerts, The Record), Your stakes, the Time Machine (a sheet from the bar), Ask Bea (a floating button), Agent Trace, `/dev/ui` component showcase.
- Three curated demo sites (hero: a ~500 ha Xochimilco-style wetland near Mexico City; plus a mangrove and a restoration forest). Live rating of user-drawn polygons is best-effort (2 live runs per visitor).
- Ratings: Health Score 0–100; grades AAA ≥ 90 · AA ≥ 80 · A ≥ 70 · BBB ≥ 60 · BB ≥ 50 · B ≥ 40 · C ≥ 30 · D < 30; confidence 0–100%; values as low/mid/high $/yr per service (carbon, water, flood, habitat, recreation).
- Listing polygon: 10–50,000 ha, no self-intersection, no overlap with existing listings.
- Stack: Next.js 15.5 App Router, TypeScript strict, Tailwind v4, **shadcn/ui components only**, react-leaflet, Recharts (no guided tour: the welcome and the story explain the product, ADR-0008). API client is generated from FastAPI's OpenAPI schema.
- **Play money only.** Never present anything as a real security, investment or token. No real-money flows, KYC, crypto or PDF export.
- Responsive web; no native apps. English only (Spanish report is an undecided "Could").
- No third-party logos in the product or the video; keep data attributions (Dynamic World, Copernicus, JRC, Hansen, OpenStreetMap).
- Vocabulary: the API and database keep market terms (`shares`, `ipo`, `orders`); the UI softens them. See [docs/design/ux-writing.md](docs/design/ux-writing.md).

## Brand Commitments

The source of truth for the brand is [docs/design/wildworth-brand-guidelines.html](docs/design/wildworth-brand-guidelines.html); for Bea, [docs/design/bea-character.html](docs/design/bea-character.html).

- **Name: WildWorth**, one word, two capitals (never Wild Worth, Wildworth or "WW"). In a cold context add a descriptor: "WildWorth · nature ratings". On first mention in any public place, the sandbox line: "Sandbox · play money only".
- **Tagline:** *"Worth more wild."* Hero line (judge invitation): *"The bees never sent an invoice. WildWorth works out what they're worth."* Video line: *"Every quarter, WildWorth issues a Proof of Life."* Closing line: *"Keeping nature alive should pay more than destroying it."*
- **Belief:** keeping nature alive should pay more than destroying it. **Promise:** measured, not claimed. **Personality:** credible, alive, plain-spoken, open.
- **The logo is a reading:** two Ws drawn as one line, the last stroke rising to the site's Health score (the master shows 77.6). Visual rules live in DESIGN.md.
- **Feature names** (repeat these exactly): Proof of Life (the quarterly rating report and its seal), Health score, Worth range, WildWatch (news sweeps, satellite checks and their alerts), The Record (the hash-chained ledger), Recovery plan, Verified land, Agent Trace, Auditor, News Scout, Back this site, Your stakes, Opening offer, Community fund, Time Machine. Page names: Marketplace, Communities, Your stakes, Reviews.
- **Bea, the field guide** (replaces "Copilot"): a bee drawn in the logo's line, ink only. The button is **Ask Bea**; the panel is **Bea · your field guide**, "Answers only from this site's Record"; the Agent Trace shows **Bea (model name)**. She answers only from the site's Record, shows her sources, says "Bzz" only to open a first answer, and never says invest, returns or buy.
- **Voice is mixed by context** (confirmed):
  - **Rating, report, market, trace and ledger surfaces:** sober rating-agency voice. Precise, evidence-led, understated; ranges and confidence always shown; never hype.
  - **Community, listing, onboarding and tour surfaces:** warmer, plain language, celebrates stewards, still honest about uncertainty.
- **Market vocabulary is softened** (confirmed): rating-agency language first; explicit market terms appear only inside the trade panel. The sandbox line is said once on the welcome and once in the trade panel, not on every surface.
- Visual decisions (logo, colour, type, icons, motion) belong to DESIGN.md, which follows the guidelines.

## Evidence on Hand

- Specs and pitch: [docs/one-pager.md](docs/one-pager.md), [docs/specs/pm-spec.md](docs/specs/pm-spec.md), [docs/specs/dev-spec.md](docs/specs/dev-spec.md), [docs/specs/demo-plan.md](docs/specs/demo-plan.md), [docs/diagrams.html](docs/diagrams.html).
- Demo numbers in the pitch (Health 77.6, grade A, ~$11.7M/yr, 87% confidence) are targets from the spec, not yet produced by the engine; the UI must show whatever the API returns.
- The backend currently serves typed mock data for every route (`backend/app/mocks.py`).
- **Absent, must not be fabricated:** real users, testimonials, partner organisations, press, certifications, real site photos, satellite imagery (until D2 precomputes it), and any real-money or regulatory claims.

## Product Principles

1. **Understandable in one pass.** A newcomer should grasp each screen without the tour; the tour adds depth, not rescue.
2. **Numbers carry their honesty.** Every value shows its range and confidence; every grade change links to its evidence.
3. **Show the machine.** Make the AI's work visible and inspectable (live badges, the Agent Trace, The Record) instead of asserting it.
4. **Rating agency, not casino.** Calm, credible and unmistakably a sandbox; nothing should read as a securities or crypto pitch.
5. **Stewards are the protagonists.** Investors fund communities; the story is about land staying alive and the people keeping it so.

## Accessibility & Inclusion

Target **WCAG 2.2 AA** (assumed team default; not yet confirmed by the team). Grades and price direction must never rely on colour alone. Everything must be keyboard-operable, including the story, map alternatives (area and validation messages as text) and the persona switcher; respect `prefers-reduced-motion` for the logo, the seal, Bea, pipeline and grade animations (show the final frame).
