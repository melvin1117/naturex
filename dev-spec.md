# NatureX — Technical Design (Dev Spec)

> Companion to [pm-spec.md](./pm-spec.md), [one-pager.md](./one-pager.md) and [diagrams.html](./diagrams.html) (its *Rating Engine* tab mirrors §7). Anything marked **(verify)** should be checked against current Nebius / NVIDIA docs before implementation.

---

## 1. System overview
```
Next.js web app ──HTTP/SSE──► FastAPI backend (Nebius Serverless Endpoint)
                                 ├── Rating Orchestrator (Nemotron 3 Super, tool-calling)
                                 │     ├── earth_obs tool ──► Earth Engine / Planetary Computer
                                 │     ├── valuation tool (pure Python + ESVD CSV)
                                 │     ├── news_scout agent ──► Tavily + Nemotron Nano
                                 │     ├── field_evidence agent ──► Nemotron Nano Omni
                                 │     └── auditor agent ──► Nemotron 3 Ultra
                                 ├── Market Engine (pure Python)
                                 ├── Copilot (Nemotron Nano + pgvector RAG)
                                 ├── Nature Ledger (hash-chained, append-only)
                                 └── Postgres + pgvector, Object Storage
Nebius Serverless Jobs: rerate_all (quarterly / on demand), news_sweep (daily)
```
Design principles:
1. **Deterministic core, LLM on top.** Numbers (areas, values, scores, prices) come from tested Python. LLMs orchestrate, classify, reason, explain, and may adjust the score only within a bounded range with justification.
2. **Cache everything.** Satellite results and LLM outputs are cached per `(asset_id, data_version)` so the demo is fast and cheap.
3. **Mock first.** Each module ships with a mock implementation behind the same interface (`USE_MOCKS=true`).

## 2. Tech stack
| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui | |
| Maps | react-leaflet + leaflet-draw (or MapLibre + terra-draw) | Esri/OSM basemap; land-cover tile overlay |
| Charts | Recharts | Price chart with event markers |
| Backend | Python 3.12, FastAPI, SQLModel, Pydantic v2 | |
| DB | Postgres 16 + pgvector (Supabase or Nebius Managed PostgreSQL) | |
| Object storage | Nebius Object Storage (S3-compatible) or Supabase storage | Tiles, thumbnails, evidence, report PDFs |
| LLM | **Nebius Token Factory** (OpenAI-compatible) | `openai` Python SDK with custom `base_url` |
| Search | **Tavily** (`tavily-python`) | News Scout |
| Earth observation | Google Earth Engine (`earthengine-api`) **or** Microsoft Planetary Computer (`pystac-client`, `stackstac`) | Pick whichever the team can access |
| Agent loop | Plain OpenAI tool-calling loop | Optional: NVIDIA NeMo Agent Toolkit for tracing/eval **(verify)** |
| Deploy | Backend → **Nebius Serverless Endpoint**; jobs → **Nebius Serverless Jobs**; frontend → Vercel or Nebius container | **(verify)** CLI / console steps |
| Tests | pytest, Playwright | |

> Cost: every component is free or has a free alternative, except the mandatory Nemotron calls on Token Factory, which run on hackathon credits. See §21.

## 3. Model routing (Nebius Token Factory)
| Role | Model | Why | Env var |
|---|---|---|---|
| Orchestrator | Nemotron 3 Super (e.g. `nvidia/nemotron-3-super-120b-a12b`) | Reliable tool-calling, good cost/quality | `MODEL_ORCHESTRATOR` |
| Auditor / Rating Analyst | Nemotron 3 Ultra | Deep cross-evidence reasoning, long context | `MODEL_AUDITOR` |
| News classification | Nemotron 3 Nano | High volume, cheap, fast | `MODEL_FAST` |
| Field evidence (photos in PoC; audio later) | Nemotron 3 Nano Omni | Multimodal | `MODEL_MULTIMODAL` |
| Copilot | Nemotron 3 Nano | Low latency chat | `MODEL_FAST` |
| Embeddings | NVIDIA embedding model on Token Factory **(verify)**; fallback local `bge-small` | RAG over reports | `MODEL_EMBED` |

Exact model IDs: copy from the Token Factory model catalog **(verify)**.

**Routing rules (and how we prove them):**
- Use reasoning / "thinking" mode only where it pays off (Auditor). Keep it off for classification and chat, if the model exposes a toggle **(verify)**.
- The eval harness (§18) runs each task on Nano, Super and Ultra and records accuracy, p50 latency and cost per call. That produces the README routing table, turning the choice of model into evidence rather than opinion.
- On timeout or invalid JSON, retry once on the same model, then fall back one tier (Ultra → Super → Nano) and flag the report `degraded_model=true`.

