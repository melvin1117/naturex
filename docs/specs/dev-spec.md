# NatureX — Technical Design (Dev Spec)

> Companion to [pm-spec.md](./pm-spec.md), [one-pager.md](../one-pager.md), [demo-plan.md](./demo-plan.md), [research.md](../research.md) and [diagrams.html](../diagrams.html) (its *Rating Engine* tab mirrors §7). Anything marked **(verify)** should be checked against current Nebius / NVIDIA docs before implementation.

> **Decisions:** stack, versions and design choices are recorded in [ADR-0001](../adr/0001-stack-and-versions.md) (stack and versions) and [ADR-0002](../adr/0002-repo-layout.md) (repo layout). Where this spec and an ADR disagree, **the ADR wins**; update this spec when you add an ADR.

---

## 1. System overview
```
Next.js web app: Exchange `/` + Steward `/steward` (Vercel) ──HTTP/SSE──► FastAPI backend (host chosen in T20, see §21: Nebius Serverless · Azure Container Apps · HF Spaces/Render)
                                 ├── Accounts, sessions and authorization (ADR-0005; server-side sessions, policy in app/authz.py)
                                 ├── Worlds: one live world for real accounts + sandbox worlds for demo sessions
                                 ├── Rating Orchestrator (Nemotron 3 Super, tool-calling)
                                 │     ├── earth_obs tool ──► Google Earth Engine
                                 │     ├── valuation tool (pure Python + cited coefficient CSV)
                                 │     ├── news_scout agent ──► Tavily + Nemotron Nano
                                 │     ├── field_evidence agent ──► MiniCPM-V (perception) + EXIF checks
                                 │     └── auditor agent ──► Nemotron 3 Ultra
                                 ├── Market Engine (pure Python)
                                 ├── Copilot (Nemotron Nano + pgvector RAG, Qwen3 embeddings)
                                 ├── Nature Ledger (hash-chained, append-only)
                                 └── Postgres + pgvector, object storage (Docker/disk locally; hosted per §21)
Scheduled jobs: rerate_all (quarterly / Time Machine), news_sweep (daily via GitHub Actions); Nebius Serverless Jobs optional
```
Design principles:
1. **Deterministic core, LLM on top.** Numbers (areas, values, scores, prices) come from tested Python. LLMs orchestrate, classify, reason, explain, and may adjust the score only within a bounded range with justification.
2. **Cache everything.** Satellite results and LLM outputs are cached per `(asset_id, data_version)` so the demo is fast and cheap.
3. **Mock first.** Each module ships with a mock implementation behind the same interface (`USE_MOCKS=true`).

## 2. Tech stack
| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js **15.5** (App Router), TypeScript strict, Tailwind v4, shadcn/ui | Pin per [ADR-0001](../adr/0001-stack-and-versions.md); not Next 16 for the hackathon |
| Maps | react-leaflet + leaflet-draw (or MapLibre + terra-draw) | Esri/OSM basemap; land-cover tile overlay |
| Charts | Recharts | Price chart with event markers |
| Backend | Python 3.12, FastAPI, SQLModel, Pydantic v2 | |
| DB | Postgres 16 + pgvector; local Docker for development | Hosted DB per §21 (Supabase free tier or Azure Database for PostgreSQL) |
| Object storage | Local disk in development; hosted per §21 (Supabase Storage or Azure Blob) | Tiles, thumbnails, evidence, report PDFs |
| LLM | **Nebius Token Factory** (OpenAI-compatible) | `openai` Python SDK with custom `base_url` |
| Search | **Tavily** (`tavily-python`) | News Scout |
| Earth observation | **Google Earth Engine** (`earthengine-api`, `geemap`), non-commercial registration | Required: Planetary Computer lacks Dynamic World, Hansen and GEDI, so it's a fallback only for other datasets |
| Agent loop | **PydanticAI** via Token Factory `OpenAIProvider` | Plain OpenAI tool-calling loop as fallback; see ADR-0001 |
| Deploy | Frontend → Vercel Hobby; backend + DB → **chosen in T20** from the ranked options in §21 (Nebius Serverless if credits → Azure with team-approved credits → free tiers); jobs → in-process (Time Machine) + GitHub Actions cron | AI always via Token Factory |
| AI dev tooling | `AGENTS.md`, shared skills (`.agents/skills`), MCP servers (GitHub, Context7, shadcn, Playwright, Chrome DevTools) | Setup: [docs/ai-setup.md](../ai-setup.md) |
| Tests | pytest, Playwright | |

> Cost: every component is free or has a free alternative, except the mandatory Nemotron calls on Token Factory, which run on hackathon credits. See §21.

## 3. Model routing (Nebius Token Factory)
| Role | Model | Why | Env var |
|---|---|---|---|
| Orchestrator | Nemotron 3 Super `nvidia/nemotron-3-super-120b-a12b` | Reliable tool-calling, good cost/quality | `MODEL_ORCHESTRATOR` |
| Auditor / Rating Analyst | Nemotron 3 Ultra | Deep cross-evidence reasoning, long context | `MODEL_AUDITOR` |
| News classification | Nemotron 3 Nano | High volume, cheap, fast | `MODEL_FAST` |
| Field evidence: perception only (photos) | `openbmb/MiniCPM-V-4_5` (no Nemotron vision model on Token Factory) | Valid JSON in ~1 s; Nemotron Ultra still judges the evidence | `MODEL_MULTIMODAL` |
| Copilot | Nemotron 3 Nano | Low latency chat | `MODEL_FAST` |
| Embeddings | `Qwen/Qwen3-Embedding-8B` with `dimensions=1024` (no NVIDIA embedding model on Token Factory) | RAG over reports; matches `vector(1024)`; no local model | `MODEL_EMBED` |

