# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary design audience: a hackathon judge seeing NatureX cold.** They arrive from Devpost with no login, spend 3–7 minutes, and either follow the guided tour or explore freely. Many only watch the 3-minute video, which is a recording of the same tour. When needs conflict, the judge's first-time comprehension wins over density or power-user speed.

The judge experiences the product through four personas, switched instantly from the top bar (no login):

| Persona | Role | Job on NatureX |
|---|---|---|
| **Rosa, community steward** | Leads a cooperative that owns a wetland near an industrial zone | Prove the wetland is worth more alive; get funded without selling the land |
| **Arjun, impact investor** | Runs a small nature-focused fund | Find trustworthy, comparable ratings; know quickly when something goes wrong |
| **NatureX AI** ("under the hood") | The rating engine | Show every agent step, model call, formula and ledger entry |
| **Time Machine** (narrator) | Advances the story | Move to the next quarter; inject fire, encroachment or restoration |

Mia (curious retail user) is a secondary persona: simple UI, visible impact.

## Product Purpose

NatureX is an AI rating agency and sandbox exchange for living nature. A community lists its land; NVIDIA Nemotron agents (on Nebius Token Factory) rate it from satellite data and local news; the asset gets a grade, a value range and a confidence score; supporters take play-money stakes; and ratings keep updating as the land heals or is damaged.

Its purpose is to make keeping nature alive pay more than destroying it. Success for this build: a judge understands the full loop (list → rate → fund → monitor → explain) without instructions, and believes the numbers are honest.

Built for the Nebius × NVIDIA Global AI Hackathon (Best Apps & Agents track); submission Oct 29, 2026; judging Dec 1–15, 2026. Design is 25% of the score ("a complete, coherent product, not a PoC feel").

## Positioning

"A rating agency first, an exchange second." Every grade is computed by deterministic, tested formulas; the AI orchestrates, classifies, explains and audits, and may move a score only within ±10 with cited evidence. Every rating is written to a hash-chained Nature Ledger, and every model call is visible in the Agent Trace. The claim is **measured, not claimed**: numbers come with ranges, confidence and their evidence.

## Operating Context

- **Judge Mode:** one link, no signup; each visitor gets a private sandbox world; "Reset my demo" restores it.
- **Guided tour:** 10 chapters with a progress bar, spotlight hints, two hint layers (*Why this matters* / *Tech behind it*), "Do it for me", skip/back/resume, and **Live** badges on steps that really call Nemotron or Tavily. Every screen needs stable anchor points for tour steps.
- **Explore freely:** all personas unlocked with hints available.
- **Video:** the tour's autoplay path is scripted with Playwright and recorded at ~125% browser zoom, 1080p+. Screens must read well in a recording.
- **Free hosting:** the backend may be asleep; a "Waking up… ~30 s" state is part of the experience. When the LLM budget or Earth Engine is unavailable, live steps fall back to cached results with a clear notice, never an error.
- **Local run** for technical judges: without keys the app runs in clearly labelled mock mode.

## Capabilities and Constraints

- Screens: Judge landing, Marketplace (`/`), Listing (`/list`, map drawing + form + rating progress), Asset page (`/asset/[id]`: report, chart, trade panel, alerts, ledger tab), Portfolio (`/portfolio`), Admin/Time Machine (`/admin`), Copilot, Agent Trace drawer, `/dev/ui` component showcase.
- Three curated demo sites (hero: a ~500 ha Xochimilco-style wetland near Mexico City; plus a mangrove and a restoration forest). Live rating of user-drawn polygons is best-effort (2 live runs per visitor).
- Ratings: Health Score 0–100; grades AAA ≥ 90 · AA ≥ 80 · A ≥ 70 · BBB ≥ 60 · BB ≥ 50 · B ≥ 40 · C ≥ 30 · D < 30; confidence 0–100%; values as low/mid/high $/yr per service (carbon, water, flood, habitat, recreation).
- Listing polygon: 10–50,000 ha, no self-intersection, no overlap with existing listings.
- Stack: Next.js 15.5 App Router, TypeScript strict, Tailwind v4, **shadcn/ui components only**, react-leaflet, Recharts, Driver.js or react-joyride for the tour. API client is generated from FastAPI's OpenAPI schema.
- **Play money only.** Never present anything as a real security, investment or token. No real-money flows, KYC, crypto or PDF export.
- Responsive web; no native apps. English only (Spanish report is an undecided "Could").
- No third-party logos in the product or the video; keep data attributions (Dynamic World, Copernicus, JRC, Hansen, OpenStreetMap).
- Vocabulary: the API and database keep market terms (`shares`, `ipo`, `orders`); the UI softens them. See [docs/design/ux-writing.md](docs/design/ux-writing.md).

## Brand Commitments

- Name: **NatureX**. Tagline line from the pitch: *"The bees never sent an invoice."* Closing line: *"Keeping nature alive should pay more than destroying it."*
- **Voice is mixed by context** (confirmed):
  - **Rating, report, market, trace and ledger surfaces:** sober rating-agency voice. Precise, evidence-led, understated; ranges and confidence always shown; never hype.
  - **Community, listing, onboarding and tour surfaces:** warmer, plain language, celebrates stewards, still honest about uncertainty.
- **Market vocabulary is softened** (confirmed): rating-agency language first; explicit market terms appear only inside the trade panel, always with sandbox framing.
- No logo or visual identity exists yet; visual decisions belong to the design system (P04), not this file.

## Evidence on Hand

- Specs and pitch: [docs/one-pager.md](docs/one-pager.md), [docs/specs/pm-spec.md](docs/specs/pm-spec.md), [docs/specs/dev-spec.md](docs/specs/dev-spec.md), [docs/specs/demo-plan.md](docs/specs/demo-plan.md), [docs/diagrams.html](docs/diagrams.html).
- Demo numbers in the pitch (Health 77.6, grade A, ~$11.7M/yr, 87% confidence) are targets from the spec, not yet produced by the engine; the UI must show whatever the API returns.
- The backend currently serves typed mock data for every route (`backend/app/mocks.py`).
- **Absent, must not be fabricated:** real users, testimonials, partner organisations, press, certifications, real site photos, satellite imagery (until D2 precomputes it), and any real-money or regulatory claims.

## Product Principles

1. **Understandable in one pass.** A newcomer should grasp each screen without the tour; the tour adds depth, not rescue.
2. **Numbers carry their honesty.** Every value shows its range and confidence; every grade change links to its evidence.
3. **Show the machine.** Make the AI's work visible and inspectable (live badges, trace, ledger) instead of asserting it.
4. **Rating agency, not casino.** Calm, credible and unmistakably a sandbox; nothing should read as a securities or crypto pitch.
5. **Stewards are the protagonists.** Investors fund communities; the story is about land staying alive and the people keeping it so.

## Accessibility & Inclusion

Target **WCAG 2.2 AA** (assumed team default; not yet confirmed by the team). Grades and price direction must never rely on colour alone. Everything must be keyboard-operable, including the tour, map alternatives (area and validation messages as text) and the persona switcher; respect `prefers-reduced-motion` for pipeline and grade animations.