```python
# backend/app/llm.py
from openai import OpenAI
client = OpenAI(base_url=settings.TOKEN_FACTORY_BASE_URL, api_key=settings.NEBIUS_API_KEY)
# TOKEN_FACTORY_BASE_URL e.g. https://api.tokenfactory.nebius.com/v1/  (verify region URL)
```
Every call goes through a wrapper that logs `model, prompt_tokens, completion_tokens, latency_ms, agent, asset_id` to `llm_calls`. Surface this in an **"Agent trace" drawer** in the UI: it shows judges exactly how Nemotron is used.

## 4. Repository layout
```
naturex/
├── LICENSE                     # MIT (must show in GitHub About)
├── README.md                   # setup, run, Nemotron/Token Factory usage, architecture image
├── docker-compose.yml          # postgres+pgvector, backend, frontend (local dev)
├── frontend/
│   ├── app/
│   │   ├── page.tsx                  # Marketplace
│   │   ├── list/page.tsx             # Listing portal
│   │   ├── asset/[id]/page.tsx       # Asset page (report, chart, trade, alerts)
│   │   ├── portfolio/page.tsx
│   │   └── admin/page.tsx            # Time Machine
│   ├── components/ (MapDraw, PriceChart, ReportView, TradePanel, CopilotChat, AgentTrace, SandboxBanner)
│   └── lib/api.ts
├── backend/
│   ├── app/
│   │   ├── main.py                   # FastAPI app, routers
│   │   ├── config.py, db.py, models.py, schemas.py, llm.py, ledger.py
│   │   ├── routers/ (assets.py, reports.py, market.py, copilot.py, admin.py, events.py)
│   │   ├── agents/
│   │   │   ├── orchestrator.py       # tool-calling loop
│   │   │   ├── news_scout.py
│   │   │   ├── field_evidence.py
│   │   │   ├── auditor.py
│   │   │   └── prompts/*.md
│   │   ├── tools/
│   │   │   ├── earth_obs.py          # GEE / PC implementation + mock
│   │   │   ├── valuation.py
│   │   │   └── scoring.py
│   │   ├── market/engine.py
│   │   └── rag/ (embed.py, retrieve.py)
│   ├── data/esvd_coefficients.csv
│   ├── data/demo_sites/*.geojson + cached metrics JSON
│   └── tests/
├── jobs/
│   ├── rerate_all.py                 # Nebius Serverless Job entrypoint
│   └── news_sweep.py
├── evals/ (news.jsonl, scenarios/, run.py, results.md)
├── scripts/precompute_sites.py
└── .github/workflows/ (ci.yml, eval.yml)
```

## 5. Data model (Postgres)
```sql
create extension if not exists vector;

create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('community','investor','admin')),
  cash_balance numeric(14,2) not null default 10000
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  community_user_id uuid references users(id),
  country text, description text, cover_image_url text,
  geojson jsonb not null,
  area_ha numeric(12,2) not null,
  centroid_lat double precision, centroid_lon double precision,
  total_shares bigint not null default 1000000,
  retained_pct numeric(5,2) not null default 51.0,
  primary_shares_remaining bigint not null,
  community_wallet numeric(14,2) not null default 0,
  status text not null default 'draft'
    check (status in ('draft','rating','needs_evidence','ineligible','listed','suspended')),
  created_at timestamptz default now()
);

create table metrics (                -- raw earth-obs output per rating run
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references assets(id),
  data_version text not null,          -- e.g. '2026Q3' or 'sim-3'
  landcover jsonb not null,            -- {"water":0.12,"trees":0.3,...}
  ndvi_series jsonb, ndvi_trend numeric, water_change numeric,
  forest_loss_ha numeric, biomass_t_ha numeric, cloud_free_obs int,
  created_at timestamptz default now()
);

create table events (                 -- news + injected events
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references assets(id),
  source text check (source in ('tavily','admin','evidence')),
  title text, url text, published_at date,
  impact_type text,                    -- encroachment|fire|drought|pollution|restoration|protection|other
  direction smallint check (direction in (-1,0,1)),
  severity smallint check (severity between 1 and 5),
  summary text,
  created_at timestamptz default now()
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references assets(id),
  version int not null,
  metrics_id uuid references metrics(id),
  health_score numeric(5,2), grade text, confidence numeric(5,2),
  value_low numeric(16,2), value_mid numeric(16,2), value_high numeric(16,2),
  value_breakdown jsonb,               -- {"carbon":..,"water":..,"flood":..,"habitat":..,"recreation":..}
  fair_value_per_share numeric(12,4),
  flags jsonb,                         -- greenwashing / data-quality flags
  summary_md text, recommendations jsonb,
  auditor_json jsonb,                  -- full structured output
  created_at timestamptz default now(),
  unique (asset_id, version)
);

create table prices (
  asset_id uuid references assets(id), ts timestamptz default now(),
  price numeric(12,4) not null, reason text,   -- 'ipo'|'order'|'rerate'|'tick'
  primary key (asset_id, ts)
);

create table holdings (
  user_id uuid references users(id), asset_id uuid references assets(id),
  shares bigint not null default 0, avg_cost numeric(12,4),
  primary key (user_id, asset_id)
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id), asset_id uuid references assets(id),
  side text check (side in ('buy','sell')), qty bigint, fill_price numeric(12,4),
  is_primary boolean default false, created_at timestamptz default now()
);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references assets(id), kind text, message text,
  severity smallint, created_at timestamptz default now()
);

create table doc_chunks (             -- RAG
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references assets(id), report_id uuid references reports(id),
  content text, embedding vector(1024)  -- match embed model dim (verify)
);

create table ledger_entries (         -- Nature Ledger: append-only, hash-chained per asset
  id bigserial primary key,
  asset_id uuid references assets(id),
  seq int not null,                    -- 0,1,2… per asset
  kind text not null check (kind in ('listing','report','event','price_anchor','payout')),
  ref_id uuid,                         -- id of report/event/etc.
  payload jsonb not null,              -- canonical snapshot of what was recorded
  prev_hash char(64) not null,         -- '0'*64 for seq 0
  hash char(64) not null,              -- sha256(canonical_json(payload)+kind+seq+prev_hash)
  created_at timestamptz default now(),
  unique (asset_id, seq)
);
-- enforce append-only at DB level
revoke update, delete on ledger_entries from app_user;

create table llm_calls (
  id bigserial primary key, agent text, model text, asset_id uuid,
  prompt_tokens int, completion_tokens int, latency_ms int, created_at timestamptz default now()
);
```

