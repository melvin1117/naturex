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
| Maps | Leaflet (BSD-2) in client components + leaflet-draw (MIT) (or MapLibre + terra-draw) | Esri/OSM basemap; land-cover image overlay. Not react-leaflet (Hippocratic-2.1 licence; see ADR-0001) |
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
  unique (world_id, id),               -- target of composite foreign keys
  check (kind = 'person' or (email is null and password_hash is null))  -- personas and treasuries never sign in
);
create unique index users_world_email on users (world_id, lower(email)) where email is not null;
create unique index uq_users_world_persona_key on users (world_id, persona_key)
  where persona_key is not null;      -- T56: a sandbox reset keeps persona IDs by key

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
create table communities (             -- T56 (migration 0009)
  id uuid primary key default gen_random_uuid(), world_id uuid not null references worlds(id),
  name text not null, country text, description text,
  treasury_user_id uuid not null unique,  -- kind = 'treasury' (trigger); one treasury per community
  created_at timestamptz default now(),
  unique (world_id, id),
  unique (world_id, id, treasury_user_id),  -- target of assets' community+treasury foreign key
  foreign key (world_id, treasury_user_id) references users (world_id, id)
);
create table community_members (       -- owner-only for the Must; stewards are a Should
  world_id uuid not null, community_id uuid not null, user_id uuid not null,
  role text not null check (role in ('owner','steward')),
  created_at timestamptz default now(),
  primary key (community_id, user_id),
  foreign key (world_id, community_id) references communities (world_id, id),
  foreign key (world_id, user_id) references users (world_id, id)
);
create index on community_members (world_id, user_id);  -- "my communities"; insider-trading rule (T68)
-- Treasury triggers (T56): a `treasury` user can't be in orders, sessions or community_members
-- (reject_treasury_actor), communities.treasury_user_id must name a treasury
-- (require_treasury_user), and users.kind can't change around either (guard_treasury_kind_change).
create table assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  community_id uuid,                                  -- ADR-0005: the community that manages the listing
  community_user_id uuid,                             -- the community's treasury (kind = 'treasury'): retained stake, seeded at IPO, + its dividends (T41)
  verification_revoked_at timestamptz,                -- ADR-0006: set on revoke; while set, demo_auto can't approve; cleared only by a human admin approval
  -- unique (world_id, id) (added by T67 for payout_lines). As built (T56):
  --   foreign key (world_id, community_id) → communities (world_id, id);
  --   foreign key (world_id, community_user_id) → users (world_id, id);
  --   foreign key (world_id, community_id, community_user_id) → communities (world_id, id, treasury_user_id),
  --     so when both are set the treasury is the asset's own community's;
  --   indexes on (world_id, community_id) and (world_id, community_user_id)
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
  user_id uuid, shares bigint, amount numeric(14,2),   -- all null once erased (tombstone)
  nonce bytea check (octet_length(nonce) = 32),        -- private, random per line; null once erased
  leaf_hash char(64) not null,                         -- sha256(nonce || canonical(line)); kept on erasure
  foreign key (world_id, asset_id) references assets (world_id, id),
  foreign key (world_id, user_id) references users (world_id, id),
  unique (world_id, asset_id, quarter_label, user_id),  -- one line per holder per payout
  check (num_nulls(user_id, shares, amount, nonce) in (0, 4)),  -- erased all together
  check (shares > 0), check (amount > 0)
);
create index on payout_lines (world_id, user_id);       -- erasure (K5)
create unique index uq_ledger_payout_quarter on ledger_entries (asset_id, (payload ->> 'quarter_label'))
  where kind = 'payout';                                -- one payout per asset quarter (T67)

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
  world_id uuid not null references worlds(id), user_id uuid not null, asset_id uuid not null,
  shares bigint not null default 0, avg_cost numeric(12,4),
  primary key (world_id, user_id, asset_id),
  -- #144 (migration 0010): composite keys, so a holding can't name another world's user or asset
  foreign key (world_id, user_id) references users (world_id, id),
  foreign key (world_id, asset_id) references assets (world_id, id)
);
create index on holdings (world_id, asset_id);  -- the asset key; holders of an asset (payouts)

