# ADR-0001: Stack and version pins

## Status
Accepted. Partly superseded: models and embeddings by [ADR-0003](./0003-model-routing-on-token-factory.md); hosting options re-ranked in [dev-spec §21](../specs/dev-spec.md) (Oct 5).

## Date
2026-10-04

## Context
WildWorth needs a fixed stack for a five-week hackathon so CI, AI assistants and parallel owners (D1–D3, PD) do not drift. Open items from [research.md](../research.md) §6 and [plan.md](../../tasks/plan.md) must be decided before schema and frontend scaffold land.

Constraints from [AGENTS.md](../../AGENTS.md): Python 3.12 + FastAPI + SQLModel; Next.js App Router + Tailwind + shadcn/ui; Nemotron only via Nebius Token Factory; free tiers unless covered by hackathon credits.

## Decision

| Layer | Choice | Pin / note |
|---|---|---|
| Backend runtime | Python | **3.12** |
| Backend API | FastAPI + Pydantic v2 + SQLModel | current stable via `uv.lock` |
| Tooling (Python) | uv, ruff, mypy `--strict`, pytest | as in `backend/pyproject.toml` |
| Frontend | **Next.js 15.5** (App Router) | Prefer 15.5 over 16 for hackathon stability; revisit only if a blocker appears |
| Frontend language | TypeScript **5.x** (strict) | Pin when T05 scaffolds; avoid TS 6 until typescript-eslint support is confirmed in CI |
| Lint/format (FE) | ESLint 9 + Prettier | Biome skipped for Next.js compatibility |
| CSS / UI | Tailwind **v4** + **shadcn/ui only** | Tokens via `@theme`; `/dev/ui` showcase |
| Maps | **Leaflet** (BSD-2-Clause) used directly from client components; drawing via a BSD/MIT plugin (e.g. leaflet-draw, MIT) | Esri/OSM basemap. *Updated in T35:* react-leaflet was dropped because its licence is Hippocratic-2.1, which isn't OSI open source; wrap Leaflet in small client components instead |
| Charts | Recharts | |
| DB | Postgres **16** + **pgvector** | Local: `pgvector/pgvector:pg16`; hosted: per dev-spec §21 |
| LLM client | OpenAI-compatible SDK via Token Factory `base_url` | Wrapper in `backend/app/llm.py` (T09) |
| Agent framework | **PydanticAI** with `OpenAIProvider(base_url=Token Factory)` | Prefer over a hand-rolled loop; fall back to plain tool-calling if spike fails |
| News | **tavily-python** | |
| Earth observation | **Google Earth Engine** primary | Planetary Computer fallback only |
| Valuation coefficients | **Brander 2024 (CC BY) + Costanza 2014**, cited | **Do not** commit raw ESVD data |
| Carbon | AGB × (1 + R) × 0.47 × 44/12 + SoilGrids SOC for wetlands | Formula refined in T14; see research §6 |
| NDVI trend | Cloud Score+ masking + **Sen's slope** | Confirmed in T03/T11 |
| Embeddings | ~~Token Factory NVIDIA embed if available; else local bge-small~~ | Superseded by [ADR-0003](./0003-model-routing-on-token-factory.md): `Qwen3-Embedding-8B` on Token Factory |
| Tracing | OpenTelemetry spans → Postgres (`llm_calls` + Agent Trace); optional Langfuse | |
| Evals | **promptfoo** + pytest runner (`make eval`) | |
| Hosting (demo) | Frontend **Vercel Hobby**; backend + DB chosen in T20 | Ranked in dev-spec §21: Nebius Serverless → Azure (approved credits) → HF Spaces/Render + Supabase |
| Package managers | **uv** (backend), **pnpm** (frontend) | Plain-folder monorepo |

## Alternatives considered

### Next.js 16
- Pros: newest App Router features
- Cons: higher churn during the hackathon; research notes ESLint/TS pin friction
- Rejected for now: 15.5 is enough for App Router + shadcn

### Hand-rolled OpenAI tool-calling loop (no PydanticAI)
- Pros: fewer dependencies; matches early dev-spec wording
- Cons: re-implements validation retries and structured output
- Rejected: PydanticAI fits schema-validated agents; keep plain loop as fallback

### Raw ESVD coefficients in-repo
- Pros: richer $/ha tables
- Cons: non-redistributable licence
- Rejected: use Brander 2024 + Costanza 2014 with citations

## Consequences
- T05 scaffolds Next.js 15.5; T02/T03 may adjust model IDs and EE auth details in follow-up ADRs.
- `docs/specs/dev-spec.md` §2 should be read as “Next.js 15.5” (not “15” generically).
- Coefficient and carbon formula details are implemented in T14/T15; this ADR locks the *sources*, not every numeric cell.