## 6. API (FastAPI)
| Method & path | Purpose |
|---|---|
| `POST /assets` | Create asset from GeoJSON + details → validates → status `rating` → enqueue rating |
| `GET /assets` | Marketplace list (latest price, grade, trend) |
| `GET /assets/{id}` | Asset detail + latest report + recent events |
| `POST /assets/{id}/evidence` | Upload photos (audio post-hackathon) → field_evidence agent → event + re-rate |
| `GET /assets/{id}/reports` · `GET /reports/{id}` · `GET /reports/{id}/diff/{prev}` | Report history & diffs |
| `GET /assets/{id}/prices?range=` | Price history |
| `POST /orders` | `{asset_id, side, qty}` → Market Engine → fill |
| `GET /portfolio` | Holdings, P&L, impact |
| `POST /copilot` | `{question, asset_id?}` → grounded answer + citations (streamed) |
| `GET /events/stream` | SSE: price ticks, alerts, rating progress (polling fallback `GET /events?since=`) |
| `POST /admin/simulate/quarter` | Trigger re-rate of all assets with next `data_version` |
| `POST /admin/simulate/event` | Inject preset event (fire, encroachment, drought, restoration, protection) |
| `GET /admin/trace?asset_id=` | LLM call trace for Agent Trace drawer |
| `GET /ledger/{asset_id}` | Ledger entries (hashes, kinds, timestamps) |
| `GET /ledger/{asset_id}/verify` | Recomputes the chain → `{valid, entries, broken_at?}` |
| `POST /admin/tamper-demo` | *(DEMO_MODE only)* mutates a copy of one entry to show verification failing |

Rating runs asynchronously: the API returns `202` + `run_id`, and progress arrives over SSE (`step: earth_obs → valuation → news → evidence → audit → done`).

> Serverless endpoints may not keep long-lived connections **(verify)**; the frontend should fall back to polling every 3 s.

## 7. Rating pipeline

### 7.1 Orchestrator (Nemotron 3 Super)
Tool-calling loop (max 8 steps) with tools:
```jsonc
earth_obs(asset_id, data_version)            -> Metrics
valuation(asset_id, metrics_id)              -> {low, mid, high, breakdown}
news_scout(asset_id, lookback_days=365)      -> [Event]
field_evidence(asset_id)                     -> [Event]   // only if evidence exists
auditor(asset_id, metrics_id, valuation, events) -> AuditorOutput
```
System prompt essentials: *"You coordinate a nature rating. Always call earth_obs then valuation. Call news_scout. Call field_evidence if evidence exists. Finally call auditor exactly once. Never invent numbers."* If a tool fails, retry once, then continue with `data_quality` flags. (Fallback: a fixed Python pipeline with the same steps if tool-calling misbehaves; keep the orchestrator for plan/explanations.)

