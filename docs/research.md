# NatureX — Open-Source Landscape Research (Sept 2026)

> What already exists that we can reuse instead of building from scratch. Researched Sept 27–28, 2026; star counts and versions are approximate. Verdicts: **ADOPT** (use as-is), **BORROW** (copy ideas/files), **SKIP**.
> Related: [dev-spec.md](./specs/dev-spec.md) · [pm-spec.md](./specs/pm-spec.md) · [demo-plan.md](./specs/demo-plan.md)

## TL;DR: recommended set
| Area | Adopt |
|---|---|
| Team + AI assistants (**final, installed**) | Root **`AGENTS.md`** (+ `CLAUDE.md` → `@AGENTS.md`); skills in `.agents/skills/`: **addyosmani/agent-skills** (spec, plan, build, test, review…), **impeccable** (UI/UX), Vercel **web-design-guidelines** + **react-best-practices**, Supabase **postgres best practices**; MCP: **GitHub, Context7, shadcn, Playwright, Chrome DevTools**. See [ai-setup.md](./ai-setup.md) and ADR-0001 |
| Repo foundation | Plain-folder monorepo; **uv, ruff, mypy strict, pytest**; **ESLint 9 + typescript-eslint, Prettier, tsc strict**; **pre-commit**; **openapi-typescript + openapi-fetch** client with a CI drift check; MADR ADRs; issue forms, PR template, CODEOWNERS, `main` ruleset; GitHub Issues + generated task map |
| UI | **shadcn/ui** + blocks, Tailwind v4 tokens, `/dev/ui` showcase page, **Driver.js** tours, **Motion** (sparingly) |
| AI agents | **PydanticAI** via `OpenAIProvider(base_url=Token Factory)`; **promptfoo** evals; OpenTelemetry spans → own Postgres (Agent Trace drawer) + **Langfuse**; **tavily-python** |
| Geo + valuation | **earthengine-api** + **geemap** (Xee optional); shapely/geopandas; coefficients from **Brander et al. 2024 (CC BY) + Costanza 2014**, **not raw ESVD**; InVEST carbon-pool method; SEEA-EA report structure |

---