Exact IDs, prices and test evidence: [ADR-0003](../adr/0003-model-routing-on-token-factory.md) (`make check-keys` lists what your key can call). Auditor: `nvidia/Nemotron-3-Ultra-550b-a55b`; Nano: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`. `nvidia/Nemotron-3_5-Lightning` (Nano price, 1M context) is compared against Nano in T02.

**Routing rules (and how we prove them):**
- Use reasoning / "thinking" mode only where it pays off. Keep it off for classification, chat and orchestration, and for the Auditor's JSON call too (T26: with thinking on, Ultra spent its whole 3,000-token cap reasoning and returned truncated JSON; see §7.7) with `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` (verified in T02; Nemotron reasons by default). Structured output uses `response_format` `json_schema` in the OpenAI shape (`name`, `schema`, `strict`); see [ADR-0003](../adr/0003-model-routing-on-token-factory.md) for the measured results.
- The eval harness (§18) runs each task on Nano, Super and Ultra and records accuracy, p50 latency and cost per call. That produces the README routing table, turning the choice of model into evidence rather than opinion.
- On timeout or invalid JSON, retry once on the same model, then fall back one tier (Ultra → Super → Nano) and flag the report `degraded_model=true`.

```python
# backend/app/llm.py
from openai import OpenAI
client = OpenAI(base_url=settings.TOKEN_FACTORY_BASE_URL, api_key=settings.NEBIUS_API_KEY)
# TOKEN_FACTORY_BASE_URL e.g. https://api.tokenfactory.nebius.com/v1/  (verify region URL)
```
Every call goes through a wrapper that logs `model, prompt_tokens, completion_tokens, latency_ms, agent, asset_id` to `llm_calls`. Surface this in an **"Agent trace" drawer** in the UI: it shows judges exactly how Nemotron is used.

**As built (T09), `backend/app/llm.py`:**
- `LLMClient.structured()` (Pydantic-validated JSON), `.text()` and `.tool_step()` (one step of a tool loop; the caller runs the tools). All three take an `agent` name and a `Tier`: `fast`, `orchestrator` or `auditor`, which map to `MODEL_FAST`, `MODEL_ORCHESTRATOR` and `MODEL_AUDITOR`.
- **Reasoning is off unless `reasoning=True`.** The reasoning text is returned on the result.
- **Fallback:** the requested tier gets one retry, then each lower tier gets one attempt. So the Auditor tries Ultra, Ultra, Super, Nano. An answer from a lower tier sets `degraded=True`.
- **Errors:** timeouts, connection errors, response-validation errors, 429s and 5xx are retried. Any other 4xx fails fast and isn't charged.
- **Logging:** every attempt is written to `llm_calls`, including failed ones, with `tier`, `status` (`reserved`/`ok`/`invalid_output`/`error`) and `cost_usd`. It's committed in its own session, so it survives a caller rollback.
- **Budget (hard cap):**
  - Before each attempt, the client **reserves** the worst-case cost: a generous prompt estimate (2 chars/token) plus `max_tokens`.
  - The reservation is an `llm_calls` row written under a Postgres advisory lock, so concurrent workers can't overshoot. It raises `BudgetExceeded` if spent + reserve > `LLM_BUDGET_USD`; callers then serve cached results.
  - After the call, the row is settled to the real cost. Timeouts, unknown usage and crashes keep the worst-case charge (fail closed).
- Prices are a fixed table from ADR-0003, and a model without a price is refused. Strict `json_schema` was verified live with the real `AuditorOutput` and `NewsScoutOutput` contracts.

## 4. Repository layout
```
naturex/
├── LICENSE                     # MIT (must show in GitHub About)
├── README.md                   # setup, run, Nemotron/Token Factory usage, architecture image
├── AGENTS.md, CLAUDE.md        # shared instructions for all AI coding assistants
├── docs/
│   ├── one-pager.md, research.md, ai-setup.md, diagrams.html
│   ├── specs/                  # pm-spec.md, dev-spec.md, demo-plan.md
│   └── adr/                    # architecture decision records (MADR)
├── .agents/skills/             # shared AI skills (mirrored in .claude/skills/; see scripts/sync-skills.sh)
├── compose.yml                 # postgres+pgvector (local dev); see ADR-0002
├── frontend/src/               # ADR-0002: code lives under src/
│   ├── app/
│   │   ├── page.tsx                  # Marketplace
│   │   ├── list/page.tsx             # Listing portal
│   │   ├── asset/[id]/page.tsx       # Asset page (report, chart, trade, alerts)
│   │   ├── portfolio/page.tsx
│   │   ├── admin/page.tsx            # Time Machine
│   │   └── dev/ui/page.tsx           # component showcase (T21)
│   ├── components/ (ui/ = shadcn; MapDraw, PriceChart, ReportView, TradePanel, CopilotChat, AgentTrace, SandboxBanner, PersonaSwitcher)
│   ├── tour/                         # Driver.js judge tour (demo-plan §3)
│   └── lib/api/                      # generated OpenAPI client (T08)
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
│   │   │   ├── geometry.py           # listing polygon checks: shape, 10–50,000 ha, overlap (T36)
│   │   │   ├── earth_obs.py          # GEE / PC implementation + mock
│   │   │   ├── valuation.py
│   │   │   └── scoring.py
│   │   ├── market/engine.py
│   │   └── rag/ (embed.py, retrieve.py)
│   ├── data/coefficients.csv          # cited published values; never raw ESVD data (licence)
│   ├── data/demo_sites/*.geojson + cached metrics JSON
│   └── tests/
├── jobs/
│   ├── rerate_all.py                 # job entrypoint (in-process, GitHub Actions, or Nebius Serverless Job)
│   └── news_sweep.py
├── evals/ (news.jsonl, scenarios/, run.py, results.md)
├── scripts/ (precompute_sites.py, sync-skills.sh)
└── .github/workflows/ (ci.yml, eval.yml)
```

## 5. Data model (Postgres)
```sql
create extension if not exists vector;

create table worlds (                 -- 'live' (real accounts, ADR-0005), 'template', and one sandbox per demo session
  id uuid primary key default gen_random_uuid(),
  label text not null,                 -- e.g. 'template' for the seed world
  created_at timestamptz default now(),
  last_seen_at timestamptz default now()
);
-- Every table except `worlds` carries `world_id uuid references worlds(id)` (not null, except
-- llm_calls.world_id): users (personas), assets, metrics, events, reports, prices, holdings,
-- orders, alerts, doc_chunks, ledger_entries, llm_calls. Metrics and doc_chunks are per world too,
-- because they reference per-world assets and reports.
-- Precomputed demo-site data lives in backend/data/demo_sites/ and is copied into a world when
-- it's created on a visitor's first request, with the personas, demo assets and baseline reports.

create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('community','investor','admin')),  -- persona label only; not used for authorization (ADR-0005)
  cash_balance numeric(14,2) not null default 10000,
  kind text not null default 'persona' check (kind in ('person','persona','treasury')),  -- ADR-0005
  email text,                          -- lower-cased; null for personas and treasuries
  password_hash text,                  -- argon2id (pwdlib); only for kind = 'person'
  is_admin boolean not null default false,  -- live world: set only by the operator CLI
  unique (world_id, id)                -- target of composite foreign keys
);
create unique index users_world_email on users (world_id, lower(email)) where email is not null;

-- ADR-0005: accounts, communities and authorization (tasks T54, T56)
create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash char(64) not null unique,  -- sha256 of the cookie token; the token itself is never stored
  world_id uuid not null, user_id uuid not null,
  foreign key (world_id, user_id) references users (world_id, id),  -- pruning a world deletes its sessions first
  kind text not null check (kind in ('password','demo')),
  created_at timestamptz default now(), last_seen_at timestamptz default now(),
  expires_at timestamptz not null      -- 30 d absolute; 7 d idle enforced from last_seen_at
);
create table auth_attempts (           -- Postgres-backed rate limits (shared across instances; T66)
  id bigserial primary key,
  bucket text not null check (bucket in ('ip','account')),  -- independent buckets
  key_hmac char(64) not null,          -- HMAC(AUTH_RATE_LIMIT_SECRET, ip | lower(email)); no raw email
  kind text not null check (kind in ('login','register')), created_at timestamptz default now()
);
create index on auth_attempts (bucket, key_hmac, created_at);  -- rows older than 24 h are pruned
create table communities (
  id uuid primary key default gen_random_uuid(), world_id uuid not null references worlds(id),
  name text not null, country text, description text,
  treasury_user_id uuid not null,      -- kind = 'treasury'; never signs in or trades
  created_at timestamptz default now(),
  unique (world_id, id),
  foreign key (world_id, treasury_user_id) references users (world_id, id)
);
create table community_members (       -- owner-only for the Must; stewards are a Should
  world_id uuid not null, community_id uuid not null, user_id uuid not null,
  role text not null check (role in ('owner','steward')),
  primary key (community_id, user_id),
  foreign key (world_id, community_id) references communities (world_id, id),
  foreign key (world_id, user_id) references users (world_id, id)
);
create table assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  community_id uuid,                                  -- ADR-0005: the community that manages the listing
  community_user_id uuid,                             -- the community's treasury (kind = 'treasury'): retained stake, seeded at IPO, + its dividends (T41)
  verification_revoked_at timestamptz,                -- ADR-0006: set on revoke; while set, demo_auto can't approve; cleared only by a human admin approval
  -- ADR-0005 (T56): unique (world_id, id); foreign key (world_id, community_id) → communities (world_id, id);
  --                 foreign key (world_id, community_user_id) → users (world_id, id)
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

-- ADR-0006: listing verification (T69). Documents are private; the ledger keeps only randomized commitments.
create table verification_runs (       -- one row per run; one current run per asset
  id uuid primary key default gen_random_uuid(), world_id uuid not null, asset_id uuid not null,
  level text not null check (level in ('unverified','documents_submitted','verified','rejected','revoked')),
  is_current boolean not null default true,
  input_fingerprint char(64) not null, -- sha256(community, name, geometry, area, document commitments, method_version, mode, evidence_kind); any change → unverified
  checklist jsonb not null,            -- [{check, result: pass|warn|fail, found, source}]; public panel shows names + results only
  ai_suggestion text check (ai_suggestion in ('consistent','inconsistent','unreadable')), ai_reasons jsonb,  -- T71; untrusted heuristic
  reviewer_role text check (reviewer_role in ('platform_admin','partner_reviewer','demo_auto')), reviewer_user_id uuid, reason text,
  mode text not null check (mode in ('review','demo')),  -- deployment mode at creation (ADR-0006 §6)
  evidence_kind text not null check (evidence_kind in ('sample','real')),  -- set by trigger at submission from ALL linked documents' is_sample
  check (reviewer_role is distinct from 'demo_auto' or (mode = 'demo' and evidence_kind = 'sample')),
  method_version text not null, created_at timestamptz default now(),
  unique (world_id, id), unique (world_id, asset_id, id),
  foreign key (world_id, asset_id) references assets (world_id, id),
  foreign key (world_id, reviewer_user_id) references users (world_id, id)
);
-- Write-once: a trigger rejects changes to input_fingerprint, checklist, ai_*, method_version, mode and evidence_kind, and
-- rewrites of reviewer_role/reviewer_user_id/reason once set; a second trigger derives evidence_kind at submission and rejects
-- listing_documents.run_id changes once the run is submitted; level may move only
-- documents_submitted → verified | rejected, or verified → revoked; is_current only true → false (superseded). Every
-- decision is also appended to the ledger, which is append-only (migration 0003).
create unique index verification_runs_current on verification_runs (world_id, asset_id) where is_current;
create table document_fingerprints (   -- binds a document's private fingerprint to ONE asset: no reuse across assets,
  world_id uuid not null, private_fingerprint char(64) not null, asset_id uuid not null,  -- reuse for the same asset's re-runs is fine
  primary key (world_id, private_fingerprint), unique (world_id, private_fingerprint, asset_id),
  foreign key (world_id, asset_id) references assets (world_id, id)
);
create table listing_documents (       -- sensitive personal data; private storage; deleted 30 days after the listing
  id uuid primary key default gen_random_uuid(), world_id uuid not null, asset_id uuid not null, run_id uuid,
  doc_type text not null check (doc_type in ('title','agrarian_certificate','assembly_minutes','entity_registration','other')),
  storage_key text not null,           -- generated; never exposed
  mime text not null, size_bytes int not null,
  private_fingerprint char(64) not null,  -- HMAC(per-world key, file); dedup only, never published
  commitment_nonce bytea not null,     -- private; the ledger stores sha256(nonce || file); deleted with the listing
  extracted jsonb,                     -- T71 fields (may hold names): members and reviewers only
  is_sample boolean not null default false,  -- generated fictional sample (demo mode), watermarked
  uploaded_by uuid,                    -- null after account deletion (anonymised)
  created_at timestamptz default now(),
  foreign key (world_id, asset_id) references assets (world_id, id),
  foreign key (world_id, asset_id, run_id) references verification_runs (world_id, asset_id, id),  -- same asset's run only
  foreign key (world_id, private_fingerprint, asset_id) references document_fingerprints (world_id, private_fingerprint, asset_id),
  foreign key (world_id, uploaded_by) references users (world_id, id)
);
create table payout_lines (            -- private and erasable; the public ledger holds only a hash commitment (T67)
  id bigserial primary key, world_id uuid not null, asset_id uuid not null, quarter_label text not null,
  user_id uuid not null, shares bigint not null, amount numeric(14,2) not null,
  foreign key (world_id, asset_id) references assets (world_id, id),
  foreign key (world_id, user_id) references users (world_id, id)
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
  kind text not null check (kind in ('listing','report','event','price_anchor','payout','verification')),  -- 'verification': ADR-0006 (T69)
  ref_id uuid,                         -- id of report/event/etc.
  payload jsonb not null,              -- canonical snapshot of what was recorded
  prev_hash char(64) not null,         -- '0'*64 for seq 0
  hash char(64) not null,              -- sha256(canonical_json(payload)+kind+seq+prev_hash)
  created_at timestamptz default now(),
  unique (asset_id, seq)
);
-- Append-only at DB level (migration 0003): a trigger rejects UPDATE, DELETE and TRUNCATE.
-- Only a sandbox reset (T31) may delete, by opting in for its own transaction:
--   SET LOCAL naturex.allow_ledger_delete = 'on';

create table world_events (           -- T29: SSE + polling replay by visitor world
  id bigserial primary key,
  world_id uuid references worlds(id),
  type text not null check (type in ('rating_progress','price_tick','alert','heartbeat')),
  payload jsonb not null,
  created_at timestamptz default now()
);
create index ix_world_events_world_id_id on world_events(world_id, id);
create index ix_world_events_created_at on world_events(created_at);

create table llm_calls (
  id bigserial primary key, agent text, model text, asset_id uuid,
  prompt_tokens int, completion_tokens int, latency_ms int,
  cost_usd numeric(12,6) not null default 0, tier text, status text not null default 'ok',  -- T09
  created_at timestamptz default now()
);
```

## 6. API (FastAPI)
| Method & path | Purpose |
|---|---|
| `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` · `GET /me` | Accounts and sessions (ADR-0005, T54) |
| `POST /demo/start` · `POST /demo/persona` | One-click demo session in a new sandbox world; switch persona (demo sessions only; T55) |
| `POST /communities` · `GET`/`PATCH /communities/{id}` · `…/members` · `GET /communities/{id}/summary` | Communities, members (owner only), Steward home data (T56, T63) |
| `POST /assets` | Create a **draft** listing in the caller's community from GeoJSON + details (steward or owner; T58) |
| `POST /assets/{id}/submit` | Start a rating run; the result sets `listed` / `needs_evidence` / `ineligible` (T58) |
| `GET /assets/{id}/ipo/preview` · `POST /assets/{id}/ipo` | IPO price with every formula term; launch (owner only, once; T59) |
| `POST /admin/assets/{id}/suspend` · `…/resume` | Moderation (admin; T58) |
| `POST /assets/{id}/documents/sample` | Demo mode only (404 in review mode, nothing created): generate watermarked fictional documents from non-personal fields (listing reference, place from reverse geocode, area) + synthetic identities and run the checklist; the `demo_auto` reviewer approves only if every document is a sample, every check passes and no revocation is active (ADR-0006 §6) |
| `POST /assets/{id}/documents` · `GET /assets/{id}/documents/{doc_id}` | Upload evidence (steward/owner) → checklist; download a document (community members + same-world admins only; 404 otherwise; attachment, `nosniff`, `no-store`) (ADR-0006, T69) |
| `GET /assets/{id}/verification` · `POST /admin/assets/{id}/verification` · `POST /admin/assets/{id}/verification/revoke` | Public verification summary (check names + results + not-checked list); reviewer approve/reject with a reason; revoke (suspends trading) (T69) |
| `GET /assets` | Marketplace list (latest price, grade, trend) |
| `GET /assets/{id}` | Asset detail + latest report + recent events |
| `POST /assets/{id}/evidence` | Upload photos (audio post-hackathon) → field_evidence agent → event + re-rate |
| `GET /assets/{id}/reports` · `GET /reports/{id}` · `GET /reports/{id}/diff/{prev}` | Report history & diffs |
| `GET /assets/{id}/prices?range=` | Price history |
| `POST /orders` | `{asset_id, side, qty}` → Market Engine → fill |
| `GET /portfolio` | Holdings, P&L, impact |
| `POST /copilot` | `{question, asset_id?}` → grounded answer + citations (streamed) |
| `GET /events/stream` | SSE: price ticks, alerts, rating progress (polling fallback `GET /events?since=` or `?since_id=`) |
| `POST /admin/simulate/quarter` | Trigger re-rate of all assets with next `data_version` |
| `POST /admin/simulate/event` | Inject preset event (fire, encroachment, drought, restoration, protection) |
| `GET /admin/trace?asset_id=` | LLM call trace for Agent Trace drawer |
| `GET /ledger/{asset_id}` | Ledger entries (hashes, kinds, timestamps) |
| `GET /ledger/{asset_id}/verify` | Recomputes the chain → `{valid, entries, broken_at?}` |
| `POST /admin/tamper-demo` | *(DEMO_MODE only)* mutates a copy of one entry to show verification failing |
| `GET /world` | The caller's world (from the session; anonymous = the live world) and, in demo sessions, its personas |
| `POST /world/reset` | "Reset my demo" (demo sessions only): re-seeds the world, keeping persona user IDs so the session stays valid |

`ReportOut.summary_source` is additive metadata for the generated client: `"live"` means
`summary_md` was written by a live Nemotron Nano call from deterministic report facts, and
`"fallback"` means it came from the deterministic template used for mock mode, missing keys,
budget exhaustion or invalid model output. The summary prose must not contain numbers outside
the input facts.

Every route is scoped to the caller's world, which comes from the session: anonymous requests read the live world, password sessions use the live world, and demo sessions use their sandbox (ADR-0005). Judges never affect each other or the live world. *(T31 below describes the `nx_world` cookie, which T55 retires.)*

### 6.1 Authorization (ADR-0005)
- `app/authz.py`: pure `authorize(principal, action, resource) -> Allow | Deny(reason)`, tested over every role × action; routes use a `require(action)` dependency.
- **Every route, reads included,** loads resources by `(world_id, id)` before authorizing; a route-inventory test fails if any route has no authorization dependency, and a cross-world test returns 404 for every object endpoint.
- **SSE and polling** take the principal and world from the session, recheck the session on every poll and heartbeat, and close after logout, expiry or revocation.
- **Roles:** any signed-in user can trade; community **owner** / **steward** via `community_members`; **admin** via `users.is_admin`, scoped to its world. The full matrix is in ADR-0005 §3.
- **Errors:** 401 `auth_required`; 403 with a reason (`owner_only`, `insider_trading_blocked`, …); 404 for anything in another world.
- **Rules:** orders always use the principal's user; community members can't trade their own asset, and a holder of its shares can't be added as a member (409 `member_has_holdings`); admins and treasury accounts never trade; the ledger tamper demo runs only in sandbox worlds.
- **CSRF:** `SameSite=Lax` cookies plus an exact `Origin` (else `Referer`) allowlist (`ALLOWED_ORIGINS`) on every POST, PUT, PATCH and DELETE, uploads included; both missing, malformed or `null` → rejected; JSON routes require a JSON media type.

**As built (T31), before ADR-0005.** T55 changes three things below: the `nx_world` cookie is replaced by the session; reset keeps persona user IDs (mapped by `persona_key`) instead of re-copying them with fresh IDs, so the session survives; pruning deletes a world's sessions first. The rest stays:
- **Only `GET /world` creates a world.** It reads the `nx_world` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` unless `ENVIRONMENT` is development/test, 30 days, `Cache-Control: no-store`); a missing, malformed or unknown cookie, or one naming the **template** world, gets a fresh world.
- New worlds are capped at `SANDBOX_MAX_NEW_WORLDS_PER_HOUR` (default 300) → 503 with `Retry-After`.
- World-scoped routes use `CurrentWorld` (`app/deps.py`) and return **401 `world_required`** without a valid cookie; they never create worlds. The frontend calls `GET /world` first (T32). Today the ledger and world routes are scoped; the other routers adopt `CurrentWorld` as they move off mocks.
- A new world is a copy of the template (`app/sandbox.py`, including the community's retained holdings) with fresh IDs and every reference remapped. Ledger chains still verify, because hashes don't include IDs.
- `POST /world/reset` deletes the world's rows (the ledger-delete opt-in is switched on only around those deletes) and re-copies the template, keeping the same ID and cookie. `llm_calls` rows are kept (detached) so the spend cap still counts them.
- Stale worlds (7 days unseen) are pruned at most every 10 minutes, with locked rows skipped; a failed prune never fails the request. The template is never served, reset or pruned.
- The cookie is first-party only because the browser calls the frontend's `/api/*` rewrite (next.config.ts → `BACKEND_URL`), not the backend host directly (T20).

Rating runs asynchronously: the API returns `202` + `run_id`, and progress arrives over SSE (`step: earth_obs → valuation → news → evidence → audit → done`).

**As built (T29):**
- `app.events.publish(session_or_conn, world_id, type, payload)` writes `rating_progress`, `price_tick` and `alert` events into `world_events` in the caller's transaction, so rolled-back business changes do not leak as live events. Same-world publishers take a transaction advisory lock before insert, which makes monotonic event IDs match commit visibility for that world; publishing transactions must stay short. Rating progress should publish each step in its own short transaction instead of holding one transaction across a full rating run.
- `GET /events/stream` uses standard `text/event-stream` over HTTP, sends `id:`, `event:`, `data:` and `retry:` fields, resumes from `Last-Event-ID`, and emits transient `heartbeat` events every ~15 s so proxies do not drop idle connections.
- Fan-out is by short-interval database polling rather than per-process queues or LISTEN/NOTIFY. This is less clever but portable across multiple workers, serverless timeouts and free-tier hosts; events are persisted first, so reconnects and the polling fallback replay from the same source of truth.
- Streams are finite (clients reconnect automatically), poll the database from a threadpool with short-lived sessions every 1 s, and set `Cache-Control: no-cache` plus `X-Accel-Buffering: no`. `EVENT_STREAM_MAX_CONCURRENT` defaults to 40: this matches the approximate Starlette/AnyIO threadpool size, while the SQLAlchemy DB pool is 15 connections and each poll releases its session immediately. At the default cap the upper bound is ~40 short DB polls/s per process. Overflow returns `503` + `Retry-After`, so clients can fall back to polling. `GET /events?since_id=` is the preferred cursor; legacy `since=` datetime remains accepted for generated clients.
- Retention keeps live replay lightweight by pruning `world_events` older than 24 h during the existing sandbox prune path; deleting a stale visitor world also deletes its events.

> Free hosts and serverless endpoints may drop long-lived connections **(verify)**; the frontend falls back to polling every 3 s.

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
| NDVI series & trend | Sentinel-2 SR Harmonized, Cloud Score+ masked, water pixels excluded | Monthly median NDVI in P; **Sen's slope** per year over 5 yrs with a Mann-Kendall significance test (`ee.Reducer.sensSlope`), per ADR-0001 |
| Water change | JRC Global Surface Water | Occurrence change intensity mean in P |
| Forest loss | Hansen Global Forest Change | Loss area (ha) in last 5 yrs (`forest_loss_ha`) and in the latest complete year (`forest_loss_last_12m_ha`, listing gate), both masked to `treecover2000` ≥ 30% |
| Biomass | ESA CCI Biomass v6.0 (2022, 100 m); GEDI L4B as a cross-check | Mean AGB t/ha (`biomass_t_ha`); GEDI mean in `biomass_gedi_t_ha`, null where GEDI has no 1 km cell in P |
| Mangrove extent | Global Mangrove Watch v3.0 (2020, CC BY 4.0) | Area share of P mapped as mangrove (`mangrove_fraction`); T14 values `min(mangrove_fraction, trees + flooded_vegetation)` as mangrove, from flooded vegetation first, then trees |
| Soil organic carbon | SoilGrids 2.0 `ocs` (ISRIC, CC BY 4.0) | Mean 0–30 cm stock in P, t C/ha (`soc_t_c_ha`) |
| Data coverage | Sentinel-2 | Count of cloud-free observations |

Demo sites: run offline once and store to `data/demo_sites/*.json` (method, sites and results in [ADR-0004](../adr/0004-earth-observation.md)). **Time Machine versions (T13)** are generated by applying scripted, deterministic deltas from `data/demo_sites/scenarios.json` to the observed metrics (`app/tools/scenarios.py`, no Earth Engine call), and stored as `data/demo_sites/scenarios/<site>.<scenario>.json`:
- Timeline per site: `baseline` (observed, `data_version='2026Q3'`) → `restoration` (`sim-1`, shown as 2026Q4, based on the baseline) → `encroachment` (`sim-2`, shown as 2027Q1, based on `sim-1`).
- Deltas: land-cover transfers in percentage points (shares stay ≥ 0 and sum to 1; tree cover removed counts as forest loss in both windows), an NDVI step on the latest 12 months (mean, Sen's slope and Mann-Kendall are recomputed from the shifted series), water change, and a biomass change.
- Every simulated version carries `simulated: true`, `scenario`, `based_on`, `period`, `observed_data_version`, its `scenario_deltas` and a `provenance_note`, and keeps the observed provenance (`date_windows` describe the observed data, never the simulated quarter). Mangrove share shrinks with cleared trees + flooded vegetation. Load one with `load_site_metrics(site_key, scenario)`, which checks the file's labels.
- `scripts/precompute_sites.py --check` reproduces all of it; `--scenarios-only` skips Earth Engine.

### 7.3 Valuation engine (deterministic)
```
value_c   = area_ha × share_c × coeff_c × context_multiplier      (context_multiplier = 1 for now)
value_mid = Σ value_c
value_low = Σ area_ha × share_c × coeff_low_c × context_multiplier
value_high= Σ area_ha × share_c × coeff_high_c × context_multiplier
```
**As built (T14):** `backend/app/tools/valuation.py` (`value_site`, a pure function, plus `value_metrics` for cached `EarthObsMetrics`) and `backend/app/tools/coastline.py`. The context multiplier is one site-level `Decimal` applied to low, mid and high alike, so low ≤ mid ≤ high always holds.

**Price basis: Int$ at 2020 price levels per ha per year** (Brander et al. 2024's basis; one Int$ buys what one US$ buys in the US, so Int$2020 = US$2020 at US prices). Only this basis is used: Costanza et al. 2014 contributes dimensionless median/mean ratios, never dollar values, so no deflator or PPP conversion is applied anywhere. The UI can label the figures "$ (2020)".

**Coefficients** live in `backend/data/coefficients.csv`, one row per biome with table and row citations. Only published statistics are used:
- **mid = high = the Brander et al. 2024 Table 1 biome mean** ("Sum" row; CC BY 4.0; ESVD summary means, so no raw ESVD data is committed). Brander publishes no biome-level dispersion: Appendix Table A1 gives one dispersion per service cell (the caption says standard errors, the text says standard deviations), many cells are NA, and a biome total would need an independence assumption. So we don't invent an upper bound.
- **low = an indicative median-equivalent**: the Brander mean × the median/mean ratio of the matching row in Costanza et al. 2014 Table 4 (which reproduces de Groot et al. 2012 Table 3). It's indicative because the ratio comes from the 2012 ESVD sample, not Brander's. Distributions are right-skewed, so low sits far below the mean where the median does (coastal wetlands) and close to it where they agree (grassland, lakes).

| Dynamic World class | Biome (Brander 2024 Table 1 column) | low | **mid = high** | Low ratio row (Costanza 2014 Table 4, median / mean) |
|---|---|---|---|---|
| flooded_vegetation (coastal, \|lat\| < 30°) | Mangrove (Mangroves) | 4,890 | **77,928** | Coastal wetlands 12,163 / 193,845 |
| flooded_vegetation (coastal, \|lat\| ≥ 30°) | Coastal systems: tidal / salt marsh, estuary, lagoon (Coastal systems) | 2,260 | **36,026** | ⚠️ fallback: Coastal wetlands (de Groot's "Coastal systems" row excludes marshes) |
| flooded_vegetation (inland) | Swamps / floodplains (Inland wetlands) | 21,901 | **34,018** | Inland wetlands 16,534 / 25,682 |
| water | Lakes / rivers (Rivers and lakes) | 30,868 | **33,447** | Rivers and lakes 3,938 / 4,267 |
| trees (\|lat\| < 23.5°) | Tropical & sub-tropical forests | 3,653 | **8,166** | Tropical forest 2,355 / 5,264 |
| trees (other) | Temperate forest and woodland | 5,824 | **15,570** | Temperate forest 1,127 / 3,013 |
| grass | Rangeland, natural grasslands & savannas | 5,576 | **5,934** | Grasslands 2,698 / 2,871 |
| shrub_and_scrub | Shrubland and shrubby woodland | 684 | **728** | ⚠️ fallback: Grasslands (no published shrubland median) |
| GMW mangrove share (see below) | Mangrove (Mangroves) | 4,890 | **77,928** | Coastal wetlands |
| crops, built, bare, snow_and_ice | Not valued as natural capital | 0 | **0** | — |

Fallback rows add the flag `low_bound_fallback:<biome>`. All mid values were transcribed from Table 1 and cross-checked: each column's per-service cells add up to the published "Sum" row (to rounding) and the value counts match exactly. The superseded starter table (Costanza 2014 Table 3, 2007 US$) is no longer used.

**Mangrove vs marsh:** mangroves grow "largely between 30° N and 30° S latitude" (Giri 2021, *Remote Sensing* 13:563, CC BY), so coastal flooded vegetation at |lat| ≥ 30° is valued as Brander's "Coastal systems", which includes tidal and salt marshes (ESVD classification: de Groot, Brander & Solomonides 2020, Appendix 6, codes 3.2–3.3; Brander 2024 footnote 7 splits mangroves out of it). Outlying mangroves beyond 30° (Bermuda, Japan, south-east Australia, South Africa) are valued conservatively as coastal systems unless GMW maps them.

**Global Mangrove Watch share:** Dynamic World labels most mangrove canopy as `trees`. When the optional input `mangrove_fraction` (GMW v3, Bunting et al. 2022, CC BY 4.0; read from the precomputed metrics, T13) is set, `m = min(mangrove_fraction, trees + flooded_vegetation)` is valued as Mangrove, taken from flooded_vegetation first and then from trees, which shrink by that amount. GMW is an observed map, so this ignores the coastal check and latitude (the coastal result is still reported); a capped fraction adds the flag `mangrove_fraction_capped`. The result lists the reassigned share as `gmw_mangrove` plus a `mangrove` block (input, applied, from each class). There is no "coastal trees = mangrove" heuristic.

**Coastal** = centroid within 5 km of the Natural Earth 1:10m coastline (v5.1.2, public domain), bundled unmodified as `backend/data/coastline/ne_10m_coastline.geojson.gz` (3.4 MB; `python3 scripts/fetch_coastline.py` regenerates it byte for byte). Distance is geodesic: STRtree candidates within a lon/lat box that contains the search disc, measured in an azimuthal equidistant projection centred on the point. The index loads lazily, once, behind a lock. Coastal `water` stays lakes/rivers; the result then carries the flag `coastal_water_as_lakes` so the report can disclose it (lagoons may fit Brander's "Coastal systems" better).

**Service breakdown:** `backend/data/service_values.csv` holds Brander 2024 Table 1's per-service means for each biome used, each mapped to one of eight groups: food & materials, water supply, climate regulation, flood & hazard regulation, pollution & soil, habitat & biodiversity, recreation & culture, existence & bequest. Each class's mid value is split in proportion to its biome's service means.

**Land cover:** fractions must be finite and in [0, 1]. A sum within ±0.01 of 1 is renormalised to 1 and flagged `landcover_renormalised`; anything else is rejected. Missing classes count as 0; unknown class names are rejected, as are negative or NaN inputs.

**Rounding:** all arithmetic is `Decimal` at 50 significant digits. Only outputs are rounded: totals to whole Int$ (round half to even); per-class and per-service splits by the largest-remainder method (ties by name), so they sum exactly to the rounded totals. Carbon is rounded to whole tCO₂.

**Carbon (tCO₂ only; never added to the $ value, which already includes climate regulation):**
```
biomass_tCO2 = AGB_t_ha × (1 + R) × area_ha × 0.47 × 44/12
soc_tCO2     = SOC_tC_ha × wetland_area_ha × 44/12          (flooded vegetation + GMW mangrove)
seq_tCO2_yr  = Σ_u area_ha × share_u × G_u × (1 + R_u) × 0.47 × 44/12     (gross Tier 1 biomass gain)
```
AGB is the site mean (`biomass_t_ha`), which is mostly woody biomass, so **R comes from woody cover**: when trees or GMW mangrove are present, R is their share-weighted ratio (trees only → the trees row for the climate zone); otherwise R is the ratio of the dominant vegetated class (ties by name); with no vegetation, R = 0. The result reports `root_shoot_ratio_basis` (`woody`, `dominant:<class>` or `none`). SOC (SoilGrids, t C/ha, 0–30 cm) comes from the precomputed metrics (T13) and may be missing for a new site; with wetland area and no SOC, `soc_tCO2` is null and the result is flagged `soc_missing`. Factors are in `backend/data/carbon_factors.csv`, keyed by **biome** so carbon always follows the same mapping as the money, with the moist/wet row used wherever IPCC splits by moisture:
| Biome (zone) | R | Source | G (t d.m./ha/yr) | Source |
|---|---|---|---|---|
| Tropical forest | 0.20 | IPCC 2006 V4 Ch4 Table 4.4, tropical moist deciduous, AGB < 125 | 2.0 | Table 4.9, tropical moist deciduous, N & S America, > 20 y |
| Temperate forest | 0.29 | Table 4.4, temperate conifers, AGB 50–150 | 4.0 | Table 4.9, temperate continental forest, > 20 y |
| Grassland (tropical / extratropical) | 1.6 / 4.0 | IPCC 2006 V4 Ch6 Table 6.1, tropical moist & wet / temperate wet | 0 | Ch6 §6.2.1.1: Tier 1 assumes no change |
| Shrubland | 2.8 | Table 6.1, shrubland | 0 | as above |
| Mangrove | 0.492 | IPCC 2013 Wetlands Suppl. Ch4 Table 4.5, mangroves, tropical wet | 9.9 | Table 4.4, tropical wet (the Subtropical rows are internally inconsistent and not used) |
| Coastal systems, swamps / floodplains | 0 | no Tier 1 biomass default (tidal / salt marsh, inland herbaceous wetland) | 0 | carbon comes from SOC |
Carbon fraction 0.47: IPCC 2006 V4 Ch4 Table 4.3.

**With today's committed metrics (T13: ESA CCI biomass, SoilGrids SOC, GMW mangrove fraction)**, `value_metrics` gives (Int$2020/yr, low / mid = high; total carbon stock tCO₂; sequestration tCO₂/yr):

| Site | Low | Mid = high | Carbon stock | Sequestration |
|---|---|---|---|---|
| Wetland (hero) | 2,121,067 | 2,669,511 | 8,828 (incl. SOC) | 306 |
| Ría Celestún mangrove | 2,466,117 | 33,801,307 | 130,883 (incl. SOC) | 10,910 |
| Sumidero restoration forest | 1,295,918 | 2,424,480 | 52,657 | 1,005 |

The mangrove's wide range is real: the published mangrove median is far below the mean (Costanza 2014 Table 4). The worked example below stays pinned to the T11 inputs so it doesn't move when the cache is recomputed.

**Worked example: hero wetland** (T11 snapshot of `wetland_mx.json`, pinned as literals in `backend/tests/test_valuation.py` so it doesn't move when T13 recomputes the JSON): 206.6995 ha, centroid 19.2873, −99.0976 (tropical by the latitude rule), 253.354 km from the coast (inland), AGB 9.4681 t/ha, no SOC or GMW input yet.
| Class | Share | Area (ha) | Biome | low / **mid = high** coefficient | **$/yr (Int$2020)** low / **mid = high** |
|---|---|---|---|---|---|
| water | 0.2484 | 51.3442 | Lakes / rivers | 30,868 / **33,447** | 1,584,891 / **1,717,308** |
| trees | 0.3574 | 73.8744 | Tropical forest | 3,653 / **8,166** | 269,863 / **603,258** |
| flooded_vegetation | 0.0296 | 6.1183 | Swamps / floodplains | 21,901 / **34,018** | 133,997 / **208,133** |
| grass | 0.1024 | 21.1660 | Grassland | 5,576 / **5,934** | 118,022 / **125,599** |
| shrub_and_scrub | 0.1011 | 20.8973 | Shrubland ⚠️ | 684 / **728** | 14,294 / **15,213** |
| built, crops (bare, snow 0) | 0.1611 | 33.2993 | Not valued | 0 | 0 |
| **Total** | 1.0000 | 206.6995 | | | **low 2,121,067 / mid = high 2,669,511** |

By service (mid): existence & bequest 608,919; recreation & culture 554,083; flood & hazard regulation 548,143; water supply 461,645; pollution & soil 186,468; food & materials 119,266; habitat & biodiversity 112,589; climate regulation 78,398 (sum 2,669,511). Carbon: trees are present, so R = 0.20 (tropical forest); biomass stock 9.4681 × 1.20 × 206.6995 × 0.47 × 44/12 = **4,047 tCO₂**; SOC not included (flag `soc_missing`; an illustrative 50 t C/ha would add 1,122 tCO₂); sequestration 73.8744 ha × 2.0 × 1.20 × 0.47 × 44/12 = **306 tCO₂/yr**. Flags: `low_bound_fallback:shrubland`, `soc_missing`.

**Sanity check:** the documentary claim "wetlands might be worth $25–50k per acre per year" is $62–124k/ha/yr. Our pure-wetland coefficients are 34,018 Int$/ha/yr for inland wetlands (below that range) and 77,928 for mangroves (inside it). The hero site averages 12,915 Int$/ha/yr (mid) because only 3% of it is flooded vegetation, a quarter is open water, and 16% is built or cropped. We report this gap rather than tune the numbers to it.

**Known limitations:** global benefit-transfer means, no local adjustment yet (`context_multiplier` reserved for it); the range is one-sided (no published upper bound) and its low end is indicative; temperate tidal marsh and inland herbaceous wetland have no Tier 1 biomass factors; mangroves beyond 30° are valued as coastal systems unless GMW maps them.

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

**As built (T15, `backend/app/tools/scoring.py`, method version `naturex-scoring/1.0`).** The formulas above are implemented exactly, with these refinements:
- **Exact arithmetic and rounding.** All maths is `Decimal`; float inputs go through their shortest repr. NaN, ±inf and out-of-domain inputs (NDVI outside [−1, 1], natural fraction outside [0, 1], water change outside [−100, 100], negative loss, area ≤ 0, severity outside 1–5, direction outside {−1, 0, 1}) raise an error instead of being clamped. Components and confidence terms keep **full precision** in every sum; only the stored snapshot shows them rounded to 4 decimal places. `base_health`, `health` and `confidence` are rounded once, at the end, to **1 decimal place, half-up**, and the grade and gate are decided on those rounded values, so the displayed number is always the graded one (a displayed 90.0 is AAA, never AA). Band edges are inclusive lower bounds (90 → AAA, 89.9 → AA). Rounding the components first could flip a grade: the hero with natural fraction 0.587 is exactly 69.949685 → 69.9 (BBB), while 4-decimal components would give 69.95 → 70.0 (A).
- **V: the trend counts only when significant.** `ndvi_trend` is used only when its Mann-Kendall p < 0.05 (`ndvi_trend_details.significant_05`); otherwise it's treated as 0, i.e. "no significant change" (ADR-0004 finding 2).
- **W: what counts as a wetland.** Wetland status is decided **once per asset** and passed explicitly to every rating: either the asset's declared ecosystem type, or `water + flooded_vegetation ≥ 0.20` in its **baseline** Dynamic World land cover (`is_wetland_from_landcover`). It's never re-derived from the data version being scored: otherwise a wetland drained below 20% water would switch to W = 1 and gain health (the hero at 17% water would jump from 76.2, A, to 84.7, AA). Non-wetlands have W = 1. `water_change` is the stored JRC `change_abs` mean (range −100..100).
- **T** sums severity over events with `direction = −1` only, and skips any marked `relevant = false` by the News Scout.
- **Auditor adjustment** must be an integer in [−10, +10] (matching `AuditorOutput`). Out-of-range values are **rejected, not clamped**, and a non-zero adjustment needs a non-empty reason. Final health is clamped to [0, 100].
- **Agreement before the Auditor runs** defaults to 0.5 (neutral), recorded as `agreement_source = "default"`. Recency uses the age of the freshest Sentinel-2 window (the NDVI window end) on the rating date. `agb_sd` isn't in the confidence formula yet: GEDI L4B's standard-error band isn't in the cached metrics (follow-up).
- **Gate loss proxy.** `forest_loss_last_12m` isn't in the cached metrics yet (T13). Until it is, the gate uses the full 5-year Hansen loss as a conservative upper bound, recorded as `forest_loss_basis = "5y_total_proxy"`. L always uses the 5-year loss.
- **Gate failure codes**, in this order: `confidence_below_70`, `grade_below_c`, `forest_loss_last_12m_at_least_1pct_of_area`.

**Worked example: hero wetland (`wetland_mx.json`, rated 2026-10-07, data age 6 days, no Auditor yet, no field evidence).** Water + flooded vegetation = 0.2484 + 0.0296 = 0.278 ≥ 0.20, so it's a wetland. The Sen's slope +0.0097/yr has p = 0.0986, so it's not used.

| Term | Calculation | Value |
|---|---|---|
| V | clamp(0.5 + 0/0.02) × 0.5 + clamp(0.6008/0.8) × 0.5 = 0.25 + 0.3755 | 0.6255 |
| N | natural fraction | 0.8389 |
| L | 1 − clamp(0 / (0.1 × 206.6995)) | 1.0000 |
| W | clamp(0.5 − 6.6021/100) | 0.433979 |
| T | no events | 1.0000 |
| base_health | 100 × (0.30·0.6255 + 0.25·0.8389 + 0.20·1 + 0.15·0.433979 + 0.10·1) = 76.247185 | **76.2 → A** |
| confidence | 100 × (0.4·min(73/24, 1) + 0.3·0.5 + 0.2·0.3 + 0.1·1) | **71.0** |
| gate | 71.0 ≥ 70; A ≥ C; loss 0 ha (5-year proxy) < 2.066995 ha | **passes** |

With the mock encroachment news (severity 4, direction −1): T = 1 − 4/15 = 0.7333…, base_health = 73.580518… → **73.6, grade A**; confidence 71.0; the gate passes.

**The hero only just clears the confidence gate** (T26/T38 take note). At the default agreement of 0.5 it sits at 71.0, so any one of these fails the gate: Auditor agreement below 0.465 (0.465 gives exactly 69.95 → 70.0), fewer than 24 cloud-free observations (23 gives 69.3), or data 90 or more days old (66.0). Field evidence would add 14 points.

Each gate failure on its own (all asserted in `tests/test_scoring.py`):
- Hero with 10 cloud-free observations: coverage 10/24, confidence 47.666… → 47.7 → `confidence_below_70`.
- Hero with 2.1 ha of loss in the last 12 months (limit 2.066995 ha) → `forest_loss_last_12m_at_least_1pct_of_area`.
- A degraded non-wetland parcel (NDVI 0.2, natural fraction 0.05, 30 ha of loss over 5 years but none in the last 12 months, three severity-5 threats): V 0.375, N 0.05, L 0, W 1, T 0 → health 27.5, grade D → `grade_below_c`.

### 7.5 News Scout (Tavily + Nemotron Nano)
1. Build 2–3 queries from the nearest locality (reverse geocode via OpenStreetMap Nominatim, max 1 request/s with a custom User-Agent, cached per asset), and keywords: `"<locality> wetland factory permit"`, `"<locality> fire OR drought OR pollution"`, `"<locality> wetland restoration OR protected area OR conservation"`.
2. Tavily Search API `POST /search` with `topic="news"`, `time_range` derived from the lookback window, `max_results=5`, `include_raw_content="text"` and no generated answer.
3. Deduplicate by URL and send at most 8 top-scoring articles to Nemotron. The LLM binds classifications only by article index:
```json
{"article_index": 1, "relevant": true, "impact_type": "encroachment", "direction": -1, "severity": 4,
 "summary": "State approved an industrial park expansion bordering the wetland."}
```
4. **Prompt-injection guard:** wrap retrieved text in `<untrusted_content>` tags and instruct the model to treat it as data only; validate the output against a JSON schema; post-check that each index is in range and unique, URL/title/date come from the fetched article, dates are not in the future, and unsupported currency amounts are stripped from summaries.

T24 returns URL-bound events with stable URL-derived IDs for downstream citation. Full results cache for 24 h; empty non-degraded results cache for 1 h. Persistence into `events` and Nature Ledger `kind='event'` is left to the Orchestrator/Auditor integration so the append happens in the same transaction as the asset re-rate.

### 7.6 Field Evidence (MiniCPM-V perception + Nemotron judgement)
Code first checks each photo's EXIF GPS and date (inside the polygon, recent); MiniCPM-V then describes it; the Nemotron Ultra Auditor decides what it means for the rating. Input: photo(s) + asset context (audio is post-hackathon). Output: `{observations[], species_candidates[], damage_signs[], water_clarity, authenticity_concerns[]}`. The result creates an `events` row (`source='evidence'`) and sets `evidence=1` in confidence if there are no authenticity concerns.

### 7.7 Auditor (Nemotron 3 Ultra)
Input: metrics, valuation, base scores, events, evidence, and the previous report (if any). Output (JSON schema enforced; retry on invalid):
```json
{
  "auditor_adjustment": -2,
  "adjustment_reason": "Two reports of illegal dumping in the NE sector [event:9f1c…] [event:4ab2…] are not yet visible in the built-up land cover [metric:landcover.built].",
  "agreement": 0.7,
  "flags": [{"type": "data_gap", "detail": "Few cloud-free scenes in the rainy season.", "citation": "metric:cloud_free_obs"}],
  "greenwashing_risk": "low",
  "key_changes": ["Flooded vegetation is shrinking [metric:landcover.flooded_vegetation] [report:previous.health_change]", "New encroachment news [event:9f1c…]"],
  "recommendations": ["Install boundary markers along the NE industrial edge", "..."],
  "summary_md": "## Ecological Performance Report — Q3 2026\n...",
  "citations": ["event:9f1c…", "event:4ab2…", "metric:landcover.built", "metric:cloud_free_obs", "metric:landcover.flooded_vegetation", "report:previous.health_change"]
}
```
Rules in the prompt: cite a metric or event ID for every claim; never change numbers other than `auditor_adjustment`; `score:threat_pressure` already prices every relevant negative event by severity, so adjust only for cross-evidence disagreement, data gaps or validated field evidence, citing the metric or report fact involved; write the report for non-experts; ≤ 400 words.

**As built (T26, `backend/app/agents/auditor.py`, prompt in `agents/prompts/auditor.md`).** A pure agent module; T27 calls it.
- **Input bundle** (`build_auditor_input` → `AuditorInput`): deterministic facts, each with a citable ID and a display value with its unit. `metric:*` (area, each non-zero land-cover class, natural fraction, NDVI mean, NDVI trend with its Mann-Kendall p and significance, water change, 5-year and 12-month forest loss, biomass, SOC, mangrove fraction, cloud-free observations), `valuation:*` (low / mid / high, unit, carbon stock and sequestration, coastal, flags), `score:*` (the five components, negative severity sum, base health and grade, confidence before the audit with its terms, listing gate), `event:<id>` per news or field-evidence event (News Scout's URL-derived ID; relevance, impact type, direction, severity, date, and `validated` for evidence) and `report:previous.*` with deterministic health and value changes. The bundle must be built from the pre-audit score. The hero bundle is about 2,200 characters.
- **Untrusted text:** event titles and summaries are HTML-escaped, truncated and fenced in `<untrusted_content>`. Their numbers are **not** allowed in the output, so an article can't put a figure into the report; the model refers to the event by ID ("a reported clearing [event:…]", not "a 40-ha clearing"). The issuer-written asset name is escaped too and is left out of the number allowlist: prose may repeat the name, but not its digits as claims.
- **Thinking off for the JSON call** (`reasoning=False`, `max_tokens=1800`). T02 had Ultra 3/3 correct with `json_schema` and thinking off; in the T26 live smoke, thinking on used the whole 3,000-token cap and returned truncated JSON twice. `run_auditor(reasoning=True)` stays for the T47 evals.
- **Post-validation in code** (`check_audit`, after the Pydantic schema):
  - adjustment is an integer in [−10, +10] (`scoring.check_auditor_adjustment`) and a non-zero one has a reason citing at least one ID;
  - **per-sign justification** (`_justification_errors`): a **positive** adjustment cites a relevant direction +1 news event or field evidence with `validated=true`; a **negative** one cites a `metric:` or `report:previous.` fact carrying the disagreement, not only relevant negative events (already priced by T); a reason citing **only** `score:*`, `valuation:*` or the metrics in V, N, L and W (area, NDVI mean and trend, land cover, natural fraction, water change, 5-year loss) is always rejected; cited events must be relevant and must not point the other way; direction-0 events and unvalidated evidence justify nothing;
  - **agreement needs evidence** (`_agreement_errors`): with no relevant events or evidence it must be exactly 0.5; otherwise it stays within 0.5 ± 0.3, and any value other than 0.5 must cite (anywhere in the audit) a relevant news event or validated evidence;
  - `citations` is non-empty and every ID (in the list, inline in any text, and on every flag) resolves to the bundle; every key change and the summary cite inline;
  - flag types come from a fixed list (`AuditorFlagType`), each flag cites an ID, `medium`/`high` greenwashing needs a `greenwashing_claim_mismatch` flag and simulated data needs a `simulated_data` flag;
  - no HTML, Markdown links, images or URLs; size limits (summary ≤ 400 words, ≤ 5 key changes, ≤ 4 recommendations, ≤ 8 flags);
  - prose (summary, reason, key changes, recommendations, flag details) may only use numbers from the trusted bundle text (the T10 number guard, now shared in `agents/guards.py`; since T26 it also reads "40 %" and "40 percent" as percentages). The adjustment and adjusted health are **not** allowed: code appends the adjustment line (`adjustment_line`: adjustment, base → adjusted health, reason) to the accepted summary, so its sign and numbers are always right.
- **Retries and fallback:** Ultra (LLMClient retries and falls back a tier on transport or schema failure) → on a rule violation, one retry on the same tier with the errors fed back → one attempt a tier lower → a deterministic **no-op audit**: adjustment 0, agreement 0.5 (`DEFAULT_AGREEMENT`; `apply_audit` passes `None`, so the score records `agreement_source = "default"`), one `auditor_unavailable` flag (reserved; the model can't emit it) and a template summary built only from bundle facts. Budget, model and call-log failures also end in the no-op, so a rating never blocks. Feedback only echoes model-written values that are well-formed citations or numbers; anything else is described as "an invalid citation" or "an invalid flag type".
- **Call log:** every attempt is logged in `llm_calls` with agent `auditor` and the asset ID. A schema-valid answer that `check_audit` refuses is re-marked `status = 'rejected'` (`LLMClient.mark`, via the call-log handle now on `LLMResult.call_id`), so spend shows which answers were used.
- **Output:** `AuditResult` with the validated `AuditorOutput` (summary including the code-written adjustment line), the resolved citations in bundle order, `source` (`ultra` / `super` / `nano` / `fallback`), `model`, `degraded` (anything but Ultra), `fallback`, `rounds`, the rejection messages (for the Agent Trace), `greenwashing_risk` (**`None` = not assessed**, for the no-op; T27 shows that instead of the schema's filler `low`) and any reasoning text. `AuditorOutput` is unchanged.
- **Applying it:** `apply_audit(ScoreInputs, AuditResult)` re-runs `scoring.score` with the adjustment and agreement. Components, base health and valuation are untouched; health moves by exactly the adjustment (clamped to [0, 100]) and confidence only through agreement.
- **Live smoke (hero wetland, 2026-10-07, mock encroachment news, after the review rules):** Ultra answered in 2 rounds. The first was rejected: a negative adjustment citing only the counted event, plus "40" from the news text. Accepted answer: adjustment −2 citing the event and `metric:landcover.built`, agreement 0.3 citing the event, flags `encroachment_pressure` and `water_decline`, 9 citations. Health 73.6 → 71.6 (A), but confidence 71.0 → **65.0, so the hero fails the listing gate** (see §7.4: agreement below 0.465 fails it).
  - **Decision (agreement vs the gate):** keep the ±0.3 cap; agreement must cite relevant news or validated evidence. That's acceptable because:
    - the listing gate applies only when an asset is listed (T38), so an audited re-rate never delists a listed asset;
    - the curated sites are listed from the deterministic report v1 (T19);
    - a new listing that the Auditor pushes below 70 goes to `needs_evidence`, and validated field photos add 14 confidence points (T40/T58). That's the designed path.
  - **Known limit:** prose may still quote a number equal to another trusted fact (e.g. "-2"); the code-written adjustment line is the authoritative one. 2,661 + 3,377 prompt and 671 + 636 output tokens, $0.0100, 2.9 s + 2.0 s. (First T26 smoke, before the review: also −2 in 2 rounds, agreement 0.5, $0.0095.)

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
- **Order size cap:** slippage ≤ 10% per order, i.e. `qty ≤ 0.10 × liquidity / k` (10,000 of 1M shares). This keeps every sell fill and post-trade price above zero; a $10,000 balance never reaches it.
- **Market-maker inventory:** sells go to the market maker; buys after the float sells out come from that inventory and are rejected if it's empty. Shares are conserved as `total_shares = primary_shares_remaining + market_maker_shares + Σ holdings` (the community's retained stake is a holding). The inventory isn't a column; the trade API (T17) derives it from that identity.
- Prices are rounded to 4 decimals with a floor of 0.0001; cash to cents.

**Re-rating / ticks:** `price ← price + α × (FV_new − price)`, with α = 0.35 on re-rate and 0.05 per tick, plus small noise σ = 0.3% (clamped to ±3σ).

Implemented as pure functions in `backend/app/market/engine.py` (`ipo`, `quote`, `execute`, `reanchor`); tests in `backend/tests/test_market.py`.

**As built (T17), `POST /orders` and `GET /portfolio` (`backend/app/routers/market.py`):**
- **Scope:** both routes act in the caller's world (`CurrentWorld`) as its demo investor persona. They move onto the signed-in principal in T57 (ADR-0005).
- **Locking:**
  - Each order first takes a `KEY SHARE` lock on its world row, so it waits behind a "Reset my demo" instead of deadlocking with it. Orders don't block each other.
  - Then it locks the asset row and the trader's user row (the same order as the revenue payout).   - So concurrent orders and payouts on one asset are serialised and can't lose updates. There are regression tests for concurrent buys and for an order racing a reset.
- **Order rows:** a buy that crosses the end of the primary float is stored as two rows, the primary part (`is_primary`, which paid the community) and the secondary part. The response's `is_primary` is true if any shares came from the float.
- **What a fill writes, in one transaction:** a new `prices` row with `reason='order'`, and a `price_tick` live event (T29).
- **Errors:** 404 for an asset outside the world, 409 when the asset isn't listed or has no price, 400 for engine rejections (cash, shares, size).
- **Seed IPO prices:** `make seed` gives every listed curated site an `ipo` price from its deterministic rating, `demo_ipo_price` = T14 valuation + T15 score → `ipo()`. Today that's wetland 21.4723, mangrove 285.1519 and forest 19.5456 per share. T19 stores the matching report; T59 prices owner-launched IPOs. **On an existing database, run `make seed` once after upgrading** so the template gets its prices; visitor worlds pick them up on their next reset or creation.

A tick is triggered by `POST /admin/simulate/quarter`, by a scheduled job, or by the SSE loop while the demo is running (no always-on process is required).

**Quarterly revenue split (simulated):**
- `revenue_q = value_mid × capture_rate / 4`, with capture_rate = 2%.
- 50% goes to `community_wallet`.
- 50% is paid as dividends pro-rata to holders (including the community's retained stake).
- **As built (T41):** `backend/app/market/revenue.py` uses Decimal cents and a
  largest-remainder allocation so payout cents sum exactly to revenue. Dividend ties are
  broken by stable holder key; primary float / market-maker shares are unheld and receive
  no dividends. The community's retained stake must be recorded as a positive holding for
  `Asset.community_user_id`; that user's cash balance receives the retained-stake dividend,
  while the 50% community fund is credited to `Asset.community_wallet`. The pure calculator
  can report a no-holders case, but `pay_quarter` refuses to apply one to the DB. `pay_quarter`
  is a thin transaction-scoped helper for T38/T44 and is not wired to `routers/market.py` while
  T17 rewrites that router.

Invariants (unit-tested): cash is never negative; shares are conserved; the price stays > 0; every price change has a `reason`.

## 9. Background jobs
| Job | Schedule | Entrypoint | Work |
|---|---|---|---|
| `rerate_all` | Quarterly (demo: on demand) | `python -m jobs.rerate_all --version sim-N` | For each listed asset: earth_obs → valuation → auditor (using news events already stored by `news_sweep`) → report v+1 → price re-anchor → alerts |
| `news_sweep` | Daily | `python -m jobs.news_sweep` | News Scout for all assets; severity ≥ 4 → alert + optional re-rate |

Both reuse the backend code with a different entrypoint:
- **Default (free):** `rerate_all` runs in-process when the Time Machine calls `/admin/simulate/quarter` (`LOCAL_JOBS=true`); `news_sweep` runs daily from a GitHub Actions cron that calls a protected backend endpoint.
- **Optional upgrade:** if Nebius AI Cloud credits arrive, run both as Nebius Serverless Jobs from the backend image (`backend/Dockerfile`) **(verify)**.

## 10. Copilot (RAG)
- **Indexing:** on each new report, chunk the `summary_md`, key metrics and events (~500 tokens each), embed them and upsert into `doc_chunks`.
- **Query:** retrieve the top 6 chunks (filtered by asset if given), then send them to Nemotron Nano with an instruction to answer only from the context and cite `[R{version}]` / `[E{id}]`.
- The Copilot may also call `get_price_history` and `compare_assets` as tools.

## 11. Frontend pages & key components
| Page | Components | Notes |
|---|---|---|
| **Two apps in one Next.js app** (ADR-0005) | Route groups `(exchange)` at `/` and `(steward)` at `/steward`, each with its own shell and nav; AppSwitcher for community members; DemoBar in demo sessions | Shared design system, generated client and session |
| Sign in `/login`, `/register` | AuthForm, AccountMenu | Protected routes redirect here and back |
| Judge `/judge` | Three one-click demo entries, "Create a real account" | Starts `POST /demo/start` |
| Exchange · Marketplace `/` | AssetCard grid, filters, SandboxBanner | Sort by grade / change / value |
| Steward · Home `/steward` | Listings with status and next action, WalletCard, holders, payouts, alerts, stewardship actions | Owner and stewards |
| Steward · Community `/steward/community` | Community form, members (owner) | A0 |
| Steward · List `/steward/list` | MapDraw, AssetForm, RatingProgress (SSE) | Area and validation shown live |
| Steward · IPO `/steward/assets/[id]/ipo` | IpoPreview (formula step by step), confirm | Owner only |
| Exchange · Asset `/asset/[id]` | Map + land-cover overlay, ReportView (grade badge, value range, breakdown chart, NDVI chart, flags, recommendations), PriceChart with event markers, TradePanel, AlertsFeed, CopilotChat, AgentTrace drawer | The hero page |
| Exchange · Portfolio `/portfolio` | Holdings table, P&L, ImpactSummary | |
| Admin `/admin` | Time Machine: "Next quarter", event presets, reset demo, suspend/resume | Admins only (own world) |
| Tour (all pages, optional) | DemoBar persona switcher, Driver.js tour with spotlight hints, "Do it for me", Live badges, Under-the-hood drawer | See demo-plan §3; each screen exposes stable anchors for tour steps |

## 12. Configuration
```
NEBIUS_API_KEY=            TOKEN_FACTORY_BASE_URL=
MODEL_ORCHESTRATOR=        MODEL_AUDITOR=        MODEL_FAST=
MODEL_MULTIMODAL=          MODEL_EMBED=
TAVILY_API_KEY=
NOMINATIM_USER_AGENT=      # identifying app User-Agent for OSM Nominatim
EE_SERVICE_ACCOUNT_JSON=   # or PC_SUBSCRIPTION_KEY
DATABASE_URL=              S3_ENDPOINT=  S3_BUCKET=  S3_KEY=  S3_SECRET=
USE_MOCKS=false            LOCAL_JOBS=true            DEMO_MODE=true
LLM_BUDGET_USD=20          # hard cap per deployment key (§21)
VERIFICATION_MODE=review   # review (a person decides) | demo (sample docs + auto-reviewer, always disclosed); hackathon deploy + E2E use demo (ADR-0006)
VERIFICATION_AI_LIVE=false # T71 AI check on real documents in the live world, only after Token Factory data terms are confirmed
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
- **Accounts (ADR-0005):** argon2id via `pwdlib` with a dummy-hash verify for unknown emails; server-side sessions (hashed token, `HttpOnly`/`Secure`/`SameSite=Lax`, 7 d idle / 30 d absolute, rotated on login and persona switch); the §6.1 CSRF rule; login 10 per 15 min and register 5 per hour in independent per-IP and per-account buckets, counted in Postgres, client IP only through `TRUSTED_PROXY_HOPS`; generic login errors.
- **Admins:** live-world admins are created only by the operator CLI (`python -m app.cli create-admin`, password via `getpass`), never through the API or by email match. **Accepted risk:** without email verification, registration reveals whether an email exists; no permission depends on email.
- **Authorization on every request** (§6.1), including object-level checks and the 404-across-worlds rule. Every PR touching auth, cookies, sessions or authorization gets a `security-and-hardening` review.
- **Listing verification (ADR-0006):** uploads are allow-listed (PDF/JPEG/PNG, ≤ 5 MB, magic bytes, pixel and PDF page limits; encrypted/malformed PDFs rejected), parsed in a worker with a timeout, previewed as re-encoded PNGs, stored privately under generated names and served only to members and same-world admins; verification runs are fingerprinted, so any change to the listing resets them, and revoking suspends trading; the AI suggestion (T71) is attacker-controlled input with no tools, shown as an untrusted heuristic; a human reviewer decides; the public sees check results and what was not checked, never documents or raw hashes.
- **Personal data:** accounts hold email, display name and password hash. Listing verification adds **sensitive** documents and extracted fields (holder names, parcel IDs), kept privately and deleted 30 days after the listing is deleted; T71 sends document previews to Nebius Token Factory only in sandboxes (seeded demo documents) until its retention and training terms are confirmed (`VERIFICATION_AI_LIVE=false` in the live world). Nothing personal goes into logs or traces (`llm_calls` keeps metadata only). The public ledger holds no account identifiers, names or raw document hashes (payout details in `payout_lines`, T67; documents as randomized commitments). Sessions and `auth_attempts` are pruned; demo worlds are pruned after 7 days.
- Treat all retrieved web content and uploaded media as untrusted; enforce schema-validated outputs.
- Show uncertainty (ranges, confidence) everywhere a number appears.
- Use only licensed data: Earth Engine terms, Tavily terms, cited valuation sources, dataset attributions; no raw ESVD data in the repo.

## 16. Team split (4 people)
| Owner | Scope |
|---|---|
| PD — Product designer + frontend | UX flows, design system, all screens, judge tour, UI polish, demo video |
| D1 — Platform & market | Repo/CI, schema, API contract, market engine, ledger, sandbox, SSE, jobs, deploy; ~50% frontend wiring from week 3 |
| D2 — Geo & rating data | Earth Engine pipeline, demo sites, valuation, scoring, confidence, map overlays, polygon validation, field evidence |
| D3 — AI agents | Token Factory client, News Scout, Auditor, Orchestrator, Agent Trace, Copilot, evals, README; frontend skeleton in week 1 |

The week-by-week plan and tasks are in [tasks/plan.md](../../tasks/plan.md) and [tasks/todo.md](../../tasks/todo.md).

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
- **As built (T30):** `backend/app/ledger.py` keeps the formula above, with these additions:
  - `canonical` rejects NaN.
  - `append` locks the asset row (`SELECT … FOR UPDATE`) so concurrent appends can't race for a `seq`, and it stores the payload exactly as hashed.
  - `verify` also checks that `seq` runs 0, 1, 2… with no gaps, and returns `head: null` when the chain is broken.
- **Tamper demo:** `POST /admin/tamper-demo {asset_id, seq?}` (DEMO_MODE only; 404 otherwise).
  - It copies the chain and multiplies the first numeric payload field of one entry (default: the latest) by 10. If the payload has no number, it adds `"tampered": true`.
  - It returns the field, the before and after values, and the failing verification. Nothing is written; the DB trigger would reject an UPDATE anyway.
  - World scoping (`nx_world`) is added to these routes with T31.
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
- **Health endpoints:** `/healthz` and `/readyz` for the backend host and the keep-alive pings.

## 20. Definition of done (hackathon)
- [ ] Public URL runs the full demo script without manual DB edits
- [ ] At least 3 Nemotron models (Super, Ultra, Nano) are called at runtime via Token Factory, visible in the Agent Trace drawer with the non-NVIDIA helpers (MiniCPM-V, Qwen3 embeddings) labelled
- [ ] Tavily is called at runtime by the News Scout
- [ ] Backend deployed on the host chosen in T20 (§21); re-rating runs as a job (in-process / GitHub Actions, or Nebius Serverless Jobs)
- [ ] Judge tour and per-visitor sandbox work for concurrent visitors
- [ ] README covers setup, the architecture image, the model table, and "How we used Nemotron & Token Factory"
- [ ] Nature Ledger verifies for every demo asset; tamper demo shows ❌
- [ ] `make eval` results + routing table committed and linked from README
- [ ] CI green on `main`; `docker compose up` works from a clean clone
- [ ] MIT license visible; demo video < 3 min on YouTube

## 21. Cost plan: paid items and free alternatives
Policy: use the planned stack, and switch to the free alternative wherever a paid item isn't covered by hackathon credits or team-approved credits (hosting, see below). Commercial licensing is out of scope for the hackathon (local development and small demo hosting only).

**Mandatory (hackathon rule), running on credits.** The app must call Token Factory at runtime **or** run on Nebius AI Cloud, and use at least one NVIDIA open model:
| Item | Covered by | Notes |
|---|---|---|
| NVIDIA Nemotron (Ultra, Super, Nano) via **Nebius Token Factory** | $25 hackathon promo (code `NEBIUS-DEVPOST-GLOBAL26`) + $25 Nebius Builders Program, per account | Credits are per account and can't be pooled. The deployed app uses one key; each member develops with their own. Confirm per-member vs per-team with the organisers. |

**Development is local-only:** Docker Compose (Postgres + pgvector) on each laptop, with no cloud accounts needed beyond the AI and data APIs.

**Hosting for the demo is decided in T20**, in this order:
| Rank | Backend + DB | When | Notes |
|---|---|---|---|
| 1 | **Nebius Serverless Endpoint** (+ Serverless Jobs) | If Nebius AI Cloud credits are unlocked (e.g. a Builders & Brews event) | Encouraged by the track; Postgres on Supabase or Azure |
| 2 | **Azure Container Apps** (1 always-on replica, ~0.5 vCPU / 1 GB) + **Azure Database for PostgreSQL Flexible** (B1ms, `vector` extension allow-listed) + Blob Storage | If the team approves using personal Azure credits **and** (a) the credits last until **Dec 15, 2026** and (b) their terms allow a public demo (some credits are dev/test only) | ~$50/month estimate (≈ $100 for Oct 23 – Dec 15); no sleeping during judging |
| 3 | **Hugging Face Spaces (Docker) or Render** + **Supabase** free tiers | Default if neither above applies | Free; sleeps when idle, so keep-alive pings + a "Waking up" state |

All options: frontend on **Vercel Hobby**; **AI only via Token Factory** (never Azure OpenAI); no local models, so the backend is a small CPU-only container (ADR-0003).

**Paid items with free alternatives:**
| Planned (paid) | Free alternative | Trade-off |
|---|---|---|
| Nebius Serverless Endpoint (backend API) | Local `docker compose`; demo on Hugging Face Spaces (Docker) or Render free tier | Cold starts on free tiers; loses a bonus Nebius-usage point (still meets the rule via Token Factory) |
| Nebius Serverless Jobs (`rerate_all`, `news_sweep`) | In-process run (`LOCAL_JOBS=true`) triggered by the Time Machine; GitHub Actions `schedule` for the daily sweep | Same code entrypoints; only the trigger changes |
| Nebius Managed PostgreSQL | Supabase free tier (Postgres + pgvector) or local Postgres in Docker | Supabase free projects pause after inactivity |
| Nebius Object Storage | Supabase Storage free tier or local disk / MinIO in Docker | Small storage limits, fine for the demo |
| Local embedding model (e.g. `bge-m3`, ~2.3 GB) | `Qwen3-Embedding-8B` on Token Factory at ~$0.01 per 1M tokens (ADR-0003) | None; avoids model weights on free hosts |
| Tavily beyond the free tier | Free tier (~1,000 searches/month) + $25 Builders credit; cache results for 24 h | Keep queries to 2–3 per asset |
| Mapbox (if used) | Leaflet + OpenStreetMap / Esri basemap tiles | Respect tile usage policies |
| Frontend on a Nebius container | Vercel Hobby (free) | None for the demo |
| Nebius AI Cloud compute | Only if credits are unlocked at a Builders & Brews event | Optional upgrade path |
| Satellite precompute (`scripts/precompute_sites.py`) | Laptop (Earth Engine computes server-side) | None; results are cached in the repo |

**Already free:**
- Sentinel-2, Dynamic World, JRC Surface Water, Hansen Forest Change and ESA biomass data.
- Google Earth Engine (non-commercial registration); Microsoft Planetary Computer only as a fallback for other datasets.
- ESVD (registration and citation).
- OpenStreetMap Nominatim reverse geocoding (usage policy: ≤ 1 request/s, cache results) and Natural Earth coastline data (public domain).
- All frameworks and libraries (Next.js, React, Tailwind, shadcn/ui, Leaflet, Recharts, FastAPI, SQLModel, Pydantic, openai SDK, tavily-python), plus NeMo Agent Toolkit and OpenTimestamps.
- GitHub (public repo), GitHub Actions and YouTube.

**Judging-period availability (rule: testable free of charge until judging ends, Dec 15, 2026):**
- If hosted on free tiers (§21 rank 3): they sleep or pause (Supabase after ~1 week idle, Hugging Face Spaces after ~48 h, Render after ~15 min) **(verify)**. Add a GitHub Actions ping to `/healthz` every few hours and re-check everything before Dec 1.
- Keep part of `LLM_BUDGET_USD` in reserve for judges' live runs; serve cached ratings for the 3 demo sites so browsing costs nothing.

**Credit guardrails:**
- Nano for development and tests; Ultra only in the Auditor (~1 call per rating).
- Cache LLM outputs by input hash; precompute the 3 demo sites.
- Run `make eval` manually or nightly, not on every push.
- Hard budget cap: the LLM wrapper sums tokens in `llm_calls` and refuses calls past `LLM_BUDGET_USD`.
- Check per-model prices on the Token Factory pricing page before choosing defaults **(verify)**.