### 7.2 Earth observation tool
For polygon *P* and period *T* (default: last 12 months; trend: 5 years):
| Metric | Dataset | Computation |
|---|---|---|
| Land cover fractions | Dynamic World V1 (10 m) | Mode of `label` over T; pixel-count share per class |
| NDVI series & trend | Sentinel-2 SR Harmonized, cloud-masked | Monthly median NDVI in P; OLS slope per year over 5 yrs |
| Water change | JRC Global Surface Water | Occurrence change intensity mean in P |
| Forest loss | Hansen Global Forest Change | Loss area (ha) in last 5 yrs |
| Biomass | ESA CCI Biomass or GEDI L4B | Mean AGB t/ha |
| Data coverage | Sentinel-2 | Count of cloud-free observations |

Demo sites: run offline once and store to `data/demo_sites/*.json`; `data_version='sim-N'` variants are generated by applying scripted deltas (e.g. +8% trees, −5% flooded vegetation) for the Time Machine.

### 7.3 Valuation engine (deterministic)
```
value_c   = area_ha × share_c × coeff_c × context_multiplier_c
value_mid = Σ value_c
value_low = Σ area_ha × share_c × coeff_low_c
value_high= Σ area_ha × share_c × coeff_high_c
```
Class → biome mapping and **starter coefficients** (USD/ha/yr). These are illustrative, from Costanza et al. 2014 global unit values (2007 USD). **Replace with ESVD per-service values and verify before use.**
| Dynamic World class | Biome used | Starter mid $/ha/yr | low / high |
|---|---|---|---|
| flooded_vegetation (coastal) | Tidal marsh / mangrove | 193,843 | ×0.3 / ×1.5 |
| flooded_vegetation (inland) | Swamps / floodplains | 25,681 | ×0.4 / ×1.5 |
| water | Lakes / rivers | 12,512 | ×0.4 / ×1.5 |
| trees (\|lat\| < 23.5°) | Tropical forest | 5,382 | ×0.5 / ×1.5 |
| trees (other) | Temperate / boreal forest | 3,137 | ×0.5 / ×1.5 |
| grass | Grassland | 4,166 | ×0.5 / ×1.5 |
| shrub_and_scrub | Shrubland (use grassland × 0.5) | 2,083 | ×0.5 / ×1.5 |
| crops, built, bare, snow_and_ice | Not valued as natural capital | 0 | 0 |

"Coastal" = centroid within 5 km of coastline (Natural Earth 1:10m coastline, public domain, bundled in `data/`). Service breakdown split per biome from a small CSV (e.g. wetland: water 35%, flood 30%, habitat 20%, carbon 10%, recreation 5%).

**Carbon (shown separately):** `stock_tCO2 = AGB_t_ha × area_ha × 0.47 × 3.67`; annual sequestration from IPCC Tier-1 default rates per class.

### 7.4 Scoring (deterministic base + bounded LLM adjustment)
```
V = clamp(0.5 + ndvi_trend / 0.02, 0, 1) × 0.5 + clamp(ndvi_mean / 0.8, 0, 1) × 0.5   # vegetation vigor
N = natural_fraction  (trees + water + flooded_vegetation + grass + shrub_and_scrub)
L = 1 − clamp(forest_loss_ha / (0.1 × area_ha), 0, 1)                                 # habitat loss
W = clamp(0.5 + water_change / 100, 0, 1)   (wetlands; else 1)                          # water stability
T = 1 − clamp(Σ(severity × [direction = −1]) / 15, 0, 1)                               # threat pressure

base_health = 100 × (0.30V + 0.25N + 0.20L + 0.15W + 0.10T)
health      = clamp(base_health + auditor_adjustment, 0, 100)    # auditor_adjustment ∈ [−10, +10], must be justified
```
Grade: AAA ≥ 90 · AA ≥ 80 · A ≥ 70 · BBB ≥ 60 · BB ≥ 50 · B ≥ 40 · C ≥ 30 · D < 30.

Confidence: `100 × (0.4·coverage + 0.3·agreement + 0.2·evidence + 0.1·recency)`
- coverage = min(cloud_free_obs / 24, 1)
- agreement = auditor-judged consistency between satellite and news (0–1)
- evidence = 1 if validated field evidence, else 0.3
- recency = 1 if data < 90 days old, else 0.5

Listing gate: `confidence ≥ 70 AND grade ≥ C AND forest_loss_last_12m < 1% of area`.

### 7.5 News Scout (Tavily + Nemotron Nano)
1. Build 2–3 queries from asset name, nearest town (reverse geocode via OpenStreetMap Nominatim, max 1 request/s with a custom User-Agent, cached per asset), and keywords: `"<place> wetland factory permit"`, `"<place> fire OR drought OR pollution"`, `"<place> restoration OR protected area"`.
2. `tavily.search(query, topic="news", days=lookback, max_results=5)`.
3. Deduplicate by URL; for each result, Nemotron Nano returns:
```json
{"relevant": true, "impact_type": "encroachment", "direction": -1, "severity": 4,
 "summary": "State approved a 40-ha industrial park expansion bordering the wetland.",
 "published_at": "2026-09-12"}
```
4. **Prompt-injection guard:** wrap retrieved text in `<untrusted_content>` tags and instruct the model to treat it as data only; validate the output against a JSON schema.

