# NatureX task list

> **Tracked in GitHub Issues** ([melvin1117/naturex](https://github.com/melvin1117/naturex/issues)): epics #1–#6, tasks #7–#65 (issue number shown after each title). **The issues are the source of truth for status**; update this file only when scope changes.
> **What can I pick?** Open [task-map.html](./task-map.html) (auto-synced from the issues): 🟢 ready tasks have every dependency closed. Keep the heading format and `**Deps:**` lines below intact; `scripts/task_map.py` parses them.
> Plan and team roles: [plan.md](./plan.md). Owners: **PD** (product designer + frontend), **D1** (platform & market), **D2** (geo & rating data), **D3** (AI agents).
> Each task shows **owner · size · priority · stories covered**. Sizes: XS/S (1–2 files), M (3–5 files); nothing larger. Priorities: Must / Should / Could (from `pm-spec.md` §5).
> Standard checks, created in T04/T05: `make lint`, `make test` (backend), `make fe-check` (frontend lint, types, build), `make eval`, `make e2e`. Every task also meets the Definition of Done in [AGENTS.md](../AGENTS.md).

---

## Week 1 · Foundations and walking skeleton (Mon Sep 28 – Fri Oct 2)

### T01 · Accounts, credits and keys (#7) — All · XS · Must
- [ ] Each member claims the Token Factory promo ($25, code `NEBIUS-DEVPOST-GLOBAL26`) and joins the Nebius Builders Program ($25 Token Factory + $25 Tavily)
- [ ] D2 registers an Earth Engine non-commercial project; hosting accounts are set up in T20; one person owns the shared deployment keys
- [ ] Keys live only in personal `.env` files; `.env.example` lists the variable names

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
- [ ] `LICENSE` (MIT); `backend/` with uv, FastAPI `/healthz`, pydantic-settings; `compose.yml` with `pgvector/pgvector:pg16`
- [ ] ruff, `mypy --strict`, pytest, pre-commit; root `Makefile` with `lint`, `test`
- [ ] GitHub Actions backend job; `main` branch ruleset (PR + 1 review + green CI); CODEOWNERS, PR template

**Verify:** `make lint && make test`; CI green on the first PR · **Deps:** none · **Files:** `LICENSE`, `backend/pyproject.toml`, `backend/app/main.py`, `compose.yml`, `.pre-commit-config.yaml`, `.github/workflows/backend.yml`, `Makefile`

### T05 · Frontend skeleton (#11) — D1 · M · Must
- [ ] Next.js (version per T06) App Router, TypeScript strict, Tailwind v4, shadcn/ui init, ESLint 9 + Prettier
- [ ] Route stubs for `/`, `/list`, `/asset/[id]`, `/portfolio`, `/admin`, `/dev/ui`; persistent sandbox banner (C5)
- [ ] `make fe-check` and a GitHub Actions frontend job

**Verify:** `make fe-check`; `pnpm dev` shows all routes · **Deps:** T04, T06 · **Files:** `frontend/**` (scaffold), `.github/workflows/frontend.yml`

### T06 · Architecture decisions (ADR session, day 1) (#12) — D1 (writes) + All · S · Must
- [ ] ADRs 0001–0002 (stack & versions, repo layout) plus decisions on each open item in `plan.md` "Architecture decisions"
- [ ] Accepted changes applied to `docs/specs/dev-spec.md`, the Rating Engine page in `docs/diagrams.html` and `research.md` (mark OpenSpec as replaced by Addy's skills)

**Verify:** ADRs merged; docs agree (link check passes) · **Deps:** none · **Files:** `docs/adr/0001-*.md`, `docs/adr/0002-*.md`, `docs/specs/dev-spec.md`, `docs/diagrams.html`

### T07 · Database schema v1 (#13) — D1 · M · Must
- [ ] SQLModel models and first Alembic migration for every table in dev-spec §5, **plus `world_id` on all tables that change during the demo** (sandbox, demo-plan §3.5)
- [ ] Seed script: 4 personas, 3 demo assets
- [ ] Tests: migration up/down, seed is idempotent

**Verify:** `make test`; `docker compose up` then seed · **Deps:** T04, T06 · **Files:** `backend/app/models.py`, `backend/migrations/**`, `backend/app/seed.py`, `backend/tests/test_models.py`

### T08 · API contract v1 + generated client (#14) — D1 (+D3 for agent schemas) · M · Must
- [ ] All dev-spec §6 routes exist and return typed **mock data** (`USE_MOCKS=true`), including Pydantic schemas for News Scout and Auditor outputs
- [ ] `openapi-typescript` + `openapi-fetch` client generated into `frontend/src/lib/api/`; CI fails if the client is out of date

**Verify:** `make test`; `make fe-check`; client drift check in CI · **Deps:** T04, T05, T07 · **Files:** `backend/app/routers/*.py`, `backend/app/schemas.py`, `scripts/generate-client.sh`, `frontend/src/lib/api/*`

### T09 · Token Factory LLM client (#15) — D3 · S · Must
- [x] One wrapper for all model calls: model routing from env, retries, schema validation, fallback tier, `LLM_BUDGET_USD` cap
- [x] Every call logged to `llm_calls` (agent, model, tokens, latency, cost)
- [x] Unit tests with mocked HTTP (budget cap refuses calls, invalid JSON retries)

**Verify:** `make test` · **Deps:** T02, T07 · **Files:** `backend/app/llm.py`, `backend/tests/test_llm.py`

### T10 · Live AI summary endpoint (#16) — D3 · S · Must
- [ ] For a demo asset, the reports API returns a report whose summary is written live by Nemotron from (mock) metrics
- [ ] The call appears in `llm_calls`

**Verify:** `curl` the endpoint; a row appears in `llm_calls` · **Deps:** T08, T09 · **Files:** `backend/app/agents/summary.py`, `backend/app/routers/reports.py`

### T11 · Hero-site precompute (#17) — D2 · M · Must · B1 B2
- [ ] Hero wetland polygon (GeoJSON) drawn on the real wetland: the seed placeholder is 93% built-up town; the wetland is ~3 km north, near Xochimilco Ecological Park (box SW corner −99.105, 19.28; ADR-0004), and `scripts/precompute_sites.py` producing cached metrics JSON: land-cover fractions, NDVI series + trend, water change, forest loss, biomass, cloud-free coverage (methods per T06)
- [ ] Dataset versions and attributions stored in the output

**Verify:** script reproduces the committed JSON · **Deps:** T03, T06 · **Files:** `backend/data/demo_sites/*.geojson|json`, `scripts/precompute_sites.py`, `backend/app/tools/earth_obs.py`

### T12 · Bare report page (walking skeleton) (#18) — D3 · S · Must
- [ ] `/asset/[id]` shows the report's key numbers and the live AI summary from the API (unstyled is fine)

**Verify:** `make fe-check`; manual check in the browser · **Deps:** T05, T08, T10 · **Files:** `frontend/src/app/asset/[id]/page.tsx`

### P01 · Product brief and voice (#19) — PD · S · Must
- [ ] `PRODUCT.md` via `/impeccable init` (audience, purpose, voice, constraints, anti-patterns)
- [ ] UX writing rules: numbers always as range + confidence, sandbox wording, grade language

**Verify:** team review · **Deps:** none · **Files:** `PRODUCT.md`, `docs/design/ux-writing.md`

### P02 · User flows and information architecture (#20) — PD · M · Must
- [ ] Flows for Rosa (community), Arjun (investor), NatureX AI (under the hood), Time Machine, and the judge tour chapters (demo-plan §3.3)
- [ ] Sitemap and navigation; persona switcher behaviour

**Verify:** team walkthrough · **Deps:** P01 · **Files:** `docs/design/flows.md` (links to the design file)

### P03 · Wireframes for all screens (#21) — PD · M · Must
- [ ] Marketplace, listing (map + form), rating progress, asset page, portfolio, admin/Time Machine, Copilot, Agent Trace drawer, ledger tab, judge landing

**Verify:** each wireframe maps to user stories in `pm-spec.md` · **Deps:** P02 · **Files:** design file, `docs/design/`

### P04 · Design system v1 (#22) — PD · M · Must
- [ ] Tokens: colour (incl. grade scale and chart palette), type, spacing, radius, elevation; shadcn theme mapping; component inventory
- [ ] Handed off as a Tailwind v4 `@theme` spec that T21 turns into code

**Verify:** tokens documented and reviewed · **Deps:** P01 · **Files:** `docs/design/tokens.md`

### P05 · Hi-fi key screens (#23) — PD · M · Must
- [ ] Asset page (hero screen), marketplace and listing flow in high fidelity, using P04 tokens

**Verify:** Friday review; `/impeccable critique` pass · **Deps:** P03, P04 · **Files:** design file

### ✅ Checkpoint W1 (Fri Oct 2)
- [ ] One demo site: list → (mock) rating → report page with a **real Nemotron summary**
- [ ] CI green on backend and frontend; `docker compose up` works from a clean clone
- [ ] Flows, wireframes and tokens reviewed; ADRs merged

---

## Week 2 · Real data and the exchange (Mon Oct 5 – Fri Oct 9)

### T13 · Remaining demo sites and scenarios (#24) — D2 · M · Must
- [ ] Mangrove and restoration-forest sites precomputed like T11
- [ ] Time Machine scenario versions for each site (baseline, restoration, encroachment), generated as scripted deltas

**Verify:** script reproduces all JSON · **Deps:** T11 · **Files:** `backend/data/demo_sites/*`, `scripts/precompute_sites.py`

### T14 · Valuation engine (#25) — D2 · M · Must · B3
- [ ] Coefficient table per T06 (cited; no raw ESVD), class → biome mapping including the coastal check (Natural Earth)
- [ ] Low / mid / high $/yr and per-service breakdown; carbon stock per the agreed formula
- [ ] Unit tests including the worked example

**Verify:** `make test` · **Deps:** T06, T11 · **Files:** `backend/app/tools/valuation.py`, `backend/data/coefficients.csv`, `backend/data/coastline/*`, `backend/tests/test_valuation.py`

### T15 · Scoring, grade, confidence and listing gate (#26) — D2 · M · Must · B5
- [ ] Pure functions for V, N, L, W, T, health, grade, confidence and the listing gate (dev-spec §7.4, as updated by T06)
- [ ] Unit tests for bounds, thresholds and the worked example

**Verify:** `make test` · **Deps:** T11 · **Files:** `backend/app/tools/scoring.py`, `backend/tests/test_scoring.py`

### T16 · Market engine (#27) — D1 · M · Must · C2 C4
- [ ] IPO price from fair value; instant fills with slippage; primary shares credit the community wallet; price moves with order flow and re-anchoring (dev-spec §8)
- [ ] Invariant tests: no negative cash, shares conserved, price > 0, every price change has a reason

**Verify:** `make test` · **Deps:** T07 · **Files:** `backend/app/market/engine.py`, `backend/tests/test_market.py`

### T17 · Orders and portfolio API (#28) — D1 · S · Must · C2 E3
- [ ] `POST /orders` and `GET /portfolio` backed by the engine, scoped to the visitor's `world_id`

**Verify:** `make test` (API tests) · **Deps:** T08, T16 · **Files:** `backend/app/routers/market.py`, `backend/tests/test_market_api.py`

### T18 · Trade panel and portfolio UI (#29) — D1 (with PD designs) · M · Must · C2
- [ ] Buy/sell panel on the asset page with validation and play-money balance; portfolio page with holdings and P&L

**Verify:** `make fe-check`; manual buy then sell · **Deps:** T17, T21, P05 · **Files:** `frontend/src/components/TradePanel.tsx`, `frontend/src/app/portfolio/page.tsx`

### T19 · Deterministic rating into the reports API (#30) — D2 · S · Must · B1–B3 B5
- [ ] Rating service runs earth_obs (cached) → valuation → scoring for each demo site and stores report v1 (no agents yet); the reports API serves real data instead of mocks

**Verify:** `make test`; asset page shows real numbers · **Deps:** T14, T15, T08 · **Files:** `backend/app/services/rating.py`, `backend/app/routers/reports.py`

### T20 · Deploy skeleton (risk) (#31) — D1 · S · Must
- [ ] Pick the host from dev-spec §21 (Nebius Serverless if credits → Azure Container Apps + Azure Postgres if the team approves the credits and they last to Dec 15 and allow a public demo → HF Spaces/Render + Supabase); record the choice in the README
- [ ] Frontend on Vercel; backend container + Postgres (with `vector`) on the chosen host; secrets in host settings, never in the repo
- [ ] Browser traffic goes through the frontend's `/api/*` rewrite to the backend (`BACKEND_URL`, next.config.ts), so the `nx_world` sandbox cookie stays first-party; backend `ENVIRONMENT=production` so the cookie is `Secure`
- [ ] `/healthz` reachable; README notes the URLs

**Verify:** public URL loads the marketplace · **Deps:** T04, T05 · **Files:** `backend/Dockerfile`, deploy config

### T21 · Design system in code (#32) — PD · M · Must
- [ ] P04 tokens as Tailwind v4 theme + shadcn theme; app shell, navigation, persona switcher shell; `/dev/ui` shows every component and state

**Verify:** `make fe-check`; `/dev/ui` reviewed · **Deps:** P04, T05 · **Files:** `frontend/src/app/globals.css`, `frontend/src/components/ui/*`, `frontend/src/app/dev/ui/page.tsx`

### T22 · Marketplace (#33) — PD · M · Must · C1
- [ ] Asset cards (name, thumbnail, price, change, grade, trend, confidence), sort and filter, from the API

**Verify:** `make fe-check`; `web-design-guidelines` review · **Deps:** T21, T08 · **Files:** `frontend/src/app/page.tsx`, `frontend/src/components/AssetCard.tsx`

### T23 · Asset page v1 (#34) — PD · M · Must · B1–B3 B5
- [ ] Report card (grade, health, value range, confidence), land-cover and NDVI charts, map, data attribution footer

**Verify:** `make fe-check`; matches P05 · **Deps:** T21, T19 · **Files:** `frontend/src/app/asset/[id]/page.tsx`, `frontend/src/components/ReportView.tsx`, charts

### T24 · News Scout (#35) — D3 · M · Must · B4
- [ ] Nominatim reverse geocode (1 req/s, cached) → Tavily queries → Nemotron Nano classification into the event schema; untrusted-content guard; 24 h cache
- [ ] Contract tests on recorded fixtures (no live calls in CI)

**Verify:** `make test`; manual run for the hero site · **Deps:** T09 · **Files:** `backend/app/agents/news_scout.py`, `backend/tests/fixtures/news/*`, `backend/tests/test_news_scout.py`

### T25 · News eval dataset (#36) — D3 · S · Must · G2
- [ ] ≥ 30 hand-labelled news items in `evals/news.jsonl`; promptfoo config skeleton

**Verify:** promptfoo runs against the dataset · **Deps:** T24 · **Files:** `evals/news.jsonl`, `evals/promptfooconfig.yaml`

### P06 · Remaining hi-fi screens (#37) — PD · M · Must
- [ ] Portfolio, admin/Time Machine, Copilot, Agent Trace drawer, ledger tab, alerts, judge landing and tour hint style

**Verify:** Friday review · **Deps:** P03, P04 · **Files:** design file

### ✅ Checkpoint W2 (Fri Oct 9)
- [ ] Real satellite metrics, $ ranges and a grade for all 3 sites visible in the UI
- [ ] Buy and sell work; the community wallet receives IPO proceeds
- [ ] News Scout returns classified events for the hero site
- [ ] Skeleton deployed and reachable

---

## Week 3 · Live agents, ledger and trace (Mon Oct 12 – Fri Oct 16)

### T26 · Auditor (Nemotron 3 Ultra) (#38) — D3 · M · Must · B5
- [ ] Input bundle (metrics, valuation, base scores, events, evidence, previous report) → schema-validated output; adjustment limited to ±10 with a reason; every claim cites a metric or event ID
- [ ] Thinking handled per T02 (off for JSON, or reason-then-format); fallback tier on failure
- [ ] Contract tests: numbers unchanged, citations resolve

**Verify:** `make test` · **Deps:** T09, T15, T24 · **Files:** `backend/app/agents/auditor.py`, `backend/app/agents/prompts/auditor.md`, `backend/tests/test_auditor.py`

### T27 · Orchestrator and async rating runs (#39) — D3 · M · Must · A3
- [ ] Nemotron 3 Super tool-calling over earth_obs, valuation, news_scout, field_evidence and auditor; fixed-pipeline fallback
- [ ] `POST` returns `202` + `run_id`; progress events per step; report stored and sealed

**Verify:** `make test`; a live run on the hero site completes · **Deps:** T26, T19 · **Files:** `backend/app/agents/orchestrator.py`, `backend/app/services/rating.py`

### T28 · Agent Trace API (#40) — D3 · S · Must · G1
- [ ] Per-run trace: steps, model, tokens, latency, tool calls, outputs (from `llm_calls` + spans); optional Langfuse export

**Verify:** `make test`; trace for a live run · **Deps:** T09, T27 · **Files:** `backend/app/routers/admin.py`, `backend/app/tracing.py`

### T29 · Live events (SSE) (#41) — D1 · M · Must
- [ ] `GET /events/stream` sends rating progress, price ticks and alerts for the visitor's world; polling fallback `GET /events?since=`

**Verify:** `make test`; events arrive in the browser · **Deps:** T08, T31 · **Files:** `backend/app/routers/events.py`, `backend/app/events.py`

### T30 · Nature Ledger (#42) — D1 · M · Must · F1 F2
- [ ] Append-only, hash-chained entries written in the same transaction as listings, reports, events, price anchors and payouts (dev-spec §17)
- [ ] `GET /ledger/{asset_id}` and `/verify`; tamper demo in `DEMO_MODE`

**Verify:** `make test` (valid chain, tamper detected) · **Deps:** T07 · **Files:** `backend/app/ledger.py`, `backend/app/routers/ledger.py`, `backend/tests/test_ledger.py`

### T31 · Per-visitor sandbox (#43) — D1 · S · Must · J
- [ ] First visit creates a world (cookie) with personas, holdings and demo assets; "Reset my demo" restores it; worlds never affect each other

**Verify:** `make test` (two worlds isolated) · **Deps:** T07, T16 · **Files:** `backend/app/sandbox.py`, `backend/app/routers/admin.py`

### T32 · Frontend data layer (#44) — D1 · S · Must
- [ ] Shared hooks for the API client, SSE subscription with polling fallback, sandbox cookie and error/loading states, so PD's screens stay presentational
- [ ] On load, call `GET /world` once and wait for it before any other request; on a 401 `world_required`, call `GET /world` again and retry. Server-side fetches forward the visitor's `nx_world` cookie

**Verify:** `make fe-check` · **Deps:** T29, T31 · **Files:** `frontend/src/lib/*.ts`

### T33 · Listing flow and rating progress (#45) — PD · M · Must · A1–A3
- [ ] Map drawing, area display and validation messages, community form, submit; live progress through the agent steps

**Verify:** `make fe-check`; list a new polygon end to end · **Deps:** T32, T36, P05 · **Files:** `frontend/src/app/list/page.tsx`, `frontend/src/components/MapDraw.tsx`, `RatingProgress.tsx`

### T34 · Agent Trace drawer and ledger tab (#46) — PD · M · Must · G1 F2
- [ ] Drawer lists each step (model, tokens, latency, output); ledger tab shows entries and the verify/tamper badge

**Verify:** `make fe-check`; matches P06 · **Deps:** T28, T30, T32 · **Files:** `frontend/src/components/AgentTrace.tsx`, `LedgerTab.tsx`

### T35 · Map overlays and thumbnails (#47) — D2 · S · Must
- [ ] Land-cover overlay and marketplace thumbnail images per demo site (precomputed)

**Verify:** images render in the UI · **Deps:** T13 · **Files:** `scripts/precompute_sites.py`, `backend/data/demo_sites/*.png`

### T36 · Polygon validation (#48) — D2 · S · Must · A1
- [ ] Rejects self-intersection, < 10 ha or > 50,000 ha, and overlap with existing listings; area in an equal-area projection

**Verify:** `make test` · **Deps:** T07 · **Files:** `backend/app/tools/geometry.py`, `backend/tests/test_geometry.py`

### T37 · Report versions and diffs (#49) — D2 · S · Could (only if ahead; re-plan Oct 4) · B6
- [ ] Each re-rating stores a new version; the diff endpoint lists changed metrics and the reasons

**Verify:** `make test` · **Deps:** T27 · **Files:** `backend/app/routers/reports.py`, `backend/app/services/diff.py`

### T40 · Field evidence (photos) (#50) — D2 · S · Could (only if ahead; re-plan Oct 4) · A4
- [ ] Up to 5 geotagged photos → EXIF GPS/date check → MiniCPM-V description → evidence event → Auditor weighs it → confidence updated (ADR-0003)
- [ ] Exposed as the `field_evidence` tool so the Orchestrator (T27) calls it when evidence exists

**Verify:** `make test`; manual upload raises confidence · **Deps:** T09, T15 · **Files:** `backend/app/agents/field_evidence.py`, `backend/app/routers/assets.py`


### T41 · Revenue split and impact (#51) — D2 · S · Should · D4 E3
- [x] Pure functions for simulated quarterly revenue (2% of annual value / 4) split 50/50 community / dividends; portfolio impact metrics (ha, t CO₂, $ services) pro-rata; `pay_quarter` applies one quarter's payout transactionally for T38/T44
- Handoff: Time Machine triggering remains in T38, whose task calls the T41 payout helper each quarter.

**Verify:** `make test` · **Deps:** T16 · **Files:** `backend/app/market/revenue.py`, `backend/app/routers/market.py`


### ✅ Checkpoint W3 (Fri Oct 16)
- [ ] A full rating run is **100% live AI** (Super → tools → Nano → Ultra), started from the UI
- [ ] Trace drawer shows every step; ledger verifies and the tamper demo fails as expected
- [ ] Listing a new polygon works; two browsers have separate sandboxes

---

## Week 4 · Monitoring loop, Copilot, evals, deploy (Mon Oct 19 – Fri Oct 23)

### T38 · Time Machine, re-rating and alerts (#52) — D1 · M · Must · D1–D4
- [ ] "Next quarter" re-rates each asset with the next scenario version; event presets (fire, encroachment, drought, restoration, protection); prices re-anchor
- [ ] Alerts on health Δ ≥ 5, a grade change or news severity ≥ 4; each quarter pays out revenue via T41; same entrypoints usable as jobs (`jobs/rerate_all.py`, `jobs/news_sweep.py`; daily sweep via GitHub Actions)

**Verify:** `make test`; manual encroachment gives grade A → BBB and an alert · **Deps:** T27, T16, T29, T41 · **Files:** `backend/app/routers/admin.py`, `jobs/*.py`, `.github/workflows/news-sweep.yml`

### T39 · Copilot (RAG) (#53) — D3 · M · Must · E1
- [ ] Reports and events chunked and embedded (per T06) into pgvector; Nemotron Nano answers only from context with `[R…]`/`[E…]` citations; streamed

**Verify:** `make test`; "Why did the price drop?" cites the encroachment event · **Deps:** T27 · **Files:** `backend/app/rag/*.py`, `backend/app/routers/copilot.py`

### T42 · Demo deploy (#54) — D1 · S · Must
- [ ] Full app deployed on the T20 host with live keys and `LLM_BUDGET_USD` set; keep-alive ping workflow if the host sleeps (free tiers)

**Verify:** the demo script runs on the public URL · **Deps:** T20, T38 · **Files:** deploy config, `.github/workflows/keepalive.yml`

### T43 · Time Machine and alerts UI (#55) — D1 (with PD designs) · M · Must · D2 D3 C3
- [ ] Admin panel (next quarter, event presets, reset), phone-style alerts, price chart with event markers

**Verify:** `make fe-check`; encroachment flow in the browser · **Deps:** T38, T32 · **Files:** `frontend/src/app/admin/page.tsx`, `PriceChart.tsx`, `AlertsFeed.tsx`

### T44 · Copilot and impact UI (#56) — PD · M · Must · E1 E3
- [ ] Chat on asset and portfolio pages (streaming, citations link to sources); impact summary on the portfolio

**Verify:** `make fe-check` · **Deps:** T39, T41 · **Files:** `frontend/src/components/CopilotChat.tsx`, `ImpactSummary.tsx`

### T45 · Judge tour (#57) — PD (lead) + D2 · M · Must · J
- [ ] Driver.js tour: judge landing, persona switcher, 10 chapters (demo-plan §3.3), "Do it for me", Live badges, two-layer hints

**Verify:** `make fe-check`; a newcomer completes the tour unaided · **Deps:** T33, T34, T43, T44 · **Files:** `frontend/src/tour/*`, `frontend/src/app/page.tsx`

### T46 · E2E demo test (#58) — D2 · S · Must
- [ ] Playwright runs the tour's autoplay path end to end; runs in CI; reused to record the video

**Verify:** `make e2e` green locally and in CI · **Deps:** T45 · **Files:** `frontend/e2e/demo.spec.ts`, `.github/workflows/e2e.yml`

### T47 · Eval harness (#59) — D3 · M · Must · G2 G3
- [ ] `make eval`: news classification, Auditor faithfulness and direction, schema reliability, Copilot grounding, and the Nano/Super/Ultra routing comparison (dev-spec §18)
- [ ] Results written to `evals/results.md`; GitHub Action on manual/nightly trigger

**Verify:** `make eval` meets the §18 targets · **Deps:** T25, T26, T39 · **Files:** `evals/*`, `.github/workflows/eval.yml`

### T48 · UI polish and accessibility pass (#60) — PD · M · Must
- [ ] `/impeccable audit` + `critique` fixes; `web-design-guidelines` review; keyboard and contrast checks; empty, loading and error states

**Verify:** audit score recorded; no blocking issues · **Deps:** T33, T34


### ✅ Checkpoint W4 (Fri Oct 23) = FEATURE FREEZE
- [ ] The public URL runs the whole 3-minute demo script, including the judge tour
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