## 1. Team workflow with multiple AI assistants
| Item | What / maturity | Verdict |
|---|---|---|
| **AGENTS.md** (agents.md, Linux Foundation) | One Markdown instruction file read by Codex, Cursor, Copilot and Claude Code; nearest file wins; ~24.6k★, MIT | **ADOPT**: single source of truth |
| CLAUDE.md | Claude reads AGENTS.md **only if no CLAUDE.md/CLAUDE.local.md exists**; can import with `@AGENTS.md`; keep < 200 lines | ADOPT as a one-line pointer, or omit |
| Copilot `.github/copilot-instructions.md`, `*.instructions.md` (`applyTo`) | VS Code treats AGENTS.md as the shared format | BORROW (only for file-type-scoped extras) |
| Cursor `.cursor/rules/*.mdc` | Cursor also reads AGENTS.md; plain `.md` in rules is ignored | BORROW |
| rulesync / Ruler | Generate per-tool files from one source | Optional / SKIP |
| github/awesome-copilot (~39k★, MIT), PatrickJS/awesome-cursorrules (~41k★, CC0) | Curated Next.js, FastAPI, shadcn rules | BORROW (review quality; some target Next 14) |
| **Agent Skills** spec (agentskills.io, Apache-2.0) + **vercel-labs/skills** (`npx skills`, MIT) | `SKILL.md` folders, loaded on demand; Claude uses `.claude/skills`, others `.agents/skills` | **ADOPT** (symlink `.claude/skills` → `.agents/skills`) |
| anthropics/skills | Mostly Apache-2.0, but **docx/pdf/pptx/xlsx skills are source-available** | BORROW (don't vendor document skills) |
| **addyosmani/agent-skills** (~99k★, MIT) | 25 engineering skills: spec, plan, incremental build, TDD, API design, frontend, review, security, ADRs, CI | **ADOPTED** (covers spec → tasks, so OpenSpec isn't needed) |
| **pbakaus/impeccable** (~72k★, Apache-2.0) | Design skill with `PRODUCT.md`, critique/audit/polish commands and anti-pattern checks | **ADOPTED** (UI that doesn't look AI-generated) |
| vercel-labs/agent-skills (MIT), supabase/agent-skills (MIT) | `web-design-guidelines`, `react-best-practices`; Supabase + Postgres best practices | **ADOPTED** (those skills only) |
| latent-spaces/brag (MIT) | 15–25 s launch-video skill | Optional personal install (not in the repo) |
| obra/superpowers (MIT) | Brainstorm → plan → subagent TDD workflow | SKIP (overlaps addyosmani/agent-skills) |
| OpenSpec (~70k★, MIT) | `propose` → `proposal.md` + `tasks.md` per change folder → `apply` → `archive` | **SKIP for NatureX:** replaced by addyosmani's spec and planning skills + `tasks/todo.md` / GitHub Issues (ADR-0001) |
| GitHub Spec Kit (~139k★, MIT) | constitution → specify → plan → tasks → implement; stricter gates | SKIP (same reason) |
| BMAD Method (MIT) | PM/architect/dev personas, epic and story files | BORROW (PRD template, checklists) |
| Task Master | **MIT + Commons Clause**; team mode needs a paid cloud | **SKIP** |
| Agent OS, Kiro specs, Cline Memory Bank | Standards extraction; 3-file spec format; memory files | BORROW ideas |
| wshobson/agents (MIT) | 200+ subagents and skills | BORROW selectively (context bloat) |
| **MCP servers:** GitHub MCP (MIT), Context7 (current library docs; free tier rate-limited), shadcn MCP, Playwright (use the CLI + skill variant), Chrome DevTools (optional), postgres-mcp (optional) | Free | **ADOPT** GitHub, Context7, shadcn, Playwright CLI |
| Serena | **GPL-3.0** | SKIP (never vendor) |

**Pitfalls:**
- Claude silently ignores AGENTS.md if a CLAUDE.md or CLAUDE.local.md exists.
- Codex caps instructions at 32 KiB. Keep AGENTS.md lean and move detail into skills.
- Skill folders differ per tool, so symlink them or they drift.
- Don't duplicate rules across files.
- Use one spec framework only.

## 2. Repo foundation and tooling
| Item | Notes | Verdict |
|---|---|---|
| fastapi/full-stack-fastapi-template (45.8k★, MIT) | Right backend (FastAPI, SQLModel, Alembic, pytest, ruff, mypy strict), but a Vite frontend and Python ≥ 3.14 | **BORROW** the backend layout, `compose.yml`, `.pre-commit-config.yaml`, `scripts/generate-client.sh`, CI workflow |
| vintasoftware/nextjs-fastapi-template, nemanjam/full-stack-fastapi-template-nextjs | Next.js variants; stale or single-maintainer | BORROW ideas (client auto-regeneration, Vercel env wiring) |
| **Plain-folder monorepo** (`frontend/` pnpm, `backend/` uv, `docs/adr/`, root Makefile) | Turborepo, Nx and pnpm workspaces add nothing with one JS package | **ADOPT** |
| **openapi-typescript + openapi-fetch** (MIT) | Types plus a ~6 kB typed fetch; commit output; CI `git diff --exit-code` drift check | **ADOPT** (hey-api if we later want Query hooks; SKIP orval and openapi-generator) |
| **uv, ruff, mypy `--strict` + pydantic plugin, pytest + httpx** | All MIT/BSD/Apache | **ADOPT** |
| **ESLint 9 flat config** (`eslint-config-next` + typescript-eslint), **Prettier** + Tailwind plugin, **tsc strict** + `noUncheckedIndexedAccess` | Next 16 dropped `next lint`; run `eslint .` | **ADOPT** (Biome SKIP for Next.js) |
| **pre-commit** (or prek), **typos** | Local hooks mirror CI | ADOPT |
| Issue forms, PR template, **CODEOWNERS**, `main` **ruleset** (PR + 1 approval + green CI, squash-only, no force-push) | Free for public repos | **ADOPT** |
| Conventional Commits via **PR-title check** (`amannn/action-semantic-pull-request`) | Less friction than commitlint + husky | ADOPT |
| **MADR 4** ADR templates (MIT/CC0) | adr-tools (GPL, stale), log4brains (stale) | ADOPT MADR |
| GitHub **Issues** for status (assignee = picked, closed = done) + generated **task map** (`tasks/task-map.html` / `.json`, `scripts/task_map.py`) | GitHub Projects board (optional; nothing depends on it) | **ADOPT** issues + task map |

**Version pins to act on (Sept 2026):**
- **Next.js 16.3** is latest; 15.5.x still gets patches. Our spec says 15, so decide 15.5 vs 16.
- Pin **TypeScript 6.0.3**, because typescript-eslint supports < 6.1. *(ADR-0001 chose TypeScript 5.x and Next.js 15.5 for stability.)*
- Pin **ESLint 9.39.x**, because Next's React plugins stop at ESLint 9.
- Python 3.12 is fine; lower the template's ≥ 3.14 requirement.

## 3. UI consistency and the judge tour
| Item | Notes | Verdict |
|---|---|---|
| **shadcn/ui** CLI + blocks (MIT) | `npx shadcn add dashboard-01 sidebar-07 …` | **ADOPT** |
| Tailwind v4 CSS-first tokens (`@theme inline`, OKLCH vars) + NatureX brand vars; chart palette shared with Recharts | — | **ADOPT** |
| Storybook, Ladle | Too heavy for 5 weeks | SKIP; use a **`/dev/ui` route** (hidden in prod) |
| **Driver.js** (26.9k★, MIT, ~5 kB) | Guided tours | **ADOPT** (react-joyride MIT as an alternative) |
| Shepherd.js | **AGPL-3.0 or commercial** | **SKIP** (license) |
| **Motion** (formerly Framer Motion, MIT) | Don't use paid Motion+ | ADOPT sparingly |

## 4. AI agents, structured output, evals and tracing
| Item | Notes | Verdict |
|---|---|---|
| **PydanticAI** (~20k★, MIT) | `OpenAIProvider(base_url="https://api.tokenfactory.nebius.com/v1/")`; Pydantic output types with validation retries; per-run usage limits; OTel GenAI tracing. Its built-in `NebiusProvider` uses an **old URL**, so use the generic provider. | **ADOPT** |
| NVIDIA NeMo Agent Toolkit (Apache-2.0) | Wrapper layer with YAML config, profiler, eval, exporters; Tavily plugin exists. **Not named in the hackathon rules**, so no explicit extra credit. | BORROW ideas (mention in NVIDIA feedback) |
| LangGraph (MIT) | Used in Nebius cookbook examples; more graph code than we need | BORROW |
| OpenAI Agents SDK, LlamaIndex, smolagents, CrewAI | OpenAI-centric / heavy / stalled / opaque | SKIP |
| Plain OpenAI SDK loop (+ Instructor) | Pattern from the Token Factory docs | Fallback (~1 day to switch) |
| **Token Factory structured output** | Docs list `response_format` `json_schema` and `json_object` (only models tagged "JSON mode"), plus OpenAI-style tool calling (`tool_choice`: `auto` or a named function). **Nemotron JSON-mode support and exact model IDs are unverified**: check `/v1/models` in week 1. | ADOPT, with a schema-reliability test in CI |
| **promptfoo** (~25k★, MIT) | Same test cases across Nano, Super and Ultra; JSON-schema, faithfulness and rubric asserts; caching keeps CI cheap; Python provider for the real pipeline | **ADOPT** |
| Inspect AI (MIT) | Official Nebius cookbook recipe | BORROW (Python-native alternative) |
| DeepEval, Ragas, OpenAI Evals, NeMo Evaluator | Metric ideas / stale / benchmark-focused | BORROW or SKIP |
| **OpenTelemetry GenAI conventions** | `gen_ai.*` attributes (still in development) | **ADOPT** |
| **Langfuse** (MIT core; `ee/` folders under a separate license) | Takes OTLP directly; self-host or free cloud | **ADOPT** |
| Arize Phoenix | **Elastic License 2.0** (not open source) | BORROW (local use only) |
| Helicone | Maintenance mode since Mar 2026 | SKIP |

**Reference code:**
- **nebius/token-factory-cookbook** (MIT):
  - `agents/nemotron-agents/research_agent_2_nemotron_metrics.py` (per-call token logging)
  - `agents/pydantic-weather-agent`, `agents/agent-cost-comparison-1`
  - `agents/universal-deep-research-nebius` (FastAPI + Next.js + Tavily)
  - `tool-calling/tavily_tool_calling.ipynb`, `evaluations/inspect-ai`
- **NVIDIA-NeMo/Nemotron** Super getting-started guide: `enable_thinking`, `reasoning_budget`.
- NVIDIA AI Blueprints `llm-router` for routing ideas (check each repo's license).
- **tavily-python** (MIT).

**Risks:**
- Nemotron **reasoning ("thinking") mode can break JSON output**. Turn thinking off for Auditor JSON calls, or reason first and format in a second call. Whether Token Factory passes `chat_template_kwargs` through is unverified.
- The Token Factory docs show a non-standard `json_schema` shape, so test both forms.
- A global budget ledger is still needed: framework usage limits apply per run only.

## 5. Geospatial, valuation and nature-finance
**Platform:** Earth Engine is the primary choice. **Planetary Computer lacks Dynamic World, Hansen and GEDI**, so it's a fallback only (io-biodiversity, ESA WorldCover).

| Item | Notes | Verdict |
|---|---|---|
| **earthengine-api** (Apache-2.0) + **geemap** (MIT) | Server-side `reduceRegion`; notebooks `114_dynamic_world`, `116_land_cover_timeseries`, `12_zonal_statistics`, `146_chart_image_collection` | **ADOPT** |
| Xee (xarray for EE) | NDVI stack into xarray | Optional |
| pystac-client + odc-stac | Planetary Computer fallback (stackstac is stale) | BORROW |
| shapely / geopandas | Validation; area in an equal-area CRS | **ADOPT** |
| **InVEST** (Apache-2.0) | Carbon-pool-table × area method; Habitat Quality as a stretch goal | BORROW |
| **SEEA-EA** (UN standard) | Structure the report as **Extent → Condition → Services** accounts | **BORROW** (credibility) |
| ARIES / k.LAB | **AGPL-3.0**, heavy | SKIP |
| **Brander et al. 2024** (Ecosystem Services 66:101606, **CC BY**) | ESVD biome means, Int$/ha/yr 2020 prices | **ADOPT** as the coefficient source |
| **ESVD** | **Non-commercial; no redistribution or derivative works without written consent** | **Don't commit raw data** (email esvd@fsd.nl if needed); cite it |
| Costanza 2014 (2007 US$) | Confirmed: tidal marsh/mangrove **193,843**, swamps/floodplains **25,682**. Lakes/rivers 12,512, tropical 5,382, temperate 3,137, grassland 4,166 are **unverified** against the primary table. Distributions are very skewed (coastal wetland median 12,163 vs mean 193,845). | ADOPT with a citation; show median–mean ranges |
| **ESA CCI Biomass v6** (`ESA/CCI/Above_Ground_Biomass/V6_0`, CC-BY 4.0, 100 m, has `agb_sd`) | Weak for wetlands and grass | **ADOPT** (primary biomass) |
| GEDI L4B | 1 km, single 2019–21 mean; too coarse for 500 ha | Cross-check only |
| Chloris biomass | **CC-BY-NC-SA** | SKIP |
| **SoilGrids SOC** (ISRIC; licence to verify) | Wetland carbon is mostly in soil | ADOPT |
| Impact Observatory Biodiversity Intactness (CC-BY 4.0) | Optional biodiversity input | Optional |
| Global Forest Watch, **CarbonPlan** (MIT), **Regen Network** (Apache-2.0), Restor | Polygon-report UX, honest MRV analysis, credit data model | BORROW ideas |

**Verified Earth Engine IDs:**
- `GOOGLE/DYNAMICWORLD/V1`
- `UMD/hansen/global_forest_change_2025_v1_13`
- `JRC/GSW1_4/*` (to 2021)
- `LARSE/GEDI/GEDI04_B_002`
- `ESA/CCI/Above_Ground_Biomass/V6_0`

**Data terms and attribution:**
| Source | Obligation |
|---|---|
| Earth Engine | Non-commercial registration; Community tier 150 EECU-h/month; a commercial licence is needed if we monetise. Check how the terms treat a hackathon with prizes. |
| Dynamic World | CC-BY 4.0. Credit: "produced for the Dynamic World Project by Google in partnership with National Geographic Society and the World Resources Institute" |
| Sentinel-2 | "Contains modified Copernicus Sentinel data [year]" |
| JRC GSW | Cite Pekel et al. 2016; "Source: EC JRC/Google" |
| Hansen GFC | CC-BY 4.0; cite Hansen et al. 2013 |
| GEDI | Public domain; cite doi:10.3334/ORNLDAAC/2056 |
| Nominatim | ≤ 1 req/s, custom User-Agent, cache results, "© OpenStreetMap contributors" (ODbL) |
| Natural Earth | Public domain (safe to commit) |

## 6. Findings that affect our current specs (decided in [ADR-0001](./adr/0001-stack-and-versions.md))
1. **Inland wetlands:** Dynamic World `flooded_vegetation` → swamps/floodplains ($25,682); `water` → lakes/rivers. Tidal marsh only when the coastal check passes (the spec already does this; keep it).
2. **Coefficient source:** switch the committed table from ESVD to **Brander 2024 + Costanza 2014** (cited). Don't mix 2007 US$ with 2020 Int$; pick one basis and state it.
3. **Ranges:** use the median–mean spread for low/high, not fixed multipliers. **Don't add the CO₂ dollar value on top of ESV** (double counting).
4. **Carbon:** CO₂ = AGB × (1 + R) × 0.47 × 44/12, with R the IPCC root-to-shoot ratio. Add **SoilGrids SOC** for wetlands. Use `agb_sd` in confidence.
5. **Water:** JRC GSW ends 2021; use Dynamic World water probability for 2022–26.
6. **Habitat loss:** apply a Hansen `treecover2000` ≥ 30% mask.
7. **NDVI:** Cloud Score+ masking, mask water pixels, and use **Sen's slope + Mann-Kendall** (`ee.Reducer.sensSlope`) instead of OLS.
8. **Land-cover fractions:** area-weighted (`ee.Image.pixelArea()`); mask low-confidence pixels.
9. **Report structure:** SEEA-EA Extent / Condition / Services sections.
10. **Agents:** PydanticAI instead of a hand-rolled loop; promptfoo for `make eval`; OTel → Postgres + Langfuse for traces; turn thinking off for JSON calls.
11. **Frontend versions:** decide Next 15.5 vs 16; pin TS 6.0.3 and ESLint 9.
12. **Attribution footer** on every report (Dynamic World, Copernicus, JRC, Hansen, OSM).

## 7. Open items to verify
- Nemotron model IDs, JSON-mode support, and `chat_template_kwargs` passthrough on Token Factory (needs an API key).
- The four unverified Costanza rows, the SoilGrids licence, and GEDI L4B v2.1 coverage.
- Earth Engine terms for a prize-bearing hackathon.
- ESVD written consent if we want ESVD-derived coefficients.