### 7.6 Field Evidence (Nemotron Nano Omni)
Input: photo(s) + asset context (audio is post-hackathon). Output: `{observations[], species_candidates[], damage_signs[], water_clarity, authenticity_concerns[]}`. The result creates an `events` row (`source='evidence'`) and sets `evidence=1` in confidence if there are no authenticity concerns.

### 7.7 Auditor (Nemotron 3 Ultra)
Input: metrics, valuation, base scores, events, evidence, and the previous report (if any). Output (JSON schema enforced; retry on invalid):
```json
{
  "auditor_adjustment": -2,
  "adjustment_reason": "Two credible reports of illegal dumping in the NE sector not yet visible in satellite data.",
  "agreement": 0.8,
  "flags": [{"type": "data_gap", "detail": "No cloud-free scenes in Jul–Aug (rainy season)"}],
  "greenwashing_risk": "low",
  "key_changes": ["Flooded vegetation −3.1 pp vs last quarter", "New encroachment news (severity 4)"],
  "recommendations": ["Install boundary markers along the NE industrial edge", "..."],
  "summary_md": "## Ecological Performance Report — Q3 2026\n..."
}
```
Rules in the prompt: cite a metric or event ID for every claim; never change numbers other than `auditor_adjustment`; write the report for non-experts; ≤ 400 words.

## 8. Market engine
**IPO:** `ipo_price = fair_value_per_share` where
```
FV_total           = value_mid × 10 × (0.5 + 0.5 × health/100) × (0.7 + 0.3 × confidence/100)
fair_value_per_share = FV_total / total_shares
primary_float      = total_shares × (1 − retained_pct/100)
```
**Orders (instant fill):**
```
slippage   = k × qty / liquidity          (k = 0.5, liquidity = 5% of total_shares)
fill_price = price × (1 + slippage)  for buy;  price × (1 − slippage)  for sell
```
- Buys consume `primary_shares_remaining` first → proceeds credited to `community_wallet` (`is_primary=true`); afterwards the platform market maker takes the other side.
- After each fill: `price ← price + β × price × (signed_qty / liquidity)`, with β = 0.5.

**Re-rating / ticks:** `price ← price + α × (FV_new − price)`, with α = 0.35 on re-rate and 0.05 per tick, plus small noise σ = 0.3%.

A tick is triggered by `POST /admin/simulate/quarter`, by a Serverless Job, or by the SSE loop while the demo is running (no always-on process is required).