create table orders (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references worlds(id), user_id uuid not null, asset_id uuid not null,
  side text check (side in ('buy','sell')), qty bigint, fill_price numeric(12,4),
  is_primary boolean default false, created_at timestamptz default now(),
  foreign key (world_id, user_id) references users (world_id, id),   -- #144 (migration 0010)
  foreign key (world_id, asset_id) references assets (world_id, id)
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
| `POST /assets/{id}/rate` · `GET /runs/{run_id}` | Re-rate an asset: `202` + `run_id`; the run's status and steps (T27) |
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

`ReportOut.summary_source` is additive metadata for the generated client: `"auditor"` means
`summary_md` is the stored summary a T27 Auditor model wrote (with inline `[ID]` citations, as
`agents/auditor.py` checks), returned as stored with no LLM call; `"live"` means it was written
at read time by a live Nemotron Nano call from deterministic report facts, and `"fallback"`
means it came from a deterministic template: T10's (mock mode, missing keys, budget
exhaustion, invalid model output, or any simulated report) or the Auditor's no-LLM template
(`auditor_json["audit"]["fallback"]`), which is returned as stored. T10's read-time summary
runs only for reports without a cited Auditor summary, and for every simulated report, so the
code-written "simulated scenario" warning is never lost (#145). The summary prose must not
contain numbers outside the input facts.

Every route is scoped to the caller's world, which comes from the session: anonymous requests read the live world, password sessions use the live world, and demo sessions use their sandbox (ADR-0005). Judges never affect each other or the live world. *(T31 below describes the `nx_world` cookie, which T55 retires.)*

### 6.1 Authorization (ADR-0005)
- `app/authz.py`: pure `authorize(principal, action, resource) -> Allow | Deny(reason)`, tested over every role × action; routes use a `require(action)` dependency.
- **Every route, reads included,** loads resources by `(world_id, id)` before authorizing; a route-inventory test fails if any route has no authorization dependency, and a cross-world test returns 404 for every object endpoint.
- **SSE and polling** take the principal and world from the session, recheck the session on every poll and heartbeat, and close after logout, expiry or revocation.
- **Roles:** any signed-in user can trade; community **owner** / **steward** via `community_members`; **admin** via `users.is_admin`, scoped to its world. The full matrix is in ADR-0005 §3.
- **Errors:** 401 `auth_required`; 403 with a reason (`owner_only`, `insider_trading_blocked`, …); 404 for anything in another world.
- **Rules:** orders always use the principal's user; community members can't trade their own asset, and a holder of its shares can't be added as a member (409 `member_has_holdings`); admins and treasury accounts never trade; the ledger tamper demo runs only in sandbox worlds.
- **CSRF:** `SameSite=Lax` cookies plus an exact `Origin` (else `Referer`) allowlist (`ALLOWED_ORIGINS`) on every POST, PUT, PATCH and DELETE, uploads included; both missing, malformed or `null` → rejected; JSON routes require a JSON media type.

**As built (T31), before ADR-0005.** Three things below have changed or will: T55 replaces the `nx_world` cookie with the session; T56 made reset keep persona user IDs (mapped by `persona_key`) instead of re-copying them with fresh IDs, so a session survives, and made pruning delete a world's sessions first (see "As built (T56)"). The rest stays:
- **Only `GET /world` creates a world.** It reads the `nx_world` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` unless `ENVIRONMENT` is explicitly development/test (fail closed since T54), 30 days, `Cache-Control: no-store`); a missing, malformed or unknown cookie, or one naming the **template** world, gets a fresh world.
- New worlds are capped at `SANDBOX_MAX_NEW_WORLDS_PER_HOUR` (default 300) → 503 with `Retry-After`.
- World-scoped routes use `CurrentWorld` (`app/deps.py`) and return **401 `world_required`** without a valid cookie; they never create worlds. The frontend calls `GET /world` first (T32). Today the ledger, world, orders/portfolio, assets and reports routes are scoped (T19 moved assets and reports off mocks); the other routers adopt `CurrentWorld` as they move off mocks.
- A new world is a copy of the template (`app/sandbox.py`, including the community's retained holdings) with fresh IDs and every reference remapped. Ledger chains still verify, because hashes don't include IDs.
- `POST /world/reset` deletes the world's rows (the ledger-delete opt-in is switched on only around those deletes) and re-copies the template, keeping the same ID and cookie. `llm_calls` rows are kept (detached) so the spend cap still counts them.
- Stale worlds (7 days unseen) are pruned at most every 10 minutes, with locked rows skipped; a failed prune never fails the request. The template is never served, reset or pruned.
- The cookie is first-party only because the browser calls the frontend's `/api/*` rewrite (next.config.ts → `BACKEND_URL`), not the backend host directly (T20).

**As built (T54).** Accounts and sessions; route authorization comes with T57, and CSRF, rate limits and pruning are T66 (below).
- **Routes** (`app/routers/auth.py`): `POST /auth/register` (201, creates a `kind = person` user in the live world with 10 000 play-money cash and signs in), `POST /auth/login`, `POST /auth/logout` (204, idempotent), `GET /me` (`id`, `name`, `email`, `kind`, `is_admin`, `world_id`; never the hash). Auth responses send `Cache-Control: no-store`.
- **Passwords:** argon2id via `pwdlib` (`PasswordHash.recommended()`, hashes upgraded on login if parameters change); 10–128 characters; display names 1–80 printable characters; emails stripped and lower-cased (≤ 254). An unknown email runs a verify against a dummy argon2id hash. The password hash is computed before the insert, so a duplicate email costs the same as a new one.
- **Errors:** every login failure is 401 `"Email or password is incorrect"`; a taken email (any case) is 409 `"This email can't be used to create an account"` (accepted enumeration risk, ADR-0005 §1); `GET /me` without a valid session is 401 `auth_required`. 422 errors on `/auth/*` never echo submitted values.
- **Sessions** (`sessions` table, migration `0006`): `secrets.token_urlsafe(32)` in the `nx_session` cookie (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 30 days; `Secure` unless `ENVIRONMENT` is *explicitly* development or test, so an unset variable fails closed, and the API logs a startup warning whenever cookies aren't `Secure`; **deployments must set `ENVIRONMENT=production`**); only its SHA-256 is stored, with `world_id`, `user_id` (composite FK to `users (world_id, id)`) and `kind` (`password`; `demo` is T55). 30 days absolute (`expires_at`), 7 days idle (`last_seen_at`, bumped at most every 5 minutes); an expired row is deleted when presented, and expired rows are pruned with stale worlds. The expiry delete and the `last_seen_at` bump are core statements by ID, so a session revoked mid-request is a 401, never a 500.
- **Failure hygiene:** emails with control or non-printable characters (NUL included) are 422 on register and login. The engine runs with `hide_parameters=True`, so no DB error or log carries a password hash or email, and any unexpected DB error on `/auth/*` or `/me` is a bare 500 `internal_error` that logs only the exception type.
- **Rotation:** login and register always issue a new token and delete the session whose cookie the browser presented, so a fixated or old token dies; sessions on other devices stay valid until their own logout or expiry.
- **Principal:** `OptionalPrincipal` / `CurrentPrincipal` (`app/deps.py`) resolve the cookie to `auth.Principal(user_id, world_id, session_id, session_kind, user_kind, is_admin)`; `CurrentPrincipal` returns 401 `auth_required`. T57 and T61 authorize against it. `CurrentWorld` (`nx_world`) is unchanged until T55.
- **Schema:** `users.kind` (`person | persona | treasury`, existing users backfilled to `persona`), `email`, `password_hash`, `is_admin`; `users.role` stays NOT NULL as a label only (registered people get `investor`, CLI admins `admin`; authorization uses `kind`, `is_admin` and, later, memberships); `unique (world_id, id)`; `users_world_email` partial unique index on `(world_id, lower(email))`; a CHECK that only `person` rows may hold an email or password hash.
- **The live world:** fixed ID `44444444-4444-4444-4444-444444444444`, label `live`, created by `make seed` (and on first register or login) with `sandbox.ensure_live_world`, idempotently. It copies the template's 3 curated sites (with reports, prices, ledger and the retained stakes) and, since T56, their communities: each one's treasury (holding the stake) and its owner persona, Rosa (no password, so nobody can sign in as her). The live world is never pruned, reset, counted against the world cap or served from an `nx_world` cookie, and `GET /world` never lists password accounts.
- **Admins:** `make create-admin EMAIL=… NAME=…` (`python -m app.cli create-admin`) creates a new live-world `person` with `is_admin = true`, reading the password twice with `getpass`; it refuses an email that already exists rather than promoting that account. Nothing logs an email, password or token.

**As built (T66).** CSRF, rate limits and pruning (ADR-0005 section 1); new settings `ALLOWED_ORIGINS`, `TRUSTED_PROXY_HOPS` and `AUTH_RATE_LIMIT_SECRET`.
- **CSRF** (`app/middleware.py`, pure ASGI): every method except GET, HEAD, OPTIONS and TRACE needs an `Origin` whose scheme, host and port (default ports filled in) are exactly in `ALLOWED_ORIGINS`, else a `Referer` whose origin is. When `Origin` is present it alone decides, so a bad one is not rescued by a good `Referer`. `null`, empty, malformed (userinfo, a path on an `Origin`, whitespace, a bad port), duplicated and absent headers are 403 `csrf_origin`. A request body must be `application/json` (or `application/*+json`), or `multipart/form-data` for uploads, else 415 `unsupported_media_type`; a request with no body is not checked. The media rule is global, not per route: multipart passes the middleware everywhere, and a JSON route then rejects it by validation (422). The check runs before routing. A server-side call (for example Next.js server code) that makes a state-changing request must send an allowed `Origin`. The browser calls the Next.js `/api/*` rewrite, so the frontend's own origin is the one to list.
- **Rate limits** (`auth_attempts`, migration `0007`; `auth.consume_attempt`): login 10 per 15 minutes and register 5 per hour, each in two independent buckets, per IP and per account. Rows hold only `HMAC-SHA256(AUTH_RATE_LIMIT_SECRET, bucket|subject)`, so neither an IP nor an email can be read back. The account subject is the normalised email whether or not an account exists, so a 429 never says which emails are registered. Counting runs under a per-key, transaction-scoped advisory lock taken in sorted order (no deadlock between overlapping buckets), and an attempt is stored only when every bucket allows it, so a refused attempt neither charges the other bucket nor extends its own lockout. A lock is waited for at most 2 seconds; then the request is a 503 `auth_busy` with `Retry-After: 1`, so requests queued on one key can't use up the connection pool. Over the limit is 429 `too_many_attempts` with `Retry-After` (seconds) and `Cache-Control: no-store`, checked before any password work. The clock is read only once the locks are held, so a waiter's time never predates attempts committed while it waited, and `Retry-After` is the seconds until the oldest counted attempt leaves the window, rounded up and clamped to `[1, window]` (`auth.retry_after_seconds`; #143).
- **Client IP:** `TRUSTED_PROXY_HOPS` is the number of trusted reverse proxies that each append to `X-Forwarded-For`; 0 ignores the header. Count only proxies that really append, such as a platform load balancer or CDN. **The Next.js `/api/*` rewrite does not** (checked in Next.js 15.5: `proxyRequest` builds its http-proxy without `xfwd`, and http-proxy only sets `X-Forwarded-For` with `xfwd`; it copies the incoming header through unchanged), so it counts as 0. Without a load balancer in front, the API sees the Next.js server as every client: at 0 all visitors share one bucket, and at 1 the API would trust a header the client chose and the limit could be bypassed. A deployed API logs a warning while it is 0; how the real client address reaches the API is a deployment decision (T20). The client is the entry that many places from the right, so entries the client wrote are ignored; a chain that is too short, or not an address, falls back to the socket peer. Entries may carry a port, and IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) count as IPv4. IPv6 clients are bucketed by /64. uvicorn rewrites the peer address from proxy headers on its own (`--proxy-headers`, trusted for 127.0.0.1 and `FORWARDED_ALLOW_IPS`), so run it with `--no-proxy-headers` and leave the client address to `TRUSTED_PROXY_HOPS`.
- **Pruning:** `auth.prune_auth_data` deletes expired sessions and `auth_attempts` rows older than 24 hours. Auth requests run it at most every 10 minutes per process and never fail because of it. It is two unbounded deletes inside a request; if a many-IP attack makes the table large, move it to a scheduled job.
- **Startup:** the API refuses to start without `AUTH_RATE_LIMIT_SECRET` or without an explicit `ALLOWED_ORIGINS` unless `ENVIRONMENT` is explicitly development or test (a fixed dev key and `http://localhost:3000` are used there), and refuses a bad `ALLOWED_ORIGINS`. The check runs in the app lifespan, so tools that only import the app (the OpenAPI export) need no secrets.
- **Accepted risks:** (1) registration enumeration (no email verification): a duplicate registration is always 409 with the same generic body, in any letter case, and no permission depends on the email. (2) Every allowed attempt counts, successful ones included, so anyone can lock a named account out of login for 15 minutes by sending 10 requests for it, and users behind one shared address share one budget. Per-account limits always allow the first; the IP bucket is the one to raise if a demo room needs it.

**As built (T56).** Communities, members and treasuries (ADR-0005 §3, §4; migration `0009`). T68 adds `authorize()` and the community routes on top; nothing here is exposed by a route yet.
- **Tables:** `communities` and `community_members` (`owner | steward`) as in §5, both `world_id NOT NULL` with composite `(world_id, …_id)` foreign keys onto `unique (world_id, id)` on users, assets and communities, so a row can't link across worlds (tested per foreign key in `tests/test_tenancy.py`). `holdings` and `orders` kept plain user and asset foreign keys at first; migration `0010` (#144) made them composite too (`fk_holdings_user`, `fk_holdings_asset`, `fk_orders_user`, `fk_orders_asset`, plus `ix_holdings_world_id_asset_id`), so every reference to a user is now world-scoped, as are trading and payout references to an asset (metrics, events, reports, prices, alerts, doc chunks and ledger entries still use plain asset keys). Both tables already had `world_id NOT NULL`; the upgrade refuses to run if any existing row crosses worlds, and the downgrade restores the plain keys. `assets.community_id` is new; `assets.community_user_id` lost its plain foreign key for composite ones, and `fk_assets_community_treasury` makes it the asset's own community's treasury whenever both are set. Membership is queryable by `(world_id, user_id)` (`ix_community_members_world_id_user_id`) for T68's roles and insider-trading rule.
- **Treasuries:** one `kind = 'treasury'` user per community (`treasury_user_id` unique; a trigger checks the kind), created with it: 0 cash, no email, password or persona key (the T54 CHECK), never an admin. It holds the community's retained stake and receives its dividends: `pay_quarter` (T41/T67) is unchanged because it pays `assets.community_user_id`. Triggers reject a treasury in `orders` ("can't trade"), `sessions` ("can't sign in") and `community_members`, and `users_treasury_kind` stops `users.kind` from changing to get around them (a community's treasury stays a treasury; a user with sessions, orders or memberships can't become one), and `auth.resolve_session` already refuses a treasury's session. The T17 orders route acts as the demo investor persona, so it never meets a treasury; T68's policy adds the 403s.
- **Seed:** each curated site has its own community, `<site name> Community`, owned by Rosa, with a treasury `<site name> Community Treasury` holding the 510 000 retained shares (fixed IDs `55555555-…-5555555555NN` and `66666666-…-6666666666NN`). Rosa is a member, not a holder, so her cash only moves if she trades. Shares are still conserved: `total_shares = primary_shares_remaining + market_maker_shares + Σ holdings`.
- **Sandbox:** clone copies users → communities → members → assets (community and treasury remapped) → the rest; the live world gets the communities with only their treasuries and members (plus those users' holdings). **Reset keeps every persona user's ID** (matched by `persona_key`, now unique per world) and restores its fields (cash, name, admin flag…) from the template, so sessions on personas survive; a persona the template lacks is deleted with its sessions; everything else, communities and treasuries included, is recreated with fresh IDs. `_DELETE_ORDER` starts with `sessions` (pruning deletes a world's sessions first) and deletes members, then communities, before users; a test checks it covers every world table, children first.
- **Migration `0009`, deploy note: existing demo sandboxes are reset on upgrade.** It deletes every world except the template and the live world (sandbox cleanup order, with the ledger-delete opt-in switched on only around the deletes; LLM call logs kept, detached); visitors get a fresh sandbox on their next visit. It then backfills the template and the live world: per asset whose `community_user_id` is a persona, a new treasury takes over that persona's retained holding and becomes `community_user_id`, and the persona becomes the community's owner. The template uses the seed's fixed IDs, so a later `make seed` is a no-op. Payout lines already paid to Rosa stay hers and still verify; cash she received stays with her. Downgrading hands each treasury's holdings and cash back to its first owner, erases the treasury's payout lines to tombstones (commitments then verify as `ok_with_erasures`) and deletes it; a treasury without an owner is kept.

Rating runs asynchronously: the API returns `202` + `run_id`, and progress arrives over SSE (`step: earth_obs → valuation → news → evidence → audit → done`).

**As built (T29):**
- `app.events.publish(session_or_conn, world_id, type, payload)` writes `rating_progress`, `price_tick` and `alert` events into `world_events` in the caller's transaction, so rolled-back business changes do not leak as live events. Same-world publishers take a transaction advisory lock before insert, which makes monotonic event IDs match commit visibility for that world; publishing transactions must stay short. Rating progress should publish each step in its own short transaction instead of holding one transaction across a full rating run.
- `GET /events/stream` uses standard `text/event-stream` over HTTP, sends `id:`, `event:`, `data:` and `retry:` fields, resumes from `Last-Event-ID`, and emits transient `heartbeat` events every ~15 s so proxies do not drop idle connections.
- Fan-out is by short-interval database polling rather than per-process queues or LISTEN/NOTIFY. This is less clever but portable across multiple workers, serverless timeouts and free-tier hosts; events are persisted first, so reconnects and the polling fallback replay from the same source of truth.
- Streams are finite (clients reconnect automatically), poll the database from a threadpool with short-lived sessions every 1 s, and set `Cache-Control: no-cache, no-transform` plus `X-Accel-Buffering: no`. `no-transform` is required: without it the Next.js `/api` proxy gzips the stream and buffers it, so the browser sees the connection open but no events until the stream ends. `EVENT_STREAM_MAX_CONCURRENT` defaults to 40: this matches the approximate Starlette/AnyIO threadpool size, while the SQLAlchemy DB pool is 15 connections and each poll releases its session immediately. At the default cap the upper bound is ~40 short DB polls/s per process. Overflow returns `503` + `Retry-After`, so clients can fall back to polling. `GET /events?since_id=` is the preferred cursor; legacy `since=` datetime remains accepted for generated clients.
- Retention keeps live replay lightweight by pruning `world_events` older than 24 h during the existing sandbox prune path; deleting a stale visitor world also deletes its events.

**As built (T27): rating runs** (`app/services/rating_runs.py`, `app/routers/runs.py`).
- **Routes.** `POST /assets/{asset_id}/rate` (no body) returns **202** `{run_id, asset_id, status: "queued"}` with `Location: /runs/{run_id}`. `GET /runs/{run_id}` returns `RatingRunOut`: `status` (`queued`, `running`, `succeeded`, `failed`, `degraded`), `trigger`, `scenario`, `pipeline` (`orchestrator` / `fixed`), `degraded` with `reasons`, `error`, the report's ID, version, grade, health and confidence, and every step with its tool, pipeline, model, tokens, cost and latency. Both are world-scoped (`CurrentWorld`: 401 `world_required`, 404 for another world's asset or run) and the POST goes through the T66 CSRF check. Errors: 409 `run_in_progress` (with `Location` of the active run), 409 `asset_is_draft` (drafts go through T58's `/submit`), 429 `rating_rate_limited` and 503 `rating_busy`, both with `Retry-After`. `ReportOut` gains `greenwashing_risk` (null = not assessed) and `run_id`.
- **Entry point for T38, T58 and T60:** `start_rating_run(world_id, asset_id, *, scenario=None, trigger="api" | "time_machine" | "listing", max_runs_per_hour=None) -> run_id`. It records the run and returns at once; a worker thread (pool of 4) runs it with its own short sessions, never the request's.
- **State is in the database, not in memory.** Every step publishes one `rating_progress` event in its own short transaction: `queued` → `started` → `earth_obs` → `valuation` → `news` → `evidence` (`skipped` until T40) → `audit` → `done`, plus `fallback` when the fixed pipeline takes over. Payloads carry `run_id`, `asset_id`, a per-run `seq`, `step`, `status` and, for tool steps, `tool`, `pipeline`, `attempts`, `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `latency_ms`, `error` and `llm_calls` (each call's `llm_calls` row ID, agent, model, tier, status, tokens, latency and cost; T28 builds the trace from them). The `done` event is written **in the same transaction** as the report and its ledger entry, so `done` exists exactly when the sealed report does; it carries the report ID, version, grade, `previous_grade` (for T38's alerts), health, confidence, fair value, `greenwashing_risk`, totals and wall time. `GET /runs/{id}` rebuilds the status from these events, so any worker can answer; once T29 prunes them (24 h) it reads the run record stored in the report (`auditor_json["run"]`). A run with no event for 15 minutes reads as `failed` (`stale`), e.g. after a worker crash. A worker re-checks this under the world's publisher lock before it starts a run: a run that went stale while it waited in the queue is closed as `failed: stale` and never calls a model, so it can't run alongside its replacement.
- **Caps.** One run per asset at a time, `RATING_RUNS_PER_WORLD_PER_HOUR` (default 6) runs per world and `RATING_RUNS_GLOBAL_PER_HOUR` (default 60) runs across all worlds per rolling hour (429 `rating_global_limit`; visitor worlds are free, so without it anonymous visitors could drain `LLM_BUDGET_USD` in a few hours) are checked in the transaction that publishes `queued`, so concurrent workers can't both pass. **Lock order:** a fixed global advisory key (`GLOBAL_RUNS_LOCK_KEY`) first, then the world's publisher lock; only `_enqueue` takes the global key, so there is no cycle. Both waits are bounded by `lock_timeout = 2s` (as in T66), and a timeout is 503 `rating_busy`. The route commits its read transaction before starting the run, so a request holds at most one pooled connection. At most 16 runs wait or run per process (503). `LLM_BUDGET_USD` stays the global hard cap (in `llm.py`); with `LLM_RESERVE_USD` > 0, API-triggered runs use the fixed pipeline without any model (`pipeline_fixed:budget_reserve`) once the budget left is below the reserve, keeping it for Time Machine and listing runs. T38 may pass `max_runs_per_hour` for a Time Machine quarter; it raises the per-world cap only.
- **Status values:** `succeeded` means a report was stored with no fallback; `degraded` means a report was stored but `reasons` lists what fell back (`pipeline_fixed:<reason>`, `orchestrator_lower_tier`, `auditor_unavailable`, `auditor_super` / `auditor_nano`, `news_unavailable`); `failed` means no report (`error`: e.g. `earth_obs_failed:no_cached_metrics`, `asset_not_found`, `internal_error`, `stale`).
- **Not wired yet:** `POST /admin/simulate/quarter` is still the mock. Its re-rate needs the next scenario per asset, admin authorization (T68) and price re-anchoring and alerts, which are T38's; T38 calls `start_rating_run(..., scenario=..., trigger="time_machine")`.

> Free hosts and serverless endpoints may drop long-lived connections **(verify)**; the frontend (`frontend/src/lib/events.ts`) falls back to polling every 3 s when the stream is refused (`503`), errors repeatedly, or stays silent for 35 s (no event or heartbeat, e.g. a buffering proxy). It retries SSE with backoff and keeps polling until the new stream delivers its first message.

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

**As built (T27, `backend/app/agents/orchestrator.py`; runs in `services/rating_runs.py`, see §6).**
- **Loop:** Nemotron 3 Super through `LLMClient.tool_step` (agent `orchestrator`, tier `orchestrator`, thinking **off**, 512 output tokens per turn), at most **8 model turns**. No PydanticAI: every turn stays budgeted and logged by `llm.py`. The loop ends as soon as `auditor` returns, because the report is fully determined by then, so no closing turn is paid for.
- **Tools take no IDs.** The run binds the world, asset and scenario before the loop; the model never sees an ID or the issuer-written asset name. The tools are `earth_obs(scenario?)` (the enum holds only the run's scenario), `valuation()`, `news_scout()`, `field_evidence()` (offered only when an `EvidenceProvider` says evidence exists; until T40 it never does, so the step is `evidence: skipped`) and `auditor()`. Each call's arguments are parsed as JSON (≤ 512 characters) and validated against a strict Pydantic model with unknown keys forbidden, so `{"asset_id": …}` is refused.
- **Order is enforced in code:** `earth_obs` before `valuation`; `auditor` only after every other offered tool, exactly once and last. An unknown or unoffered tool, invalid arguments, a wrong order, a duplicate call or a turn without a tool call is answered with a fixed feedback message (never echoing model text) and counts as a strike. The **second** strike, any call after the audit, the 8-turn cap, an LLM error, `BudgetExceeded` or `USE_MOCKS` / no key hands over to the **fixed pipeline**, which runs the remaining steps in Python in the required order (steps already done are kept). The run is then `degraded` with `pipeline_fixed:<reason>` (`unknown_tool`, `tool_unavailable`, `invalid_arguments`, `wrong_order`, `duplicate_call`, `auditor_called_twice`, `stopped_early`, `max_steps`, `llm_error`, `budget_exhausted`, `budget_reserve`, `llm_unavailable`, `use_mocks`), a `fallback` progress event and an `orchestrator_fallback` report flag. Violations are stored as codes and known tool names only.
- **Spend guards (review):** besides the per-world cap, a global cap (`RATING_RUNS_GLOBAL_PER_HOUR`, default 60, 429 `rating_global_limit`) bounds spend to about 60 × $0.014 ≈ $0.85 an hour at the measured cost; `LLM_RESERVE_USD` (default 0 = off) keeps API runs off the LLM inside a reserve, and a run that went stale in the queue never calls a model (§6).
- **Tool steps** retry once on failure. `earth_obs` (cached demo-site metrics; T60 adds live Earth Engine), `valuation` and `auditor` are required: if one still fails, the run fails without a report. `news_scout` and `field_evidence` are optional: the run continues with a `news_unavailable` / `evidence_unavailable` flag. Mock mode never calls a model: News Scout returns its fixture and the Auditor step uses the no-op audit.
- **Numbers never come from the model.** Tool results go back as compact JSON of deterministic values. News reaches the orchestrator only as counts, directions, the maximum severity and impact types (plus the locality gate's `dropped_off_site` count and `locality_unverified` flag, §7.5), never titles, summaries or URLs, so retrieved text can't instruct it; T72's guards still run inside News Scout, and the Auditor fences untrusted text (§7.7).
- **Storing and sealing:** `rate_asset(..., events=, audit=, run=, extra_flags=)` (T19 path) re-scores the metrics with the run's events (they feed T), applies the audit through `apply_audit` (`audited_rating`) and recomputes the fair value from the audited health and confidence, then writes metrics, report v(n + 1) and the `report` ledger entry in one transaction. `auditor_json` holds `rating` (now with the events used: IDs, metadata and their untrusted title and summary as data), `auditor` (the validated `AuditorOutput`), `audit` (source, model, degraded, fallback, rounds, rejections, citations, `greenwashing_risk` with **null = not assessed**) and `run` (run ID, trigger, scenario, status, pipeline, reasons, violations, steps and token totals). `summary_md` is the Auditor's summary plus the sandbox note, `recommendations` the Auditor's, and `flags` add the Auditor's flags (source `auditor`) and the run's. The ledger payload adds `audit` (source, adjustment, agreement, greenwashing risk) and `event_ids`; it holds no account identifiers. Unaudited ratings (seed) are stored exactly as before.
- **Live smoke (hero wetland, 2026-10-16, real keys):** `succeeded`, pipeline `orchestrator`, not degraded, 24.0 s from `started` to `done` (News Scout's Nominatim + Tavily + Nano took 13.9 s). Super made 4 turns (680 + 824 + 932 + 1,022 prompt and 58 + 20 + 24 + 25 output tokens, 0.8–1.8 s each, $0.00115 together). News Scout (Nano, 3,322 + 744 tokens, $0.00038) returned three items it labelled relevant restoration news (only one is about Xochimilco: a T25 relevance issue, not the orchestrator's; #146 added the locality gate, §7.5). Ultra answered in 2 rounds: the first was rejected (summary without inline citations and with numbers not in the bundle), the second accepted with no adjustment, agreement 0.5 and a `water_decline` flag (3,126 + 3,914 prompt and 791 + 906 output tokens, $0.0121). Report v2: health **76.2, grade A, confidence 71.0**, fair value 21.4723 (unchanged from v1, since no relevant negative event and no adjustment); greenwashing risk low; the ledger verifies. Total: 7 calls, 13,820 + 2,568 tokens, **$0.0137**.
- **Not done here:** news events are recorded in the report (snapshot and ledger `event_ids`) but not yet persisted to `events` / ledger `kind='event'` (§7.5); T38's `news_sweep` and event presets own that table. `ReportOut.summary_md` returns the Auditor's stored, cited summary with no read-time LLM call (`summary_source="auditor"`, or `"fallback"` for the Auditor's no-LLM template); T10's summary fills in for reports without one and for every simulated report (#145).

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

**As built (T35): map images.** `scripts/precompute_sites.py --images` renders, per demo site, a Dynamic World land-cover overlay (indexed PNG, official palette, transparent outside the polygon, 1024 px long side, exact polygon bounds in EPSG:3857) and a 640×400 Sentinel-2 true-colour thumbnail (Cloud Score+ masked 12-month median, polygon outline, WebP) into `data/demo_sites/images/`, with a sidecar `<site>.images.json` (bounds `[[south, west], [north, east]]`, palette, legend, date window, attributions). Images are **baseline only**: scenarios have no per-pixel map. `--images --check` verifies them offline (byte-identical output isn't guaranteed). Method and sizes in [ADR-0004](../adr/0004-earth-observation.md).

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
- **Gate loss proxy.** When `forest_loss_last_12m_ha` is missing, the gate uses the full 5-year Hansen loss as a conservative upper bound, recorded as `forest_loss_basis = "5y_total_proxy"`. The cached metrics carry it since T13 and the rating service passes it in since T19 (`forest_loss_basis = "last_12m"`). L always uses the 5-year loss.
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

**As built (T19): report v1 and the reports API (`backend/app/services/rating.py`).**
- **`rate_site(metrics, *, is_wetland, as_of, total_shares)`** is pure: T14 `value_metrics` → T15 `score_metrics` (with `forest_loss_last_12m_ha` from the metrics, so the gate uses the real last-year loss instead of the 5-year proxy) → §8 `fair_value_per_share`. `as_of` is explicit, so recency is deterministic in tests. No model is called.
- **`rate_asset(session, world_id, asset, *, metrics, as_of, previous_report=None, is_wetland=None)`** locks the asset row, then writes one `metrics` row, one `reports` row (version n + 1, read from the DB) and a `report` ledger entry in the caller's transaction (the caller commits). It accepts Time Machine scenarios (`load_site_metrics(site, scenario)`) for T38. Wetland status is decided once per asset: a curated site's committed baseline, else the asset's earliest observed `metrics` row, else these metrics if observed (a simulated first rating is refused); `is_wetland` overrides it for a declared ecosystem type.
- **Where things are stored (no migration):**
  - `metrics`: `data_version` (`2026Q3`, or `sim-N` for a simulated version), land cover, NDVI series and trend, water change, forest loss, biomass, cloud-free obs. A `metrics.provenance` jsonb column for the full scenario labels is deferred to T38 (it needs a migration); until then they live in the report's `simulated` flag and snapshot.
  - `reports`: health, grade, confidence, value low / mid / high, `value_breakdown` (mid per service group, summing to `value_mid`), `fair_value_per_share`, `recommendations` (empty until the Auditor) and a deterministic template `summary_md`.
  - `reports.flags`: a list of `{type, source, detail}`; sources are `valuation` (its flags), `scoring` (`auditor_pending`, `forest_loss_last_12m_missing`, `data_stale`, `listing_gate:<reason>`) and `data` (`simulated`, with the scenario, quarter and observed data version). Simulated data is never shown as observed: the flag, `ReportOut.simulated` and the summary all say so.
  - `reports.auditor_json["rating"]`: the full snapshot (method version, `as_of`, data age, period, wetland status, metrics provenance, `ScoreResult.to_json_dict()`, the valuation, and the fair-value inputs). The Auditor's own output goes under `auditor_json["auditor"]` (T26); `ReportOut.auditor` reads it from there.
  - Ledger payload: version, data version, `simulated`, `as_of`, the scores and values, breakdown, fair value, flag codes, `summary_sha256` and the method version.
- **Seed:** `make seed` stores report v1 for each curated site in the template world (skipped if one exists), rated on the day its freshest data window ends (2026-10-01, data age 0). The `ipo` price is the stored report's `fair_value_per_share`, and `demo_ipo_price` uses the same `rate_site`, so the price and the report can't disagree. On an existing database, `make seed` adds the reports and leaves the existing IPO prices alone (same numbers). Visitor worlds copy reports, metrics and ledger entries (IDs remapped) on creation or reset. **Deploy note (same as T17): run `make seed` once after upgrading**; visitor worlds created before T19 get their reports on their next reset (or a new world).
- **The three sites (report v1):**

| Site | Health | Grade | Confidence | Value low / mid = high (Int$2020/yr) | Fair value / share |
|---|---|---|---|---|---|
| Xochimilco wetland (hero) | 76.2 | A | 71.0 | 2,121,067 / 2,669,511 | 21.4723 |
| Ría Celestún mangrove | 84.8 | AA | 71.0 | 2,466,117 / 33,801,307 | 285.1519 |
| Sumidero restoration forest | 76.6 | A | 71.0 | 1,295,918 / 2,424,480 | 19.5456 |

  Hero fair value: 2,669,511 × 10 × (0.5 + 0.5 × 0.762) × (0.7 + 0.3 × 0.71) = 21,472,291.81 → 21.4723 per share. The forest passes the gate only because its last-12-month loss (0.86 ha) is used; the 5-year proxy (26.8 ha) would fail it. Scenario reports (same rating date): restoration lifts every site (wetland 87.1 AA, mangrove 86.3 AA, forest 77.5 A); encroachment lowers every site to BBB (wetland 68.8, mangrove 62.7, forest 67.3), and the mangrove and forest encroachments fail the last-12-month loss gate.
- **API:** `GET /assets`, `GET /assets/{id}`, `GET /assets/{id}/reports`, `GET /assets/{id}/prices`, `GET /reports/{id}` and `GET /reports/{id}/diff/{prev}` read the DB scoped to `CurrentWorld` (401 `world_required` without a world, 404 for another world's or the template's IDs). Cards carry the latest price, `price_change_pct` vs the IPO price, `trend` (health vs the previous report) and the latest report's grade, health, confidence and value range; drafts are hidden. `ReportOut` adds `data_version`, `period`, `simulated` and `rating` (the snapshot). T10's summary still decorates `summary_md` at read time (`summary_source`) for reports without a cited Auditor summary; audited, non-simulated reports return their stored summary (`"auditor"`, or `"fallback"` for the Auditor's no-LLM template; #145). Its cache is keyed by a SHA-256 of the facts the summary is written from, not the report ID, so every visitor world's copy of a template report shares one entry (one LLM call), and a new event or changed number gives a new key; live entries never expire, fallbacks are cached for 5 minutes. **Simulated reports never reach the summary model**: even when audited, they always get T10's deterministic fallback, which says in code that the figures are a simulated scenario, not an observation, because a model reply could drop that warning. `USE_MOCKS` now only means "no live LLM call"; asset and report data always come from the DB. `POST /assets`, `POST /assets/{id}/evidence` and `POST /admin/simulate/event` remain stubs (T58, field evidence, T38), but the last two now check the asset in the caller's world (401/404 like the other scoped routes); `?range=` on prices is accepted but not applied yet (T43), and the diff lists headline changes only (T37 extends it).

### 7.5 News Scout (Tavily + Nemotron Nano)
1. Build 2–3 queries from the nearest locality (reverse geocode via OpenStreetMap Nominatim, max 1 request/s with a custom User-Agent, cached per asset), and keywords: `"<locality> wetland factory permit"`, `"<locality> fire OR drought OR pollution"`, `"<locality> wetland restoration OR protected area OR conservation"`.
2. Tavily Search API `POST /search` with `topic="news"`, `time_range` derived from the lookback window, `max_results=5`, `include_raw_content="text"` and no generated answer.
3. Deduplicate by URL and send at most 8 top-scoring articles to Nemotron. The LLM binds classifications only by article index:
```json
{"article_index": 1, "relevant": true, "impact_type": "encroachment", "direction": -1, "severity": 4,
 "summary": "State approved an industrial park expansion bordering the wetland."}
```
4. **Prompt-injection guard:** wrap retrieved text in `<untrusted_content>` tags and instruct the model to treat it as data only; validate the output against a JSON schema; post-check that each index is in range and unique, URL/title/date come from the fetched article, dates are not in the future, and unsupported currency amounts are stripped from summaries.
5. **Hardening (T72, prompt `news-scout-v3`):**
   - **Prompt:** the system prompt carries the labelling guide (what counts as relevant, the impact types, the severity scale). After the article blocks the user message ends with the rule that text inside `untrusted_content` is data and that instructions or label assignments there are a sign of manipulation. The title is inside the `untrusted_content` block.
   - **Before the model:** the title and text are normalised (NFKC, invisible format characters removed) and searched, across line breaks, for instruction patterns (EN/ES, e.g. `ignore/disregard previous instructions`, `nota para el modelo`, fake `<system>` tags, `severity=`, a JSON `"severity":` key). From the sentence holding the first match to the end of the article is cut; the real report before it is still classified, so an attacker can't suppress a genuine event by attaching an instruction to it. An article that is only injected text is not sent. Each cut is logged with the article URL, never its text.
   - **After the model:** an event whose summary assigns a schema field (`relevant=`, `impact_type=`, `direction=`, `severity=`) is dropped and logged. The stored title is the redacted one, and a currency amount counts as supported only if it appears in the redacted article text.
   - **Known limits:** the pattern list can't be complete, so the prompt rule and the post-model check are the real defence. Look-alike letters from other scripts (for example Cyrillic `і`) are not mapped. Because the redaction runs before the prompt, the T25 injection items measure the filter and the model together; items the patterns don't match are needed to measure the model alone.
6. **Locality gate (#146):** after the post-check, an event the model labelled relevant is kept only if the text the model saw (the redacted title, plus Tavily `content` and the `raw_content` slice cut to the prompt's 2,500 characters) names the asset or a place from the reverse geocode. It always runs; without a geocode it gates on the asset name alone. Code decides, not the prompt, because Nano labelled Indiana and Iceland stories relevant in a live run even though the prompt rules out other places.

**As built (#146), locality gate** (`_locality_terms`, `_locality_gate` in `agents/news_scout.py`):
- **Names:** the Nominatim name and every named address level from the locality up to the state or region (`suburb`, `borough`, `city_district`, `hamlet`, `village`, `town`, `city`, `municipality`, `county`, `state_district`, `state`, `region`), plus the asset name in full, without leading or trailing descriptors (`Xochimilco Wetland` → `Xochimilco`), and each of its words with at least 6 letters that isn't generic (`Sumidero Canyon Restoration Forest` → `sumidero`, so `Cañón del Sumidero` matches). **The country never counts**, alone or as a state of the same name. Names shorter than 4 letters, made only of digits (postcodes) or only of generic words (`Centro`, `San`, `Ciudad`, `Reserve`, `Ría`, `Cañón`, `Biosfera`…) are ignored. The geocoder now returns `GeocodedPlace` (label for the queries and prompt, place names, country).
- **Matching:** NFKC, invisible characters removed, then NFKD with combining marks stripped and casefolded, so `Celestún` matches `CELESTUN`; whole words only (`León` doesn't match `Napoleon`); multi-word names must appear in order (`Ciudad de México`, not just `México`).
- **Dropped events** are logged by URL (never their text) and counted in `NewsScoutOutput.dropped_off_site`; the orchestrator's `news_scout` result carries `dropped_off_site` and `locality_unverified` next to the other counts.
- **No geocode (fail-closed):** if Nominatim fails or returns only a country, the gate still runs on the asset-name terms alone, `locality_unverified` is `true` and a warning is logged. Dropping an article only lowers recall, so this is safer than trusting the model's label. The result is treated as degraded and not cached, so the next run retries the geocode.
- **Known limits:** it is a keyword filter, not a relevance check: an article that merely names the place (or is stuffed with the name) still passes, and the model's relevance label and the T72 guards remain the other layers. Names are matched in the language Nominatim returns (the local one), so an article that says only `Mexico City` for a `Ciudad de México` address is dropped unless it names the locality or the asset; state-level names are broad, so a state-wide story can still pass. The prompt is unchanged (`news-scout-v3`), and the T25 eval measures the model without the gate.

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
- **Seed IPO prices:** `make seed` gives every listed curated site an `ipo` price equal to its stored report v1's `fair_value_per_share` (T19; `demo_ipo_price` shares the same `rate_site`). Today that's wetland 21.4723, mangrove 285.1519 and forest 19.5456 per share. T59 prices owner-launched IPOs. **On an existing database, run `make seed` once after upgrading** so the template gets its prices; visitor worlds pick them up on their next reset or creation.

A tick is triggered by `POST /admin/simulate/quarter`, by a scheduled job, or by the SSE loop while the demo is running (no always-on process is required).

**Quarterly revenue split (simulated):**
- `revenue_q = value_mid × capture_rate / 4`, with capture_rate = 2%.
- 50% goes to `community_wallet`.
- 50% is paid as dividends pro-rata to holders (including the community's retained stake).
- **As built (T41):** `backend/app/market/revenue.py` uses Decimal cents and a
  largest-remainder allocation so payout cents sum exactly to revenue. Dividend ties are
  broken by stable holder key; primary float / market-maker shares are unheld and receive
  no dividends. The community's retained stake must be recorded as a positive holding for
  `Asset.community_user_id` (since T56 the community's treasury, not the owner persona); that
  user's cash balance receives the retained-stake dividend,
  while the 50% community fund is credited to `Asset.community_wallet`. The pure calculator
  can report a no-holders case, but `pay_quarter` refuses to apply one to the DB. `pay_quarter`
  is a thin transaction-scoped helper for T38/T44 and is not wired to `routers/market.py` while
  T17 rewrites that router.
- **As built (T67), ledger privacy (ADR-0005 §6):** `pay_quarter` writes one private
  `payout_lines` row per paid holder (user, shares, amount, a random 32-byte `nonce` and
  `leaf_hash = sha256(nonce ‖ canonical(line))`) and a public `payout` ledger entry with
  aggregates only: `quarter_label`, `value_mid`, `capture_rate`, `revenue`, `community_fund`,
  `dividend_pool`, `dividends_total`, `unallocated_dividends`, `community_wallet_credit`,
  `holder_count`, plus `lines_commitment = sha256(canonical({"leaves": sorted(leaf hashes)}))`
  and `commitment_method`. Nonces and leaves never reach the ledger, so nobody can confirm a
  guessed holder line from public data.
  - `verify_payout_commitment(session, entry)` audits the private lines against the public
    entry: live lines are rehashed from their contents and nonce, erased lines contribute their
    tombstone leaf. It returns `ok`, `ok_with_erasures` (with the count), `mismatch` (a line,
    nonce or leaf was added, removed or changed) or `no_commitment`.
  - `erase_payout_lines_for_user(session, world_id=, user_id=)` (for K5 delete-account) clears
    the user's user ID, shares, amount and nonce and keeps the leaf hash as a tombstone. Without
    its nonce the leaf can't be linked to the erased line; every other holder's line still
    verifies, and the ledger and its aggregates are untouched.
  - Idempotency per asset quarter: the ledger check under the asset lock, plus the
    `uq_ledger_payout_quarter` partial unique index on `ledger_entries`.
  - **Legacy entries:** payout entries written before T67 list per-holder payouts (user IDs)
    in their immutable payload and verify as `no_commitment`. Only sandbox personas existed
    then, never real accounts, so they stay.
  - Sandboxes: reset and prune delete a world's payout lines. Payouts are visitor activity and
    aren't copied, and a source world that holds payout lines can't be copied at all
    (`RuntimeError`): leaves cover user IDs, which the copy remaps, so copied lines could never
    verify. **T38 (Time Machine) and T44 (impact UI), which call `pay_quarter`, must only pay
    out in visitor or live worlds, never in the template.**

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

**As built (T35):** the backend serves the precomputed images publicly at `GET /media/demo-sites/{site_key}/overlay.png`, `/thumbnail.webp` and `/images.json` (allowlisted site keys, 404 otherwise, `nosniff`, one-day cache); the browser loads them via `/api/media/…`. For the asset page's "Map + land-cover overlay", put `overlay.png` in a Leaflet `ImageOverlay` at the sidecar's `overlay.bounds` over the OSM basemap, with the legend and attributions from the sidecar; for AssetCard, use `thumbnail.webp` with its caption attributions. A dev-only preview of both is on `/dev/ui` (`DemoSiteImages`, `LandCoverMap`, `LandCoverLegend`, `SiteThumbnail`). `LandCoverMap` uses **plain Leaflet** (BSD-2-Clause), not react-leaflet, whose licence is Hippocratic-2.1 (not OSI open source); ADR-0001 is updated accordingly, and T23/T33 should use the same approach.

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
ENVIRONMENT=production     # every deployment; cookies drop Secure only if explicitly development/test (T54)
ALLOWED_ORIGINS=https://app.example.com   # exact origins allowed to POST/PUT/PATCH/DELETE (T66); default http://localhost:3000
TRUSTED_PROXY_HOPS=0                      # trusted proxies that append to X-Forwarded-For; the Next.js /api rewrite is not one (T66); set from the real deployment, T20
AUTH_RATE_LIMIT_SECRET=<32+ random bytes>  # HMAC key for rate-limit buckets; required unless ENVIRONMENT is development or test (T66)
LLM_BUDGET_USD=20          # hard cap per deployment key (§21)
RATING_RUNS_PER_WORLD_PER_HOUR=6  # rating runs each world may start per rolling hour; 429 after (T27)
RATING_RUNS_GLOBAL_PER_HOUR=60    # rating runs across all worlds per rolling hour; 429 rating_global_limit (T27)
LLM_RESERVE_USD=0                 # >0: API rating runs skip the LLM once budget left < reserve (T27)
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
- **As built (T67), privacy:** payloads and `ref_id`s never hold account identifiers, emails or
  person names (ADR-0005 §6). Payouts record aggregates plus a commitment over per-line nonced
  hashes of the private `payout_lines` (§8). As defence in depth, `append` raises
  `LedgerPrivacyError` for:
  - a deny-listed key at any depth (`user_id`, `holder_id`, `holder_payouts`, `email`,
    `password`, `display_name`… and any `*_user_id` or `*_email`); a listing's `name` is the
    public site name and is allowed;
  - an email address in a string. In an http(s) URL, any userinfo is rejected and only the
    decoded query and fragment are searched, so paths like `cover@2x.png` pass;
  - a `ref_id` that is a user's ID (one primary-key lookup), since `ref_id` is public too.

  The guard can't tell a user UUID inside a payload from an asset UUID, so
  `tests/test_ledger_privacy.py` finds every `ledger.append` call in `app/` (AST), runs the
  real producer for each kind that has one, falls back to a §17-shaped payload only for kinds
  with no producer yet, and scans every payload and `ref_id` against every account's ID, email
  and name.
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

**As built (T25):**
- **Dataset:** `evals/news.jsonl` holds 40 labelled items covering the 3 demo sites. Half are paraphrased real Tavily results and half are synthetic. The set includes 21 Spanish items, 14 near-misses, 3 prompt injections and every `impact_type`. The labels are AI-drafted and still need a human spot-check.
- **Provider:** `evals/promptfooconfig.yaml` (promptfoo 0.124.0) runs a Python provider that calls the real News Scout path: `_messages`, then `LLMClient.structured`, then `_post_check`. It runs one article per call, with the model tier as a parameter. Nano is on by default; Super and Ultra are opt-in.
- **Metrics:** promptfoo scores these named metrics: `schema_valid`, `schema_first_try`, `relevance`, `impact_type`, `direction`, `severity` (±1) and `injection_resistance`. Labels are scored on the post-checked events, the ones production keeps. A provider error counts as a failure in every metric.
- **Cost and caching:** spend is logged to `llm_calls` as `news_scout_eval`. The provider caches at the transport level, keyed on the exact request payload, because promptfoo's Python-provider cache misses across runs.
- **Baseline (Nano):** relevance 72% (target 85%), impact_type 79%, first-try schema 100%, injection resistance 0/3. One run costs about $0.002. See `evals/README.md`. T72 (#123) added the labelling guide to the prompt and the injection guards (§7.5 step 5); the scores after T72 are recorded here once the eval is re-run with a Token Factory key.
- **Left for T47:** `make eval`, macro-F1, `evals/results.md`, and the other §18 rows.

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
