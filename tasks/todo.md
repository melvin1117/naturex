# WildWorth task list

> **Tracked in GitHub Issues** ([melvin1117/naturex](https://github.com/melvin1117/naturex/issues)): epics #1–#6, tasks #7–#65 (issue number shown after each title). **The issues are the source of truth for status**; update this file only when scope changes.
> **What can I pick?** Open [task-map.html](./task-map.html) (auto-synced from the issues): 🟢 ready tasks have every dependency closed. Keep the heading format and `**Deps:**` lines below intact; `scripts/task_map.py` parses them.
> Plan and team roles: [plan.md](./plan.md). Owners: **PD** (product designer + frontend), **D1** (platform & market), **D2** (geo & rating data), **D3** (AI agents).
> Each task shows **owner · size · priority · stories covered**. Sizes: XS/S (1–2 files), M (3–5 files); nothing larger. Priorities: Must / Should / Could (from `pm-spec.md` §5).
> Standard checks, created in T04/T05: `make lint`, `make test` (backend), `make fe-check` (frontend lint, types, build), `make eval`, `make e2e`. Every task also meets the Definition of Done in [AGENTS.md](../AGENTS.md).

---

## Week 1 · Foundations and walking skeleton (Mon Sep 28 – Fri Oct 2)

### T01 · Accounts, credits and keys (#7) — All · XS · Must
- [x] Each member claims the Token Factory promo ($25, code `NEBIUS-DEVPOST-GLOBAL26`) and joins the Nebius Builders Program ($25 Token Factory + $25 Tavily)
- [x] D2 registers an Earth Engine non-commercial project; hosting accounts are set up in T20; one person owns the shared deployment keys
- [x] Keys live only in personal `.env` files; `.env.example` lists the variable names

**Verify:** `make check-keys` passes for each dev with their own key (it also lists the Nemotron model IDs for `MODEL_*`) · **Deps:** none

### T02 · Token Factory spike (risk) (#8) — D3 · S · Must
Confirm how Nemotron actually behaves on Token Factory before building on it.
- [x] Exact model IDs, prices, embeddings and one image input checked (ADR-0003, Oct 5)
- [x] Tested: `response_format` JSON schema (both shapes), tool calling, thinking on/off (`chat_template_kwargs`) on each Nemotron model; Nano vs 3.5 Lightning
- [x] Findings added to `docs/adr/0003-model-routing-on-token-factory.md` (what works, latency, token counts)

**Verify:** spike script reproduces each result · **Deps:** T01 · **Files:** `scripts/spikes/token_factory.py`, `docs/adr/0003-*.md`

### T03 · Earth Engine spike (risk) (#9) — D2 · S · Must
- [x] EE auth works from Python (service account or user auth) for the team project
- [x] Notebook computes Dynamic World fractions and a monthly NDVI series for the hero wetland polygon
- [x] Earth Engine terms for a prize-bearing hackathon checked; result noted in the ADR

**Verify:** notebook runs top to bottom · **Deps:** T01 · **Files:** `notebooks/ee_spike.ipynb`, `docs/adr/0004-earth-observation.md`

### T04 · Backend and repo skeleton (#10) — D1 · M · Must
- [x] `LICENSE` (MIT); `backend/` with uv, FastAPI `/healthz`, pydantic-settings; `compose.yml` with `pgvector/pgvector:pg16`
- [x] ruff, `mypy --strict`, pytest, pre-commit; root `Makefile` with `lint`, `test`
- [x] GitHub Actions backend job; `main` branch ruleset (PR + 1 review + green CI); CODEOWNERS, PR template

**Verify:** `make lint && make test`; CI green on the first PR · **Deps:** none · **Files:** `LICENSE`, `backend/pyproject.toml`, `backend/app/main.py`, `compose.yml`, `.pre-commit-config.yaml`, `.github/workflows/backend.yml`, `Makefile`

### T05 · Frontend skeleton (#11) — D1 · M · Must
- [x] Next.js (version per T06) App Router, TypeScript strict, Tailwind v4, shadcn/ui init, ESLint 9 + Prettier
- [x] Route stubs for `/`, `/list`, `/asset/[id]`, `/portfolio`, `/admin`, `/dev/ui`; persistent sandbox banner (C5)
- [x] `make fe-check` and a GitHub Actions frontend job

**Verify:** `make fe-check`; `pnpm dev` shows all routes · **Deps:** T04, T06 · **Files:** `frontend/**` (scaffold), `.github/workflows/frontend.yml`

### T06 · Architecture decisions (ADR session, day 1) (#12) — D1 (writes) + All · S · Must
- [x] ADRs 0001–0002 (stack & versions, repo layout) plus decisions on each open item in `plan.md` "Architecture decisions"
- [x] Accepted changes applied to `docs/specs/dev-spec.md`, the Rating Engine page in `docs/diagrams.html` and `research.md` (mark OpenSpec as replaced by Addy's skills)

**Verify:** ADRs merged; docs agree (link check passes) · **Deps:** none · **Files:** `docs/adr/0001-*.md`, `docs/adr/0002-*.md`, `docs/specs/dev-spec.md`, `docs/diagrams.html`

### T07 · Database schema v1 (#13) — D1 · M · Must
- [x] SQLModel models and first Alembic migration for every table in dev-spec §5, **plus `world_id` on all tables that change during the demo** (sandbox, demo-plan §3.5)
- [x] Seed script: 4 personas, 3 demo assets
- [x] Tests: migration up/down, seed is idempotent

**Verify:** `make test`; `docker compose up` then seed · **Deps:** T04, T06 · **Files:** `backend/app/models.py`, `backend/migrations/**`, `backend/app/seed.py`, `backend/tests/test_models.py`

### T08 · API contract v1 + generated client (#14) — D1 (+D3 for agent schemas) · M · Must
- [x] All dev-spec §6 routes exist and return typed **mock data** (`USE_MOCKS=true`), including Pydantic schemas for News Scout and Auditor outputs
- [x] `openapi-typescript` + `openapi-fetch` client generated into `frontend/src/lib/api/`; CI fails if the client is out of date

**Verify:** `make test`; `make fe-check`; client drift check in CI · **Deps:** T04, T05, T07 · **Files:** `backend/app/routers/*.py`, `backend/app/schemas.py`, `scripts/generate-client.sh`, `frontend/src/lib/api/*`

### T09 · Token Factory LLM client (#15) — D3 · S · Must
- [x] One wrapper for all model calls: model routing from env, retries, schema validation, fallback tier, `LLM_BUDGET_USD` cap
- [x] Every call logged to `llm_calls` (agent, model, tokens, latency, cost)
- [x] Unit tests with mocked HTTP (budget cap refuses calls, invalid JSON retries)

**Verify:** `make test` · **Deps:** T02, T07 · **Files:** `backend/app/llm.py`, `backend/tests/test_llm.py`

### T10 · Live AI summary endpoint (#16) — D3 · S · Must
- [x] For a demo asset, the reports API returns a report whose summary is written live by Nemotron from (mock) metrics
- [x] The call appears in `llm_calls`

**Verify:** `curl` the endpoint; a row appears in `llm_calls` · **Deps:** T08, T09 · **Files:** `backend/app/agents/summary.py`, `backend/app/routers/reports.py`

### T11 · Hero-site precompute (#17) — D2 · M · Must · B1 B2
- [x] Hero wetland polygon (GeoJSON) drawn on the real wetland: the seed placeholder is 93% built-up town; the wetland is ~3 km north, near Xochimilco Ecological Park (box SW corner −99.105, 19.28; ADR-0004), and `scripts/precompute_sites.py` producing cached metrics JSON: land-cover fractions, NDVI series + trend, water change, forest loss, biomass, cloud-free coverage (methods per T06)
- [x] Dataset versions and attributions stored in the output

**Verify:** script reproduces the committed JSON · **Deps:** T03, T06 · **Files:** `backend/data/demo_sites/*.geojson|json`, `scripts/precompute_sites.py`, `backend/app/tools/earth_obs.py`

### T12 · Bare report page (walking skeleton) (#18) — D3 · S · Must
- [ ] `/asset/[id]` shows the report's key numbers and the live AI summary from the API (unstyled is fine)

**Verify:** `make fe-check`; manual check in the browser · **Deps:** T05, T08, T10 · **Files:** `frontend/src/app/asset/[id]/page.tsx`

### P01 · Product brief and voice (#19) — PD · S · Must
- [x] `PRODUCT.md` via `/impeccable init` (audience, purpose, voice, constraints, anti-patterns)
- [x] UX writing rules: numbers always as range + confidence, sandbox wording, grade language

**Verify:** team review · **Deps:** none · **Files:** `PRODUCT.md`, `docs/design/ux-writing.md`

### P02 · User flows and information architecture (#20) — PD · M · Must
- [ ] Flows for Rosa (community), Arjun (investor), WildWorth AI (under the hood), Time Machine, and the judge tour chapters (demo-plan §3.3)
- [ ] Sitemap and navigation; persona switcher behaviour
- [ ] *(ADR-0005)* Two apps (Exchange at `/`, Steward at `/steward`) plus `/admin`; sign-in and sign-up; the `/judge` one-click demo; which role sees what

**Verify:** team walkthrough · **Deps:** P01 · **Files:** `docs/design/flows.md` (links to the design file)

### P03 · Wireframes for all screens (#21) — PD · M · Must
- [ ] Marketplace, listing (map + form), rating progress, asset page, portfolio, admin/Time Machine, Copilot, Agent Trace drawer, ledger tab, judge landing
- [ ] *(ADR-0005)* Sign-in and sign-up, Steward home (wallet, holders, payouts, listing status), community and members, IPO launch, app switcher, demo bar

**Verify:** each wireframe maps to user stories in `pm-spec.md` · **Deps:** P02 · **Files:** design file, `docs/design/`

### P04 · Design system v1 (#22) — PD · M · Must
- [ ] Tokens: colour (incl. grade scale and chart palette), type, spacing, radius, elevation; shadcn theme mapping; component inventory
- [ ] Handed off as a Tailwind v4 `@theme` spec that T21 turns into code

**Verify:** tokens documented and reviewed · **Deps:** P01 · **Files:** `docs/design/tokens.md`

### P05 · Hi-fi key screens (#23) — PD · M · Must
- [ ] Asset page (hero screen), marketplace and listing flow in high fidelity, using P04 tokens
- [ ] *(ADR-0005)* Steward home and IPO launch in high fidelity

**Verify:** Friday review; `/impeccable critique` pass · **Deps:** P03, P04 · **Files:** design file

### ✅ Checkpoint W1 (Fri Oct 2)
- [ ] One demo site: list → (mock) rating → report page with a **real Nemotron summary**
- [ ] CI green on backend and frontend; `docker compose up` works from a clean clone
- [ ] Flows, wireframes and tokens reviewed; ADRs merged

---

## Week 2 · Real data and the exchange (Mon Oct 5 – Fri Oct 9)

### T13 · Remaining demo sites and scenarios (#24) — D2 · M · Must
- [x] Mangrove and restoration-forest sites precomputed like T11
- [x] Time Machine scenario versions for each site (baseline, restoration, encroachment), generated as scripted deltas

**Verify:** script reproduces all JSON · **Deps:** T11 · **Files:** `backend/data/demo_sites/*`, `scripts/precompute_sites.py`

### T14 · Valuation engine (#25) — D2 · M · Must · B3
- [x] Coefficient table per T06 (cited; no raw ESVD), class → biome mapping including the coastal check (Natural Earth)
- [x] Low / mid / high $/yr and per-service breakdown; carbon stock per the agreed formula
- [x] Unit tests including the worked example

**Verify:** `make test` · **Deps:** T06, T11 · **Files:** `backend/app/tools/valuation.py`, `backend/data/coefficients.csv`, `backend/data/coastline/*`, `backend/tests/test_valuation.py`

### T15 · Scoring, grade, confidence and listing gate (#26) — D2 · M · Must · B5
- [x] Pure functions for V, N, L, W, T, health, grade, confidence and the listing gate (dev-spec §7.4, as updated by T06)
- [x] Unit tests for bounds, thresholds and the worked example

**Verify:** `make test` · **Deps:** T11 · **Files:** `backend/app/tools/scoring.py`, `backend/tests/test_scoring.py`

### T16 · Market engine (#27) — D1 · M · Must · C2 C4
- [x] IPO price from fair value; instant fills with slippage; primary shares credit the community wallet; price moves with order flow and re-anchoring (dev-spec §8)
- [x] Invariant tests: no negative cash, shares conserved, price > 0, every price change has a reason

**Verify:** `make test` · **Deps:** T07 · **Files:** `backend/app/market/engine.py`, `backend/tests/test_market.py`

### T17 · Orders and portfolio API (#28) — D1 · S · Must · C2 E3
- [x] `POST /orders` and `GET /portfolio` backed by the engine, scoped to the visitor's `world_id`

**Verify:** `make test` (API tests) · **Deps:** T08, T16 · **Files:** `backend/app/routers/market.py`, `backend/tests/test_market_api.py`

### T18 · Trade panel and portfolio UI (#29) — D1 (with PD designs) · M · Must · C2
- [ ] Buy/sell panel on the asset page with validation and play-money balance; portfolio page with holdings and P&L

**Verify:** `make fe-check`; manual buy then sell (signed in, in the Exchange app) · **Deps:** T17, T57, T61 · **Files:** `frontend/src/components/TradePanel.tsx`, `frontend/src/app/portfolio/page.tsx`

### T19 · Deterministic rating into the reports API (#30) — D2 · S · Must · B1–B3 B5
- [x] Rating service runs earth_obs (cached) → valuation → scoring for each demo site and stores report v1 (no agents yet); the reports API serves real data instead of mocks

**Verify:** `make test`; asset page shows real numbers · **Deps:** T14, T15, T08 · **Files:** `backend/app/services/rating.py`, `backend/app/routers/reports.py`

### T20 · Deploy skeleton (risk) (#31) — D1 · S · Must
- [ ] Pick the host from dev-spec §21 (Nebius Serverless if credits → Azure Container Apps + Azure Postgres if the team approves the credits and they last to Dec 15 and allow a public demo → HF Spaces/Render + Supabase); record the choice in the README
- [ ] Frontend on Vercel; backend container + Postgres (with `vector`) on the chosen host; secrets in host settings, never in the repo
- [ ] Browser traffic goes through the frontend's `/api/*` rewrite to the backend (`BACKEND_URL`, next.config.ts), so the `nx_world` sandbox cookie stays first-party; backend `ENVIRONMENT=production` so the cookie is `Secure`
- [ ] `/healthz` reachable; README notes the URLs

**Verify:** public URL loads the marketplace · **Deps:** T04, T05 · **Files:** `backend/Dockerfile`, deploy config

### T21 · Design system in code (#32) — PD · M · Must
- [ ] P04 tokens as Tailwind v4 theme + shadcn theme; app shell and navigation primitives (the two app shells are T62; the persona switcher moves to the demo bar, T65); `/dev/ui` shows every component and state

**Verify:** `make fe-check`; `/dev/ui` reviewed · **Deps:** P04, T05 · **Files:** `frontend/src/app/globals.css`, `frontend/src/components/ui/*`, `frontend/src/app/dev/ui/page.tsx`

### T22 · Marketplace (#33) — PD · M · Must · C1
- [ ] Asset cards (name, thumbnail, price, change, grade, trend, confidence), sort and filter, from the API

**Verify:** `make fe-check`; `web-design-guidelines` review · **Deps:** T08, T32 · **Files:** `frontend/src/app/page.tsx`, `frontend/src/components/AssetCard.tsx`

### T23 · Asset page v1 (#34) — PD · M · Must · B1–B3 B5
- [ ] Report card (grade, health, value range, confidence), land-cover and NDVI charts, map, data attribution footer

**Verify:** `make fe-check`; matches P05 · **Deps:** T19, T32 · **Files:** `frontend/src/app/asset/[id]/page.tsx`, `frontend/src/components/ReportView.tsx`, charts

### T24 · News Scout (#35) — D3 · M · Must · B4
- [x] Nominatim reverse geocode (1 req/s, cached) → Tavily queries → Nemotron Nano classification into the event schema; untrusted-content guard; 24 h cache
- [x] Contract tests on recorded fixtures (no live calls in CI)

**Verify:** `make test`; manual run for the hero site · **Deps:** T09 · **Files:** `backend/app/agents/news_scout.py`, `backend/tests/fixtures/news/*`, `backend/tests/test_news_scout.py`

### T25 · News eval dataset (#36) — D3 · S · Must · G2
- [x] ≥ 30 hand-labelled news items in `evals/news.jsonl`; promptfoo config skeleton

**Verify:** promptfoo runs against the dataset · **Deps:** T24 · **Files:** `evals/news.jsonl`, `evals/promptfooconfig.yaml`

### P06 · Remaining hi-fi screens (#37) — PD · M · Must
- [ ] Portfolio, admin/Time Machine, Copilot, Agent Trace drawer, ledger tab, alerts, judge landing and tour hint style

**Verify:** Friday review · **Deps:** P03, P04 · **Files:** design file

### T54 · Accounts and sessions (#97) — D1 · M · Must · K1 K2
- [x] `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /me`; argon2id via `pwdlib`, with a dummy-hash verify for unknown emails; `users.kind` (person | persona | treasury) and a partial unique index on lower(email) per world
- [x] Server-side `sessions` (with `world_id`): a 256-bit token whose SHA-256 hash is stored; `nx_session` cookie `HttpOnly`, `Secure` (outside dev/test), `SameSite=Lax`; 7 d idle / 30 d absolute; new ID on login; logout deletes the row and clears the cookie
- [x] The live world is created and the 3 curated sites are copied into it from the template (T56 attaches their communities and treasuries); live admins are created only with a CLI command that reads the password via `getpass` (never via the API, never by matching an email); no password or token in logs

**Verify:** `make test`, including wrong password, unknown email, expired and revoked sessions, and logout; manual register → login → `/me` → logout with `curl` · **Deps:** T31 · **Files:** `backend/app/auth.py`, `backend/app/routers/auth.py`, `backend/app/cli.py`, `backend/app/models.py`, `backend/migrations/versions/*_accounts.py`, `backend/tests/test_auth.py`


### ✅ Checkpoint W2 (Fri Oct 9)
- [ ] Real satellite metrics, $ ranges and a grade for all 3 sites visible in the UI
- [ ] Buy and sell work; the community wallet receives IPO proceeds
- [ ] News Scout returns classified events for the hero site
- [ ] Skeleton deployed and reachable

---

## Week 3 · Live agents, ledger and trace (Mon Oct 12 – Fri Oct 16)

### T26 · Auditor (Nemotron 3 Ultra) (#38) — D3 · M · Must · B5
- [x] Input bundle (metrics, valuation, base scores, events, evidence, previous report) → schema-validated output; adjustment limited to ±10 with a reason; every claim cites a metric or event ID
- [x] Thinking handled per T02 (off for JSON, or reason-then-format); fallback tier on failure
- [x] Contract tests: numbers unchanged, citations resolve

**Verify:** `make test` · **Deps:** T09, T15, T24 · **Files:** `backend/app/agents/auditor.py`, `backend/app/agents/prompts/auditor.md`, `backend/tests/test_auditor.py`

### T72 · News Scout prompt-injection hardening (#123) — D3 · S · Must · B4
- [ ] Prompt: put the labelling guide's impact-type definitions and exclusions (tourism, sport, explainers → not relevant) into the system prompt. After the article blocks, add a data warning: text inside `untrusted_content` is data, and instructions or label assignments there are a sign of manipulation. Bump the prompt version.
- [ ] Quarantine before the model: drop and log any article whose title or content matches instruction patterns (EN/ES), e.g. `ignore (all )?(previous|prior) instructions`, `ignora (tus|las) instrucciones`, `</?(system|untrusted_content)`, `\b(relevant|impact_type|direction|severity)\s*=`, `nota para el modelo`. After the model: drop any event whose summary contains a schema-field assignment.
- [ ] Deterministic unit tests for the 3 T25 injection items; re-run the T25 eval and record the new `injection_resistance` and relevance scores in dev-spec §18

**Verify:** `make test`; T25 eval injection resistance 3/3 · **Deps:** T24, T25 · **Files:** `backend/app/agents/news_scout.py`, `backend/tests/test_news_scout.py`

### T27 · Orchestrator and async rating runs (#39) — D3 · M · Must · A3
- [x] Nemotron 3 Super tool-calling over earth_obs, valuation, news_scout, field_evidence and auditor; fixed-pipeline fallback
- [x] `POST` returns `202` + `run_id`; progress events per step; report stored and sealed
- Handoff: `start_rating_run(..., scenario=, trigger=)` is the entry point for T38 (Time Machine; `/admin/simulate/quarter` is still the mock), T58 and T60; T28 builds the trace from the `rating_progress` events' `llm_calls`; T40 plugs in an `EvidenceProvider`. See dev-spec §6 and §7.1 "As built (T27)".

**Verify:** `make test`; a live run on the hero site completes · **Deps:** T26, T19, T72 · **Files:** `backend/app/agents/orchestrator.py`, `backend/app/services/rating.py`

### T28 · Agent Trace API (#40) — D3 · S · Must · G1
- [x] Per-run trace: steps, model, tokens, latency, tool calls, safe tool-result summaries (from `llm_calls` snapshots + progress spans); optional Langfuse export deferred
  - As built: `GET /runs/{run_id}/trace` is scoped to the caller's world and asset visibility; reads live progress events or the full sealed-report trace snapshot after event pruning (older reports keep their legacy tool-only snapshot). `GET /admin/trace?asset_id=` reads real world-scoped `llm_calls` metadata (up to 50 newest), never synthetic model calls. No prompts or raw model responses are exposed.

**Verify:** `make test`; trace for an orchestrated run · **Deps:** T09, T27 · **Files:** `backend/app/routers/admin.py`, `backend/app/routers/runs.py`, `backend/app/services/rating_runs.py`

### T29 · Live events (SSE) (#41) — D1 · M · Must
- [x] `GET /events/stream` sends rating progress, price ticks and alerts for the visitor's world; polling fallback `GET /events?since=`

**Verify:** `make test`; events arrive in the browser · **Deps:** T08, T31 · **Files:** `backend/app/routers/events.py`, `backend/app/events.py`

### T30 · Nature Ledger (#42) — D1 · M · Must · F1 F2
- [x] Append-only, hash-chained entries written in the same transaction as listings, reports, events, price anchors and payouts (dev-spec §17)
- [x] `GET /ledger/{asset_id}` and `/verify`; tamper demo in `DEMO_MODE`

**Verify:** `make test` (valid chain, tamper detected) · **Deps:** T07 · **Files:** `backend/app/ledger.py`, `backend/app/routers/ledger.py`, `backend/tests/test_ledger.py`

### T31 · Per-visitor sandbox (#43) — D1 · S · Must · J
- [x] First visit creates a world (cookie) with personas, holdings and demo assets; "Reset my demo" restores it; worlds never affect each other

**Verify:** `make test` (two worlds isolated) · **Deps:** T07, T16 · **Files:** `backend/app/sandbox.py`, `backend/app/routers/admin.py`

### T32 · Frontend data layer (#44) — D1 · S · Must
- [x] Shared hooks for the API client, SSE subscription with polling fallback, sandbox cookie and error/loading states, so PD's screens stay presentational
- [x] On load, call `GET /world` once and wait for it before any other request; on a 401 `world_required`, call `GET /world` again and retry. Server-side fetches forward the visitor's `nx_world` cookie

**Verify:** `make fe-check` · **Deps:** T29, T31 · **Files:** `frontend/src/lib/*.ts`

### T33 · Listing flow and rating progress (#45) — PD · M · Must · A1–A3
- [x] Map drawing, area display and validation messages, community form, submit; live progress through the agent steps
  - As built: `/steward/list?community=<id>[&asset=<id>]` (`components/listing/`, one file per step; `lib/listing/`; the prototype's `DrawMap` gained `focus`, live outlines, text-only tooltips and a 300-marker cap) drives T58's lifecycle for signed-in stewards: details with the attestation, click-to-draw, typed or pasted corners with client hints (size only above 2,000 corners; pastes over 2 MB or 10,000 corners refused), then T36's 422 problems one per issue; create, edit (changed fields only), submit, revise and withdraw, with a message for every T58 code (incl. the 429 wait and a sign-in link on 401, the unsaved listing kept in `sessionStorage`). Progress is `GET /runs/{id}`, refetched on `rating_progress` events; the listing is re-read when its run ends and every 10 s while it waits. Outcomes cover listed (→ T64's `/steward/assets/<id>/ipo`), needs_evidence, ineligible, waiting for satellite data, stale and failed runs, and label mock ratings. `?asset=` resumes a draft or a listing under review through `AssetDetail.latest_run_id`; outlines come from `GET /assets/outlines` (server-simplified, cached per tab). The community form moved to T63; anonymous demo visitors keep the prototype flow.

**Verify:** `make fe-check`; a signed-in steward lists a new polygon end to end in the Steward app (`/steward/list`, lifecycle endpoints from T58) · **Deps:** T32, T36, T58, T62 · **Files:** `frontend/src/app/(steward)/steward/list/page.tsx`, `frontend/src/components/MapDraw.tsx`, `RatingProgress.tsx`

### T34 · Agent Trace drawer and ledger tab (#46) — PD · M · Must · G1 F2
- [x] Drawer lists each step (model, tokens, latency, output); ledger tab shows entries and the verify/tamper badge
  - As built: on a real site the drawer reads `GET /runs/{run_id}/trace` for the run picked from the site's reports (the asset page's "How it was rated" opens the latest one), with loading, error and empty (seeded-only) states; signed in elsewhere it lists the world's latest model calls (`GET /admin/trace`); anonymous visitors and the tour keep the scripted runs (dev-spec §3 "As built (T34)"). The real ledger tab's verify badge is the server's `GET /ledger/{id}/verify`; the tamper demo (`POST /admin/tamper-demo`) stays on the scripted world, since the API allows it only for admins in demo sandboxes with `DEMO_MODE`.

**Verify:** `make fe-check`; matches P06 · **Deps:** T28, T30, T32 · **Files:** `frontend/src/components/AgentTrace.tsx`, `LedgerTab.tsx`

### T35 · Map overlays and thumbnails (#47) — D2 · S · Must
- [x] Land-cover overlay and marketplace thumbnail images per demo site (precomputed)
  - As built: `scripts/precompute_sites.py --images` → `backend/data/demo_sites/images/<site>.overlay.png` (Dynamic World, transparent outside the polygon), `<site>.thumbnail.webp` (640×400 Sentinel-2) and `<site>.images.json` (bounds, legend, attributions); baseline only (scenarios have no per-pixel map). Served at `GET /media/demo-sites/{site_key}/…`; previewed on `/dev/ui`. Details in ADR-0004 (T35).
  - **Decided (ADR-0001 updated):** react-leaflet's licence is Hippocratic-2.1 (not OSI open source), so maps use plain Leaflet (BSD-2-Clause) in client components, as `LandCoverMap` does; T23 (asset page map) and T33 (MapDraw) follow the same approach.

**Verify:** images render in the UI · **Deps:** T13 · **Files:** `scripts/precompute_sites.py`, `backend/data/demo_sites/*.png`

### T36 · Polygon validation (#48) — D2 · S · Must · A1
- [x] Rejects self-intersection, < 10 ha or > 50,000 ha, and overlap with existing listings; area in an equal-area projection

**Verify:** `make test` · **Deps:** T07 · **Files:** `backend/app/tools/geometry.py`, `backend/tests/test_geometry.py`

### T37 · Report versions and diffs (#49) — D2 · S · Could (only if ahead; re-plan Oct 4) · B6
- [x] Each re-rating stores a new version; the diff endpoint lists changed metrics and the reasons

**Verify:** `make test` · **Deps:** T27 · **Files:** `backend/app/routers/reports.py`, `backend/app/services/diff.py`

### T40 · Field evidence (photos) (#50) — D2 · S · Could (only if ahead; re-plan Oct 4) · A4
- [x] Up to 5 geotagged photos → EXIF GPS/date check → MiniCPM-V description → evidence event → Auditor weighs it → confidence updated (ADR-0003)
- [x] Exposed as the `field_evidence` tool so the Orchestrator (T27) calls it when evidence exists
  - As built: the worker reads EXIF GPS and date, stores only a re-encoded JPEG without metadata; code checks the position (inside, or ≤ 100 m of the edge) and the date (≤ 1 year); MiniCPM-V answers labels only (no numbers, no free text) and can only fail a photo; a validated photo writes an `events` row (`source='evidence'`) whose fields come from fixed label tables. It sets the confidence evidence term (+14.0 points, never threat pressure). Steward screen `/steward/assets/{id}/evidence`, public aggregate on the asset page (month of the visit only). Real-model analysis in every world behind `FIELD_EVIDENCE_AI_LIVE` (off: photos are stored and checked but not validated). Lost analyses end `failed`; a deleted photo takes its event with it. See dev-spec §7.6 "As built (T40)".
  - Follow-up #214: the public panel explains field evidence in one line and how photos are added; community members get "Add field photos", and the Steward home and IPO screen link to the evidence screen.

**Verify:** `make test`; manual upload raises confidence · **Deps:** T09, T15 · **Files:** `backend/app/agents/field_evidence.py`, `backend/app/routers/assets.py`


### T41 · Revenue split and impact (#51) — D2 · S · Must · D4 E3
- [x] Pure functions for simulated quarterly revenue (2% of annual value / 4) split 50/50 community / dividends; portfolio impact metrics (ha, t CO₂, $ services) pro-rata; `pay_quarter` applies one quarter's payout transactionally for T38/T44
- Handoff: Time Machine triggering remains in T38, whose task calls the T41 payout helper each quarter.

**Verify:** `make test` · **Deps:** T16 · **Files:** `backend/app/market/revenue.py`, `backend/app/routers/market.py`


### T66 · Auth hardening: CSRF, rate limits and pruning (#109) — D3 · S · Must · K2
- [ ] CSRF on every unsafe method (POST, PUT, PATCH, DELETE, including multipart uploads): exact scheme/host/port allowlist (`ALLOWED_ORIGINS`) on `Origin`, falling back to `Referer`; reject when both are absent, malformed or `null`; JSON routes require a JSON media type
- [ ] Rate limits with independent per-IP and per-account buckets (account key = HMAC of the normalised email with `AUTH_RATE_LIMIT_SECRET`); client IP taken only through `TRUSTED_PROXY_HOPS`; atomic counting under an advisory lock; login 10 per 15 min, register 5 per hour
- [ ] Expired sessions and `auth_attempts` older than 24 h are pruned; registration enumeration is an accepted, documented risk (no email verification), and duplicate registration returns the same status and body shape

**Verify:** `make test`: forged-prefix origins, missing and `null` headers, concurrent attempts, both bucket dimensions · **Deps:** T54 · **Files:** `backend/app/auth.py`, `backend/app/middleware.py`, `backend/app/config.py`, `backend/tests/test_auth_hardening.py`

### T56 · Communities, treasury and tenant invariants (#99) — D1 · M · Must · A0 K3
- [x] `communities` and `community_members` (owner | steward) carry `world_id NOT NULL`; composite foreign keys `(world_id, …_id)` (unique `(world_id, id)` on users, assets, communities); a DB test shows cross-world inserts fail
- [x] One non-login, non-trading treasury user per community; `assets.community_id` set and `assets.community_user_id` = the treasury
- [x] Backfill the template and the live world (communities, owners and treasuries for the curated sites); discard pre-migration visitor sandboxes; `sandbox.py` clone, reset and prune cover the new tables; reset keeps persona user IDs (mapped by `persona_key`) so sessions survive; pruning deletes a world's sessions first

**Verify:** `make test` · **Deps:** T54 · **Files:** `backend/app/models.py`, `backend/migrations/versions/*_communities.py`, `backend/app/sandbox.py`, `backend/app/seed.py`, `backend/tests/test_tenancy.py`

### T68 · Authorization policy and community routes (#110) — D1 · M · Must · K3 C6
- [x] Pure `authorize(principal, action, resource)` implementing the ADR-0005 matrix: world scoping; members can't trade their community's asset; adding a member who holds its shares returns 409 `member_has_holdings`; admins and treasury accounts can't trade
- [x] A `require(action)` dependency; 401 `auth_required` / 403 with a reason / 404 across worlds; a matrix test covers every role × action, allowed and denied
- [x] `POST /communities` (creator becomes owner; treasury created), `GET`/`PATCH /communities/{id}` (owner). *Should:* add and remove stewards

**Verify:** `make test` · **Deps:** T56 · **Files:** `backend/app/authz.py`, `backend/app/routers/communities.py`, `backend/tests/test_authz.py`

### T55 · Demo sessions and persona switch (#98) — D3 · S · Must · J1 J2
- [ ] `POST /demo/start {persona}` creates a sandbox world and a demo session (hourly world cap kept); `POST /demo/persona` switches persona inside the same world only, revoking the old token and issuing a new one; `POST /world/reset` keeps the session
- Re-plan (Oct 18): retiring `nx_world` and reading the live world from the session moved to **T73**; this task keeps demo sessions only.

**Verify:** `make test` (two demo sessions isolated; a demo session can't reach the live world; a password session can't switch persona; reset keeps the active persona) · **Deps:** T54, T56, T73 · **Files:** `backend/app/sandbox.py`, `backend/app/deps.py`, `backend/app/routers/world.py`, `backend/tests/test_sandbox.py`

### T57 · Enforce authorization on every route (#100) — D1 · M · Must · K3 C6
- [x] Every route, GET included, loads resources by `(world_id, id)` before authorizing; state-changing routes use `require(...)`; orders and portfolio use the principal's user; admin routes are admin-only; the tamper demo runs in sandbox worlds only
- [x] A route-inventory test fails if any route lacks an authorization dependency, and a cross-world test returns 404 for every object endpoint
- [x] SSE and `GET /events` derive the principal and world from the session, revalidate it on every poll and heartbeat, close after logout, expiry or revocation, and deliver `alert` events only to their targets

**Verify:** `make test` · **Deps:** T68, T73, T17, T29 · **Files:** `backend/app/routers/*.py`, `backend/app/events.py`, `backend/tests/test_route_authz.py`

### T67 · Ledger privacy (#111) — D2 · S · Must · F1 K5
- [x] Public ledger payloads never contain user IDs, emails or names: payout entries record aggregates (revenue, community fund, dividends total, holder count) plus a hash commitment of the per-holder lines
- [x] Per-holder payout lines move to a private, erasable `payout_lines` table; a test scans every ledger payload kind for account identifiers

**Verify:** `make test`; ledger verify still passes · **Deps:** T30, T41 · **Files:** `backend/app/market/revenue.py`, `backend/app/ledger.py`, `backend/app/models.py`, `backend/app/sandbox.py`, `backend/migrations/versions/*_payout_lines.py`, `backend/tests/test_revenue.py`, `backend/tests/test_ledger_privacy.py`

### T58 · Listing lifecycle (#101) — D2 · M · Must · A3 A5 A6
- [x] Pure state machine: draft → rating → listed | needs_evidence | ineligible; needs_evidence → rating after evidence; listed ↔ suspended (admin). The listing gate applies at listing time only; invalid transitions are rejected
- [x] `POST /assets` creates a draft in the principal's community (attestation required, polygon validated by T36, no overlap within the world); `POST /assets/{id}/submit` starts a rating through the rating service, whose result sets the status
- [x] Every transition appends a ledger entry and publishes an event

**Verify:** `make test` · **Deps:** T19, T68, T36, T29, T30 · **Files:** `backend/app/services/lifecycle.py`, `backend/app/routers/assets.py`, `backend/tests/test_lifecycle.py`

### T59 · IPO launch (#102) — D2 · S · Must · A7 C4
- [x] `GET /assets/{id}/ipo/preview` returns the IPO price with every term of the dev-spec §8 formula
- [x] `POST /assets/{id}/ipo` (owner only, listed, once): validates shares offered and retained % (10–90); in one transaction writes the first `prices` row (`reason='ipo'`), seeds the treasury's retained holding, appends a ledger entry and opens the primary float
- [x] Orders on an asset without an IPO return 409 `not_trading`

**Verify:** `make test` · **Deps:** T16, T17, T30, T58 · **Files:** `backend/app/routers/ipo.py`, `backend/app/services/ipo.py`, `backend/tests/test_ipo.py`

### T61 · Sign-in screens and session handling (#104) — PD + D1 · S · Must · K1 K2
- [x] `/login`, `/register`, and an account menu with sign out; clear error states; no tokens in JS-readable storage
- [x] Protected routes (`/steward/*`, `/portfolio`, `/admin`) redirect to sign-in and back; the client handles 401 and 403 with clear messages
- As built: a client guard on `world.me` (`components/require-account.tsx`) instead of `middleware.ts`, which could only check that a cookie exists; pages stay at `app/login` and `app/register` (dev-spec "As built (T61)")

**Verify:** `make fe-check`; manual register → sign out → sign in · **Deps:** T54, T73 · **Files:** `frontend/src/app/(auth)/login/page.tsx`, `frontend/src/app/(auth)/register/page.tsx`, `frontend/src/middleware.ts`, `frontend/src/lib/session.ts`

### T62 · Two app shells and app switcher (#105) — PD · S · Must · K4
- [x] Route groups `(exchange)` at `/` and `(steward)` at `/steward`, each with its own shell and navigation, plus an `/admin` shell; the sandbox banner on every page
  - As built: the Steward app stays in `app/steward/` (same `/steward/...` URLs, no file moves); `(exchange)`, `steward` and `admin` layouts share `AppHeader` with per-app navigation. The sandbox notice and the demo bar slot (T65) sit in the root layout, so every page has them; a skip link jumps to each page's `<main id="main">`. Below `lg`, the pages and switchers move into a menu sheet.
- [x] An app switcher for community members; navigation follows the signed-in user's roles; a slot for the demo bar (T65)
  - As built: `appAccess()` (`lib/navigation.ts`) from `world.me` and `useMyCommunities()` (`GET /me/communities`): anonymous → Exchange (plus the Steward app in the scripted demo); no community → Exchange + "Create a community" (the Steward app's empty state until T63's form); owner or steward → Exchange ↔ Steward; admins also Admin. The Steward header lists the account's communities with a switcher when there's more than one; the shown community is in `?community=<id>` (else remembered per account, else the first) and pages read it with `useStewardCommunity()`. If `/me/communities` fails, the Steward app link still shows and its error screen retries. The UI only hides; the backend authorizes.

**Verify:** `make fe-check`; `web-design-guidelines` review · **Deps:** T61, T68 · **Files:** `frontend/src/app/(exchange)/layout.tsx`, `frontend/src/app/steward/layout.tsx`, `frontend/src/app/admin/layout.tsx`, `frontend/src/components/shell/*`, `frontend/src/lib/navigation.ts`, `frontend/src/lib/active-community.ts`

### T65 · Judge access (#108) — PD · S · Must · J1 J2
- [ ] `/judge`: one click on "Explore as a community steward / an investor / the platform admin" starts a demo session and opens the matching app; a "Create a real account" link
- [ ] In demo sessions, a demo bar on every page: persona switcher, Reset my demo, "private sandbox" label

**Verify:** `make fe-check`; manual: each button lands in the right app within 2 s · **Deps:** T55, T62 · **Files:** `frontend/src/app/judge/page.tsx`, `frontend/src/components/DemoBar.tsx`


### ✅ Checkpoint W3 (Fri Oct 16)
- [ ] A full rating run is **100% live AI** (Super → tools → Nano → Ultra), started from the UI
- [ ] Trace drawer shows every step; ledger verifies and the tamper demo fails as expected
- [ ] Listing a new polygon works; two browsers have separate sandboxes
- [ ] *(ADR-0005)* Register, sign in and sign out work; every state-changing route enforces authorization (route test green)
- [ ] *(ADR-0005)* A real account creates a community, lists the hero polygon, gets it rated and launches the IPO; a second account buys and the community wallet rises
- [ ] *(ADR-0005)* `/judge` opens a demo session as any persona in one click

---

## Week 4 · Monitoring loop, Copilot, evals, deploy (Mon Oct 19 – Fri Oct 23)

### T38 · Time Machine, re-rating and alerts (#52) — D1 · M · Must · D1–D4
- [x] "Next quarter" re-rates each asset with the next scenario version; event presets (fire, encroachment, drought, restoration, protection); prices re-anchor
- [x] "Next quarter" and presets reuse T75's re-rate, alerts and payout entrypoints (re-plan Oct 18: the real monitoring loop moved to **T75**)
- [x] `rerate_all` scheduled quarterly (`.github/workflows/rerate-all.yml`, safe without secrets)
- Handoff to T43: `GET /admin/time-machine` (`available` (false outside a sandbox: hide the controls), current/next quarter, timeline, presets), `POST /admin/simulate/quarter {period}` (per-asset before/after health, grade, price, alerts, payout) and `POST /admin/simulate/event {asset_id, preset}`; reset is `POST /world/reset`. See dev-spec §9 "As built (T38)" and §8 (re-anchoring).

- Follow-up #201: "Next quarter" runs in the background: `POST /admin/simulate/quarter` answers 202 with a `quarter_jobs` job (one queued/running per world, 409 `quarter_job_running` otherwise) and `GET /admin/simulate/quarter/{job_id}` returns its status and per-asset results; a job whose process died is taken over on the next poll or start (lease + heartbeat) and resumed through the monitor claims without re-rating or paying twice (migration 0025). The T43 panel polls the job, fills the result table as sites settle, follows a running job after a reload and offers "Finish <quarter>" for a failed or stopped one. Event presets stay synchronous (one asset, one run).

**Verify:** `make test`; manual encroachment gives grade A → BBB and an alert · **Deps:** T27, T16, T29, T41, T68, T75 · **Files:** `backend/app/routers/admin.py`, `jobs/*.py`, `.github/workflows/news-sweep.yml`

> **Notes from T13 (decided in its review):**
> - **Listing gate:** applies only at listing time. Re-rating a listed asset doesn't suspend it, even when a scenario (e.g. mangrove or forest encroachment) puts `forest_loss_last_12m_ha` over 1% of the area.
> - **Versions per site:** each asset moves through its own versions (`load_site_metrics(site_key, scenario)`: `baseline` 2026Q3 → `restoration` `sim-1` → `encroachment` `sim-2`; ADR-0004 T13 section). "Inject encroachment" moves only the targeted asset to its `encroachment` version; there's no shared timeline across sites.
> - **Simulated label:** for `simulated` versions, show a "Simulated" label and the `provenance_note`; never show `date_windows` as observation periods (they describe the observed data the deltas start from).

### T39 · Copilot (RAG) (#53) — D3 · M · Must · E1
- [x] Reports and events chunked and embedded (per T06) into pgvector; Nemotron Nano answers only from context with `[R…]`/`[E…]` citations; streamed

**Verify:** `make test`; "Why did the price drop?" cites the encroachment event · **Deps:** T27 · **Files:** `backend/app/rag/*.py`, `backend/app/routers/copilot.py`

> **Note from T39:** `POST /copilot` is now an SSE stream (`sources`, `delta`…, `done`; dev-spec §10), not JSON. The index is built lazily per world at question time (no write hooks); citations are `[R{version}]` and `[E{8 hex}]`, checked in code against the retrieved sources. The asset page has a working Copilot (`components/copilot-chat.tsx`); T44 still owns the portfolio-page chat and the impact summary, and the prototype's scripted Copilot sheet is unchanged. Tools (`get_price_history`, `compare_assets`, story E2) are not wired yet.

### T42 · Demo deploy (#54) — D1 · S · Must
- [ ] Full app deployed on the T20 host with live keys and `LLM_BUDGET_USD` set; keep-alive ping workflow if the host sleeps (free tiers)
- [ ] *(ADR-0006)* `VERIFICATION_MODE=demo` and `VERIFICATION_AI_LIVE=false` set; the README and Devpost text say listings are verified with sample documents in demo mode

**Verify:** the demo script runs on the public URL · **Deps:** T20, T38, T76 · **Files:** deploy config, `.github/workflows/keepalive.yml`

### T43 · Time Machine and alerts UI (#55) — D1 (with PD designs) · M · Must · D2 D3 C3
- [x] Admin panel (next quarter, event presets, reset), phone-style alerts, price chart with event markers
- Built: `/admin` runs the real Time Machine for an admin in a demo sandbox (confirmations, live progress, per-site results, every refusal explained) and explains the sandbox-only rule in the live world; a phone frame shows the alerts each run sent (`GET /admin/alerts?ids=`); the asset page's price chart numbers re-rate and event markers with a text list. See dev-spec §9 "As built (T43)".

**Verify:** `make fe-check`; encroachment flow in the browser, as an admin in `/admin` · **Deps:** T38, T32, T62 · **Files:** `frontend/src/app/admin/page.tsx`, `PriceChart.tsx`, `AlertsFeed.tsx`

> **Note from T13:** reports and charts built on a simulated version (`simulated: true`, `data_version` `sim-N`) must show a visible "Simulated" label and must not render `date_windows` as observation periods.

### T44 · Copilot and impact UI (#56) — PD · M · Must · E1 E3
- [x] Chat on asset and portfolio pages (streaming, citations link to sources); impact summary on the portfolio
  - As built: `components/copilot-chat.tsx` takes an optional `assetId`. The asset page asks about its site (T39); "Your stakes" (`/portfolio`) asks world-wide (`POST /copilot` without `asset_id`), with world-wide suggestions and each citation chip named after its site ("Osa Forest · Report v2") and linking to that site's report or news tab. `GET /portfolio` now fills `impact` from each site's latest report through T41's `impact_for_holding` (it was hard-coded to zero), so the impact card shows the account's hectares, tCO₂ and services per year. The header's Copilot button still opens the prototype's scripted sheet.
  - Follow-up #213: the header's Copilot button opens the real Copilot for a signed-in account (world-wide, or scoped to the open site's page with an "All sites" toggle and an optional site menu); anonymous visitors and the tour keep the scripted sheet.

**Verify:** `make fe-check` · **Deps:** T39, T41 · **Files:** `frontend/src/components/CopilotChat.tsx`, `ImpactSummary.tsx`

### T45 · Judge tour (#57) — PD (lead) + D2 · M · Must · J
- [ ] Driver.js tour as an optional overlay on demo mode (ADR-0005; `/judge` and the demo bar are T65): 10 chapters (demo-plan §3.3), "Do it for me", Live badges, two-layer hints

**Verify:** `make fe-check`; a newcomer completes the tour unaided · **Deps:** T33, T34, T43, T44, T65 · **Files:** `frontend/src/tour/*`, `frontend/src/app/judge/page.tsx`

### T46 · E2E demo test (#58) — D2 · S · Must
- [ ] Playwright runs the tour's autoplay path end to end; runs in CI; reused to record the video
- Re-plan (Oct 18): the real-account path moved to **T74**; this task keeps the tour autoplay and the demo path.
- [ ] *(ADR-0005)* Demo path: `/judge` → each persona; two demo sessions stay isolated from each other and from the live world

**Verify:** `make e2e` green locally and in CI · **Deps:** T45, T65, T74, T76 · **Files:** `frontend/e2e/demo.spec.ts`, `.github/workflows/e2e.yml`

### T47 · Eval harness (#59) — D3 · M · Must · G2 G3
- [ ] `make eval`: news classification, Auditor faithfulness and direction, schema reliability, Copilot grounding, and the Nano/Super/Ultra routing comparison (dev-spec §18)
- [ ] Results written to `evals/results.md`; GitHub Action on manual/nightly trigger

**Verify:** `make eval` meets the §18 targets · **Deps:** T25, T26, T39 · **Files:** `evals/*`, `.github/workflows/eval.yml`

### T48 · UI polish and accessibility pass (#60) — PD · M · Must
- [ ] `/impeccable audit` + `critique` fixes; `web-design-guidelines` review; keyboard and contrast checks; empty, loading and error states

**Verify:** audit score recorded; no blocking issues · **Deps:** T33, T34


### T60 · Live rating for new listings (#103) — D2 · M · Must · A3
- [x] `earth_obs` computes metrics for any validated polygon live on Earth Engine, using the T11/T13 methods, with a timeout and a cache keyed by geometry hash; the orchestrator (T27) uses it for new listings
- [x] Quotas: 2 live ratings per user per day plus the global `LLM_BUDGET_USD`. On failure the listing stays in `rating` with a retry; it never shows another site's data
- [x] In demo worlds only, a failed live run may show the nearest cached site with an explicit "cached example" notice
- As built: methods shared in `app/tools/earth_engine.py`; `services/earth_obs_live.py` (cache `earth_obs_cache`, quotas `live_rating_requests`, migration `0015`); off unless `EARTH_ENGINE_LIVE=true`; live world only (demo sandboxes never computed and got the cached example; since then they compute under their own allowances, `SANDBOX_LIVE_RATINGS_PER_WORLD_PER_DAY` and `SANDBOX_LIVE_RATINGS_PER_DAY`, falling back silently past them, migration `0029`); plus a global daily cap and a 5,000 ha live cap; `AssetDetail.cached_example` (`services/cached_example.py`) is API-only, its UI is T76/T55 (dev-spec §7.2 "As built (T60)")

**Verify:** `make test` (Earth Engine mocked); manual live rating of a new polygon · **Deps:** T13, T19, T27, T58 · **Files:** `backend/app/tools/earth_obs.py`, `backend/app/services/rating.py`, `backend/tests/test_earth_obs_live.py`

### T63 · Steward home and community management (#106) — PD + D1 · M · Must · A0 A8 D4
- [ ] Create or edit a community (A0); owner sees members
- [ ] Home (`GET /communities/{id}/summary`): listings with status and next action; IPO proceeds, community-fund payouts and retained-stake dividends with clear totals; holders; alerts and stewardship recommendations (alerts appear once T75 lands)

**Verify:** `make fe-check`; manual: a new account creates a community and sees an empty home with "List your land" · **Deps:** T68, T58, T59, T41, T62 · **Files:** `frontend/src/app/(steward)/steward/page.tsx`, `frontend/src/app/(steward)/steward/community/page.tsx`, `frontend/src/components/WalletCard.tsx`, `backend/app/routers/communities.py`

### T64 · IPO launch screen (#107) — PD · S · Must · A7
- [ ] The owner sets shares offered and retained %; a preview shows the IPO price formula step by step; confirming launches the IPO and the asset becomes tradable in the Exchange

**Verify:** `make fe-check`; manual launch, then a second account buys · **Deps:** T59, T62 · **Files:** `frontend/src/app/(steward)/steward/assets/[id]/ipo/page.tsx`, `frontend/src/components/IpoPreview.tsx`

### T69 · Listing verification core (deterministic checks, review, revoke) (#113) — D3 · M · Must · A9
- [ ] Private document upload and serving: PDF/JPEG/PNG, ≤ 5 MB, magic bytes, decoded-pixel and PDF page/object limits, encrypted or malformed PDFs rejected, parsing in a worker with a timeout, sanitised previews; `GET /assets/{id}/documents/{doc_id}` loads by `(world_id, asset_id, id)` for the community's members and same-world admins only (404 otherwise), `Content-Disposition: attachment`, `nosniff`, `no-store`; per-world keyed fingerprint bound to one asset (no reuse across listings; same listing may reuse it)
- [ ] Write-once verification runs (trigger-enforced) with an input fingerprint (community, name, geometry, area, document commitments, method version) and one current run per asset (partial unique index); documents link only to runs of their own asset; any change to those inputs makes the listing unverified; deterministic checklist (accepted file format, not reused, no boundary overlap, consent-labelled document attached) with pass/warn/fail and values; reviewer approve/reject with a reason; `verification` ledger entries with randomized document commitments (no raw hashes, names or account IDs)
- [ ] Gates: the live-world IPO transaction locks the asset and needs the current run `verified` with a matching fingerprint (409 `not_verified`); revoke (admin, reason) atomically suspends the asset and blocks orders until a new verified run; authorization tests for investors, non-members, other communities, other worlds and anonymous users
- Re-plan (Oct 18): verification **demo mode** (sample documents, `demo_auto`, mode switch) moved to **T76**; this task ships review mode (real documents, admin decision).

**Verify:** `make test`: hostile files, stale-fingerprint bypass, revoke during trading, cross-world document access, ledger payload privacy; manual: upload → admin approves → IPO → revoke · **Deps:** T58, T59, T68, T57, T66, T30 · **Files:** `backend/app/services/verification.py`, `backend/app/routers/verification.py`, `backend/app/models.py`, `backend/migrations/versions/*_verification.py`, `backend/tests/test_verification.py`

### T71 · AI document extraction for verification (heuristic) (#115) — D3 · S · Should · A9
- [ ] MiniCPM-V extracts fields (holder name, parcel ID, place, area, issue date) from sanitised previews; Nemotron compares them with the listing (name, place via reverse geocode, area ±20%) and suggests consistent | inconsistent | unreadable with reasons and source excerpts; no tools, no other tenants' data, no secrets; output schema-validated
- [ ] Treated as attacker-controlled: shown to the reviewer as an untrusted heuristic next to the source excerpts; can't change deterministic checks or the verification level; raw prompts and responses are never logged (only `llm_calls` metadata)
- [ ] Adversarial PDFs and images (injected instructions) in tests prove the level and deterministic checks are unaffected; off in the live world (`VERIFICATION_AI_LIVE=false`) until Token Factory data terms are confirmed, so sandboxes send only seeded demo documents

**Verify:** `make test` with a fake LLM and adversarial fixtures · **Deps:** T69, T09 · **Files:** `backend/app/agents/document_check.py`, `backend/tests/test_document_check.py`, `backend/tests/fixtures/verification/*`

**As built:** see dev-spec §6.4. The suggestion is stored in its own write-once table (`verification_ai_suggestions`, migration 0019) rather than on the run, and only the admin queue returns it (`ai_suggestion`, `trust: untrusted_heuristic`); sandboxes send only sample documents, so with real models nothing is sent until T76 generates them. The queue item also has `ai_suggestion_status` (pending | not_run | completed | failed); only a holder-name match can make it `consistent`.
- Follow-ups before `VERIFICATION_AI_LIVE=true`: a live smoke test of MiniCPM-V and Nano through Token Factory (strict `json_schema`, thinking toggle, image token counts); Token Factory data terms confirmed. The ADR-0006 §5 uploader notice and the review page's suggestion shipped in #196 (`GET /world` `document_ai_check`, `GET /admin/verifications?asset_id=`). The injection regex is one layer of several, never complete. Later: a reviewer-triggered re-run.

### T70 · Verification screens and transparency panel (#114) — PD + D1 · S · Must · A9
- [ ] Steward: upload documents ("Use sample documents (demo)" is T76); see the checklist and the decision; the IPO screen explains why launch is blocked until verified
- [ ] Exchange: a badge with precise wording by evidence, not deployment mode (sample runs: "Demo verification: sample documents, no real ownership checked"; human-reviewed real documents: "Documents reviewed by NatureX (hackathon process)"; "Self-attested by the community"; "Verification revoked"); a site footer note when demo mode is on and a public "How this listing was verified" panel: level, date, reviewer role, each check's result, everything not checked, link to the ledger entry
- [ ] Admin: a review queue with document previews, the checklist, any AI suggestion labelled as an untrusted heuristic with source excerpts, and the map; approve, reject or revoke with a reason

- As built: steward `/steward/assets/[id]/verify` (upload, submit, checklist, decision; linked from Steward home and the IPO screen's `not_verified` alert); Exchange hero badge and "How this listing was verified" panel (`components/verification/verification-panel.tsx`, the API's `badge` verbatim; the ledger link scrolls to the entry); admin `/admin/verifications` queue and `/admin/verifications/[id]` review (previews, checklist, map, approve/reject/revoke). The AI suggestion area shows T71's untrusted suggestion with its states and excerpts, and the upload card the uploader notice (#196, dev-spec §6.4); the sample button, sample badge source and footer switch stay with T76.
- Fixes from local use (#210, #211): while a run waits for a decision, the steward's screen says "Add to your submission" and lists exactly what the reviewer will see (the waiting run's documents, which can be unticked, plus the new ones; at most 3); the new run keeps those documents (`verification_run_documents`, migration 0022), so the reviewer sees everything submitted. A submission after a decision starts afresh. The admin area has Waiting, Verified, Rejected and Revoked views (`GET /admin/verifications/decided`, latest decision first, paged); a decided listing's row opens its review page, with its history and revoke where valid. Superseded runs read "Replaced by a later submission".

**Verify:** `make fe-check`; `web-design-guidelines` review; manual upload → approve → badge → revoke · **Deps:** T69, T62 · **Files:** `frontend/src/app/(steward)/steward/assets/[id]/verify/page.tsx`, `frontend/src/components/VerificationPanel.tsx`, `frontend/src/app/admin/verifications/page.tsx`


### T73 · World from the session (live world for real accounts) (#166) — D1 · S · Must · K1 K3
- [ ] The world comes from the session, never a client value: anonymous requests and password sessions read the **live world**; the `nx_world` cookie is no longer issued or read; sandbox worlds are reachable only through demo sessions (T55)
- [ ] Anonymous requests are read-only: every unsafe method on a world route returns 401 `auth_required`; a signed-in user's orders and portfolio use their own account (no persona fallback)
- [ ] `GET /world` returns the live world (and the principal when signed in); tests that relied on visitor sandboxes move to explicit sandbox fixtures; the frontend data layer still loads

**Verify:** `make test`; manual: register → buy a seeded live asset → portfolio shows it; anonymous `POST /orders` → 401 · **Deps:** T54, T56 · **Files:** `backend/app/deps.py`, `backend/app/routers/world.py`, `backend/app/routers/market.py`, `backend/app/sandbox.py`, `backend/tests/test_world_from_session.py`

### T74 · Real-account E2E test (both apps) (#167) — D2 · M · Must · A0–A9 C1–C4 K1–K4
- [x] Playwright on the real stack (`USE_MOCKS=true` for LLM and Earth Engine): owner registers → creates a community → draws a polygon on the real map (clicks on Leaflet) and lists it → rating completes → uploads documents → an admin approves in the review queue → launches the IPO → a second account registers, buys and sells → portfolio and the community home reflect it → sign out. The admin comes from the operator CLI (`create-admin --password-stdin`, new for scripts), never a sign-up
- [x] An investor gets a clear 403 on Steward actions (the API's `owner_only` / `members_only` through the browser session, the control room's 403 message, and no Steward controls on another community's pages); anonymous visitors browse but can't trade ("Sign in to trade", `POST /orders` 401)
- [x] `make e2e` locally (Playwright starts and stops the API and a production build on ports 8100/3100 with a freshly recreated `naturex_e2e` database; unique accounts per run); `.github/workflows/e2e.yml` on PRs touching `frontend/` or `backend/`, concurrency-cancelled, report and traces uploaded on failure

**Verify:** `make e2e` green locally and in CI · **Deps:** T18, T22, T23, T33, T63, T64, T70 · **Files:** `frontend/e2e/real-accounts.spec.ts`, `frontend/e2e/{env,png}.ts`, `frontend/playwright.config.ts`, `scripts/e2e-backend.sh`, `Makefile`, `.github/workflows/e2e.yml`, `backend/app/cli.py`

### T75 · Monitoring loop: scheduled re-rate, news sweep and alerts (#168) — D1 · M · Should · D1 D3 D4 C3
- [x] `rerate_all` and `news_sweep` (`backend/app/jobs/`, logic in `services/monitoring.py`; idempotent via `monitor_runs` claims, budget-capped; the sweep runs daily via GitHub Actions) re-rate live listed assets through the rating service
- [x] Alerts on health Δ ≥ 5, a grade change or news severity ≥ 4, to the asset's holders and its community's members only; each quarter pays out via T41
- [x] An alerts list in both apps (read/unread) fed by real `alert` events
  - Follow-up #199: the header bell shows a signed-in account's real alerts in every app (unread count from `GET /alerts` in the button's label, announced when new alerts arrive; the popover is `AlertsList` with mark read, mark all read and site links); anonymous visitors keep the prototype's scripted bell.

**Verify:** `make test`; manual: a grade-changing re-rate alerts a holder and the owner · **Deps:** T27, T41, T57 · **Files:** `backend/app/jobs/*.py`, `backend/app/services/{alerts,monitoring}.py`, `backend/app/routers/alerts.py`, `backend/migrations/versions/0017_monitoring_alerts.py`, `.github/workflows/news-sweep.yml`, `frontend/src/components/alerts-list.tsx`, `frontend/src/components/proto/alert-toaster.tsx`

### T76 · Verification demo mode (sample documents, auto-approval) (#169) — D3 · S · Must · A9 J1
- [ ] `VERIFICATION_MODE=demo` (default `review`): `POST /assets/{id}/documents/sample` (404 in review mode) generates watermarked fictional documents; `mode` write-once and `evidence_kind` derived by trigger, both in the fingerprint
- [ ] `demo_auto` approves only demo + all-sample + all checks pass + not revoked (DB constraint); only a human clears a revocation; the review-mode IPO gate needs real evidence; switching demo → review invalidates demo runs and suspends their trading
- [ ] Steward "Use sample documents (demo)", the sample-run badge and the demo-mode footer note

**Verify:** `make test` in both modes; manual: sample docs → auto-approved → IPO · **Deps:** T69, T70 · **Files:** `backend/app/services/verification.py`, `backend/app/routers/verification.py`, `backend/migrations/versions/*_verification_demo.py`, `frontend/src/components/proto/verification.tsx`


### ✅ Checkpoint W4 (Fri Oct 23) = FEATURE FREEZE
- [ ] The public URL runs the whole 3-minute demo script, including the judge tour
- [ ] *(ADR-0005)* Both apps work for real accounts: Steward (community, listing, live rating, IPO, wallet) and Exchange (browse, trade, portfolio, alerts)
- [ ] *(ADR-0006)* Listing verification: documents → visible checklist → decision in the ledger → "How this listing was verified" panel; the live-world IPO needs `verified`; the deployment runs in labelled demo mode (sample documents, auto-approved, disclosed)
- [ ] `make eval` and `make e2e` green; UI polish pass done
- [ ] **No new features after this point**

---

## Week 5 · Demo & presentation (Mon Oct 26 – Thu Oct 29)
**No new features.** Only the demo video, the Devpost presentation, docs, judging readiness and fixes for bugs found while recording.

### T49 · README, Devpost text and feedback (#61) — D3 (+D2) · S · Must
- [ ] README: setup, run, architecture image, **how Nemotron and Token Factory are used**, routing and eval tables, data attributions
- [ ] Devpost description, testing instructions (demo-plan §6), product feedback write-up (Most Valuable Feedback)

**Verify:** a teammate follows the README from a clean clone · **Deps:** T47, T42 · **Files:** `README.md`, `docs/devpost.md`

### T50 · Demo video (#62) — PD (lead) + All · M · Must
- [ ] Script, Playwright-recorded footage, voice-over, edit and captions per demo-plan §4; < 3:00; no third-party logos or unlicensed music; public on YouTube

**Verify:** pre-publish checklist (demo-plan §4.3) · **Deps:** T46, T48

### T53 · Presentation kit (#63) — PD + D2 · S · Must
- [ ] 5–8 Devpost gallery images taken from the real app, plus an architecture image (no third-party logos)
- [ ] Cover thumbnail for YouTube and Devpost; project tagline and one-line pitch
- [ ] Optional: a 5-slide deck for social posts or a city event

**Verify:** team review against the Devpost page preview · **Deps:** T46, T48 · **Files:** `docs/presentation/*`

### T51 · Judging readiness (#64) — D1 · S · Must
- [ ] Budget reserve for Dec 1–15, cached fallbacks, keep-alive, several concurrent sandboxes tested; calendar reminder to re-check before Dec 1
- [ ] Fix bugs found while recording the video (fixes only, no features)

**Verify:** readiness checklist signed off · **Deps:** T42

### T52 · Submit on Devpost (Thu Oct 29) (#65) — All · XS · Must
- [ ] **Before making the repo public:** secret scan of the full git history and all issues/PRs; remove anything private from issues and comments (or keep it as project draft items); confirm `LICENSE` shows in the GitHub "About" section
- [ ] Make the repo public, then check every item in `pm-spec.md` §9; submission saved and confirmed

**Verify:** secret scan clean; repo page shows the MIT licence; confirmation email · **Deps:** T49, T50, T51, T53

### ✅ Checkpoint: Complete
- [ ] All Must stories meet their acceptance criteria
- [ ] Submitted a day early, with the demo live and the video public

---

## Backlog (Could, only if ahead)
A5 stewardship plan · E2 compare assets · live rating of any user-drawn polygon · Spanish report · F3 OpenTimestamps anchoring · deploy on Nebius Serverless Endpoint/Jobs if event credits arrive.