**Quarterly revenue split (simulated):**
- `revenue_q = value_mid × capture_rate / 4`, with capture_rate = 2%.
- 50% goes to `community_wallet`.
- 50% is paid as dividends pro-rata to holders (including the community's retained stake).

Invariants (unit-tested): cash is never negative; shares are conserved; the price stays > 0; every price change has a `reason`.

## 9. Background jobs (Nebius Serverless Jobs)
| Job | Schedule | Entrypoint | Work |
|---|---|---|---|
| `rerate_all` | Quarterly (demo: on demand) | `python -m jobs.rerate_all --version sim-N` | For each listed asset: earth_obs → valuation → auditor (using news events already stored by `news_sweep`) → report v+1 → price re-anchor → alerts |
| `news_sweep` | Daily | `python -m jobs.news_sweep` | News Scout for all assets; severity ≥ 4 → alert + optional re-rate |

Both reuse the backend image (`backend/Dockerfile`) with a different command. Trigger from `/admin/simulate/*` via the Nebius API/CLI, or run in-process when `LOCAL_JOBS=true` **(verify)**.

## 10. Copilot (RAG)
- **Indexing:** on each new report, chunk the `summary_md`, key metrics and events (~500 tokens each), embed them and upsert into `doc_chunks`.
- **Query:** retrieve the top 6 chunks (filtered by asset if given), then send them to Nemotron Nano with an instruction to answer only from the context and cite `[R{version}]` / `[E{id}]`.
- The Copilot may also call `get_price_history` and `compare_assets` as tools.

## 11. Frontend pages & key components
| Page | Components | Notes |
|---|---|---|
| Marketplace `/` | AssetCard grid, filters, SandboxBanner | Sort by grade / change / value |
| List `/list` | MapDraw, AssetForm, RatingProgress (SSE) | Area and validation shown live |
| Asset `/asset/[id]` | Map + land-cover overlay, ReportView (grade badge, value range, breakdown chart, NDVI chart, flags, recommendations), PriceChart with event markers, TradePanel, AlertsFeed, CopilotChat, AgentTrace drawer | The hero page |
| Portfolio `/portfolio` | Holdings table, P&L, ImpactSummary | |
| Admin `/admin` | Time Machine: "Next quarter", event presets, reset demo | Hidden link for the demo |

## 12. Configuration
```
NEBIUS_API_KEY=            TOKEN_FACTORY_BASE_URL=
MODEL_ORCHESTRATOR=        MODEL_AUDITOR=        MODEL_FAST=
MODEL_MULTIMODAL=          MODEL_EMBED=
TAVILY_API_KEY=
EE_SERVICE_ACCOUNT_JSON=   # or PC_SUBSCRIPTION_KEY
DATABASE_URL=              S3_ENDPOINT=  S3_BUCKET=  S3_KEY=  S3_SECRET=
USE_MOCKS=false            LOCAL_JOBS=true            DEMO_MODE=true
LLM_BUDGET_USD=20          # hard cap per deployment key (§21)
```
Secrets stay server-side only; never commit `.env` (commit `.env.example`).

## 13. Testing & quality
| Level | What |
|---|---|
| Unit (pytest) | valuation math, scoring bounds, grade thresholds, market invariants, slippage, revenue split |
| Contract | JSON-schema validation of News Scout / Auditor outputs using recorded fixtures |
| Integration | Full rating on the 3 demo sites with cached earth-obs data; snapshot the report fields |
| E2E (Playwright) | Demo script: list → rate → buy → next quarter → inject event → alert → Copilot answer |
| LLM eval | See §18 (≥ 30 hand-labelled news items, Auditor faithfulness, schema reliability) |

## 14. Performance & cost
| Target | Value |
|---|---|
| Rating (cached earth-obs) | < 60 s end-to-end (PM hard limit: < 2 min) |
| Copilot first token | < 2 s |
| Page loads | < 1.5 s |

- Use Ultra only in the Auditor (~1 call per rating); everything high-volume uses Nano.
- Cache Tavily results for 24 h and LLM outputs by input hash.
- Track token spend in `llm_calls` and show it in the admin view.

## 15. Security & responsible AI
- Sandbox banner on every page; no real payments; no tokens or crypto.
- Rate-limit `/copilot` and `/assets`; validate GeoJSON size.
- Treat all retrieved web content and uploaded media as untrusted; enforce schema-validated outputs.
- Show uncertainty (ranges, confidence) everywhere a number appears.
- Use only licensed data (Earth Engine / Planetary Computer terms, Tavily terms, ESVD citation).

## 16. Team split (4 people)
| Owner | Scope |
|---|---|
| Dev 1 — Frontend | Marketplace, asset page, portfolio, trade panel, charts, SSE |
| Dev 2 — Geo & data | Earth-obs pipeline, demo-site caching, valuation, scoring, map overlays |
| Dev 3 — AI agents | Token Factory client, orchestrator, News Scout (Tavily), Auditor, field evidence, Copilot RAG, agent trace |
| Dev 4 — Backend & platform | Schema, API, market engine, jobs, Nebius deployment, tests, Time Machine |

## 17. Nature Ledger (tamper-evident history)
```python
# backend/app/ledger.py
def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()

def entry_hash(payload, kind, seq, prev_hash) -> str:
    return hashlib.sha256(canonical(payload) + kind.encode() + str(seq).encode() + prev_hash.encode()).hexdigest()

def append(session, asset_id, kind, ref_id, payload):
    last = session.exec(select(Ledger).where(Ledger.asset_id == asset_id).order_by(Ledger.seq.desc())).first()
    seq, prev = (last.seq + 1, last.hash) if last else (0, "0" * 64)
    session.add(Ledger(asset_id=asset_id, seq=seq, kind=kind, ref_id=ref_id, payload=payload,
                       prev_hash=prev, hash=entry_hash(payload, kind, seq, prev)))

def verify(entries) -> dict:
    prev = "0" * 64
    for e in entries:                                   # ordered by seq
        if e.prev_hash != prev or e.hash != entry_hash(e.payload, e.kind, e.seq, prev):
            return {"valid": False, "broken_at": e.seq}
        prev = e.hash
    return {"valid": True, "entries": len(entries), "head": prev}
```
- **What gets appended:** listing (polygon + details), each report (scores, values, fair value, report text hash), each event, each IPO / price re-anchor, and each payout.
- **Append happens in the same DB transaction** as the record it covers.
- **Payload rule:** the payload must contain the business values themselves, not just an ID, so that editing the source row is detectable by comparing it with the payload.
- **UI:** a "✅ History verified" badge, plus a ledger tab listing each entry's seq, kind, time and a short hash, with a "verify" button.
- **Stretch (F3):** a quarterly job timestamps each asset's head hash with OpenTimestamps (`opentimestamps-client`) and stores the `.ots` proof in object storage.

## 18. Evaluation harness (`make eval`)
| Eval | Dataset | Metric | Target |
|---|---|---|---|
| News classification | ≥ 30 hand-labelled Tavily results (relevant, impact_type, direction, severity) in `evals/news.jsonl` | Accuracy / macro-F1 per field | ≥ 85% relevance, ≥ 75% impact_type |
| Auditor faithfulness | 3 sites × 3 scenarios (baseline, restoration, encroachment) | (a) no numeric field changed except `auditor_adjustment`; (b) every citation resolves to a metric or event ID; (c) adjustment within ±10 | 100% / 100% / 100% |
| Auditor direction sanity | Same scenarios | Grade moves in the expected direction | 9/9 |
| Schema reliability | All agent calls in eval run | First-try valid JSON rate; after-retry rate | ≥ 95% / 100% |
| Copilot grounding | 15 Q&A pairs | Answer cites the correct report/event; no uncited numbers | ≥ 90% |
| Routing comparison | News + Auditor tasks on Nano / Super / Ultra | Quality, p50 latency, $/call | Table in README |

Implementation: plain pytest + a small runner that writes `evals/results.md` (committed) and a JSON artifact uploaded by CI.

## 19. Engineering quality bar
- **CI (GitHub Actions):** lint (ruff, eslint), type-check (mypy on `tools/`, `market/` and `ledger.py`; `tsc`), unit and contract tests on every PR. The eval job runs nightly and on demand, so it doesn't burn credits on every push.
- **One-command local run:** `cp .env.example .env && docker compose up`. Seed script loads the 3 demo sites plus cached metrics.
- **Reproducible data:** `scripts/precompute_sites.py` regenerates the cached satellite JSON from Earth Engine, with the dataset versions pinned in the output.
- **Mocks behind interfaces:** `USE_MOCKS=true` lets the frontend team work offline, and CI runs without API keys.
- **Structured logging:** a `run_id` is carried through orchestrator, tools, LLM calls, the ledger and SSE.
- **Resilience:** a timeout on every external call (LLM 60 s, Tavily 15 s, Earth Engine 120 s) plus retry with backoff, and graceful degradation flags shown in the report.
- **Health endpoints:** `/healthz` and `/readyz` for the Nebius Serverless Endpoint.

## 20. Definition of done (hackathon)
- [ ] Public URL runs the full demo script without manual DB edits
- [ ] At least 3 Nemotron models (Super, Ultra, Nano; plus Nano Omni if photo evidence ships) are called at runtime via Token Factory, visible in the Agent Trace drawer
- [ ] Tavily is called at runtime by the News Scout
- [ ] Backend deployed on a Nebius Serverless Endpoint; re-rating runs as a Nebius Serverless Job
- [ ] README covers setup, the architecture image, the model table, and "How we used Nemotron & Token Factory"
- [ ] Nature Ledger verifies for every demo asset; tamper demo shows ❌
- [ ] `make eval` results + routing table committed and linked from README
- [ ] CI green on `main`; `docker compose up` works from a clean clone
- [ ] MIT license visible; demo video < 3 min on YouTube

## 21. Cost plan: paid items and free alternatives
Policy: use the planned stack, and switch to the free alternative wherever a paid item isn't covered by hackathon credits. Commercial licensing is out of scope for the hackathon (local development and small demo hosting only).

**Mandatory (hackathon rule), running on credits.** The app must call Token Factory at runtime **or** run on Nebius AI Cloud, and use at least one NVIDIA open model:
| Item | Covered by | Notes |
|---|---|---|
| NVIDIA Nemotron (Ultra, Super, Nano, Nano Omni) via **Nebius Token Factory** | $25 hackathon promo (code `NEBIUS-DEVPOST-GLOBAL26`) + $25 Nebius Builders Program, per account | Credits are per account and can't be pooled. The deployed app uses one key; each member develops with their own. Confirm per-member vs per-team with the organisers. |

**Paid items with free alternatives:**
Azure options use the Visual Studio subscriber credit ($150/month, individual dev/test only). They're for development, testing and precomputation, **not** for hosting the judged demo (see the Azure rules below).

| Planned (paid) | Free alternative | Azure dev/test alternative (approx. cost/month) | Trade-off |
|---|---|---|---|
| Nebius Serverless Endpoint (backend API) | Local `docker compose`; demo on Hugging Face Spaces (Docker) or Render free tier | Azure Container Apps, Consumption plan, scale to zero (~$0 within the monthly free grant) | Cold starts on free tiers; loses a bonus Nebius-usage point (still meets the rule via Token Factory) |
| Nebius Serverless Jobs (`rerate_all`, `news_sweep`) | In-process run (`LOCAL_JOBS=true`) triggered by the Time Machine; GitHub Actions `schedule` for the daily sweep | Azure Container Apps Jobs, manual or cron trigger (~$0 within the free grant) | Same code entrypoints; only the trigger changes |
| Nebius Managed PostgreSQL | Supabase free tier (Postgres + pgvector) or local Postgres in Docker | Azure Database for PostgreSQL Flexible Server, Burstable B1ms, 32 GB, pgvector enabled (~$15–20; stop when idle) | Supabase free projects pause after inactivity; Azure server auto-restarts after 7 days stopped |
| Nebius Object Storage | Supabase Storage free tier or local disk / MinIO in Docker | Azure Blob Storage, Standard LRS, Hot tier, a few GB (< $1) | Small storage limits, fine for the demo |
| NVIDIA embedding model on Token Factory (uses credits) | Local `bge-small` (sentence-transformers) | — (keep AI on Token Factory) | Slightly lower retrieval quality |
| Tavily beyond the free tier | Free tier (~1,000 searches/month) + $25 Builders credit; cache results for 24 h | — | Keep queries to 2–3 per asset |
| Mapbox (if used) | Leaflet + OpenStreetMap / Esri basemap tiles | — (Azure Maps not needed) | Respect tile usage policies |
| Frontend on a Nebius container | Vercel Hobby (free) | Azure Static Web Apps, Free plan ($0) | Next.js SSR support on Static Web Apps is limited; Vercel is simpler |
| Nebius AI Cloud compute | Only if credits are unlocked at a Builders & Brews event | — | Optional upgrade path |
| Satellite precompute (`scripts/precompute_sites.py`) | Laptop, or free Earth Engine compute | Short-lived Linux VM (e.g. D4s v5) or Container Apps Job in **West Europe**, next to Planetary Computer data; ~10–20 h total (~$2–5) | Deallocate when done; no egress fees within region |

**Azure rules (Visual Studio subscriber credit):**
- **Dev/test only, individual use.** Microsoft may suspend instances running continuously > 120 h or used for production, so the judged demo stays on the free hosts above.
- **Never use Azure for AI models** (Azure OpenAI, Foundry-hosted Nemotron). The hackathon scores Nemotron **via Nebius Token Factory**.
- **Keep the spending limit on** (the default). Services stop at $150 instead of charging a card.
- **Budget alert** at $50/month in Cost Management; put everything in one resource group (`rg-naturex-dev`) so it can be deleted in one step.
- **Avoid by default** (easy to overspend): GPU VMs, AKS, App Service Premium, Azure AI Search, Cosmos DB provisioned throughput, Application Gateway, NAT Gateway.
- **Hidden costs to cap:** Log Analytics ingestion (set a daily cap of ~0.1 GB, or disable Container Apps logs); container registry (pull images from GitHub Container Registry, free for public images, instead of Azure Container Registry at ~$5/month).
- **Expected total:** ~$20–30/month with Postgres running, ~$5/month with it stopped, well under $150. Prices are approximate list prices and vary by region **(verify in the Azure Pricing Calculator)**.
- Check your employer's outside-activity and IP policies before using a company-provided benefit for a competition entry.

**Already free:**
- Sentinel-2, Dynamic World, JRC Surface Water, Hansen Forest Change and ESA biomass data.
- Google Earth Engine (non-commercial registration) or Microsoft Planetary Computer.
- ESVD (registration and citation).
- OpenStreetMap Nominatim reverse geocoding (usage policy: ≤ 1 request/s, cache results) and Natural Earth coastline data (public domain).
- All frameworks and libraries (Next.js, React, Tailwind, shadcn/ui, Leaflet, Recharts, FastAPI, SQLModel, Pydantic, openai SDK, tavily-python), plus NeMo Agent Toolkit and OpenTimestamps.
- GitHub (public repo), GitHub Actions and YouTube.

**Judging-period availability (rule: testable free of charge until judging ends, Dec 15, 2026):**
- Free tiers sleep or pause (Supabase after ~1 week idle, Hugging Face Spaces after ~48 h, Render after ~15 min) **(verify)**. Add a GitHub Actions ping to `/healthz` every few hours and re-check everything before Dec 1.
- Keep part of `LLM_BUDGET_USD` in reserve for judges' live runs; serve cached ratings for the 3 demo sites so browsing costs nothing.

**Credit guardrails:**
- Nano for development and tests; Ultra only in the Auditor (~1 call per rating).
- Cache LLM outputs by input hash; precompute the 3 demo sites.
- Run `make eval` manually or nightly, not on every push.
- Hard budget cap: the LLM wrapper sums tokens in `llm_calls` and refuses calls past `LLM_BUDGET_USD`.
- Check per-model prices on the Token Factory pricing page before choosing defaults **(verify)**.

