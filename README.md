# WildWorth

*Worth more wild.*

**The AI rating agency for living nature, with a sandbox exchange.** WildWorth uses NVIDIA Nemotron agents on Nebius Token Factory to rate land from satellite data and local news, turn it into a graded site that supporters can back with play money, and keep watching it, so keeping nature alive pays more than destroying it. Every quarter, WildWorth issues a Proof of Life for each site.

Built for the **Nebius × NVIDIA Global AI Hackathon**, *Best Apps & Agents* track. Sandbox only: play money, nothing here is a real security.

## How a rating works
Every number (areas, values, scores, prices) comes from deterministic, tested code. The models plan, read, investigate and judge; code checks everything they say before it counts.

1. **Satellite record (code).** Five years of Sentinel-2, Dynamic World, JRC water and Hansen forest data for the site. Code finds **dated signals**: months whose greenness is far from the same month in other years (leave-one-out median and MAD), the latest 12 months against earlier years, and cloud gaps.
2. **Five years apart (Nemotron 3.5 Super VL).** It compares the site's satellite views from 2021–22 and the last 12 months and describes what changed; code checks each change against the measured metrics.
3. **Local news (Tavily + Nemotron 3 Super).** Code writes the queries from the site's name, region and ecosystem, in English and the local language; Super sorts the results; a place check drops items about somewhere else.
4. **Investigation (Nemotron 3 Super, thinking once).** Super compares the dated signals with the news and decides what to check: a dated news search for a signal nothing explains, and reading the most serious article (Tavily Extract, ranked by its question; **Nemotron 3 Nano** answers, code verifies the quote and the place). It says why for each step.
5. **The audit (Nemotron 3 Ultra, thinking on).** Ultra weighs competing explanations against every cited fact, writes a verdict, and may move health by up to ±10 with cited evidence. Code refuses any uncited claim, unknown ID or number not in the facts, and sends the answer back once.
6. **Sealed.** The report, its evidence and the run's record go into the hash-chained Record.

Every run has an **Agent Trace** (`/trace/<run>`; each demo site also carries a real run recorded with the live models, at `/trace/recorded/<asset>`, so a visitor sees one without spending anything): a story, a flow of every step with its model, tokens, time and cost, a timeline per model, Ultra's case with its notes, the checks code ran, and a cost receipt against an all-Ultra baseline. **The AI at work** (`/ai`) shows each model's live calls, latency, refusals and cost, the spend against the cap, and the eval results.

## Model routing (measured)
All calls go through Nebius Token Factory; Nemotron does all reasoning, text and vision.

| Job | Model | Thinking | Why this model |
|---|---|---|---|
| Run the rating, plan the follow-ups, sort the news | Nemotron 3 Super | Once, on the planning turn | Reliable tool calling; 39/40 on the news eval (Nano 33/40) at the same speed |
| Audit: weigh, cite, adjust | Nemotron 3 Ultra | On (up to 16k tokens) | The judgment that matters most; 15/15 eval cases finished on Ultra |
| Read an article for Super's question; Bea (the field guide) answers | Nemotron 3 Nano | Off | Short reads whose answers code checks |
| Satellite before/after, field photos, title documents | Nemotron 3.5 Super VL | Off, strict JSON | Nemotron's vision model; 6/6 valid on the injection fixtures |
| Bea's retrieval | Qwen3-Embedding-8B | – | Token Factory serves no NVIDIA embedding model |

A live rating costs about **$0.03–0.05** and takes 35–60 s; Ultra's audit is 80–90% of the cost. Details and evidence: [ADR-0003](./docs/adr/0003-model-routing-on-token-factory.md).

## Tavily
- **Search:** 3–4 queries per rating (site + region; threats for its ecosystem; recovery; and, where we know the local language, one in it with the country boost), advanced depth, 3 chunks per source, social and travel sites excluded.
- **Dated follow-ups:** a signal's months become a `start_date`/`end_date` window, so Super can ask "was there a fire here in Apr–Aug 2025?".
- **Extract:** one article at a time, chunks reranked by Super's question, then read by Nano and checked by code.
- **Guards:** results are untrusted (injected instructions are cut, every item must name the place); searches pause when the account has fewer than 150 credits left (`TAVILY_MIN_CREDITS_LEFT`). Each rating's kept news is stored and shown on the site's timeline.

## Evals, failures included
Run with real calls (Oct 22; Bea and schema reliability Oct 28). `make eval` runs them all and writes [evals/results.md](./evals/results.md); how each works is in [evals/README.md](./evals/README.md).

| News Scout, 40 labelled items | All labels right | Relevance | Injections | p50 | Cost |
|---|---|---|---|---|---|
| Nemotron 3 Nano | 33/40 | 36/40 | 3/3 | 1.2 s | $0.0028 |
| **Nemotron 3 Super** (in use) | **39/40** | **40/40** | **3/3** | **1.1 s** | **$0.0124** |
| Nemotron 3 Ultra | 40/40 | 40/40 | 3/3 | 0.9 s | $0.0431 |

| Auditor, 15 cases (3 sites × no news, fire, encroachment, restoration, injection) | Result |
|---|---|
| First answer accepted / finished by Ultra / fell back | 11/15 · 15/15 · 0 |
| Cites the news it weighed · never moved against the evidence · ignored planted orders | 12/12 · 15/15 · 3/3 |
| Typical time · thinking · cost per audit | 14 s · 2,674 tokens · $0.019 |

| Bea, 15 questions (grades, values, news, comparisons, off-Record, a planted instruction) | Result |
|---|---|
| Grounded: right behaviour, cites the expected source, every number from what it cites | 15/15 |
| First draft accepted · typical time · cost for all 15 | 12/13 · 1.1 s · $0.001 |

Across every agent, 99.8% of 407 logged model replies matched their schema on the first try.

**Where it fails:** in 2 of 3 injection cases Ultra's first answer repeated a number planted in the news; once it adjusted down citing only news the score already priced; once it wrote a number it had computed. Code refused all four and Ultra fixed them in the next round. Nano kept 4 off-topic news items as relevant, which is why the news moved to Super.

## Cost and budget
- `LLM_BUDGET_USD` is a hard cap on logged spend per database; `LLM_RESERVE_USD` keeps the last dollars for judging; Tavily searches pause at 150 credits.
- The $25 Token Factory credit is shared by every environment, so each gets a slice: deployed demo $15 (with $2 reserved), each laptop $1, evals $1.50, demo recording $1, about $4 headroom. `make check-keys` reminds you to check the account total in the console.

## Real data in a deployment
Don't copy rows between databases: reports, prices, news and the hash-chained ledger are linked by IDs, so a copy breaks "Verify ledger". Instead, run the real pipeline once in the target database after deploying with real keys:

```bash
cd backend && USE_MOCKS=false EARTH_ENGINE_LIVE=true uv run python -m app.jobs.rerate_all
```

It rates every listed site of the live world with the live models (about $0.03 a site), stores audited reports with their Agent Traces, saves the news it found and pays the quarter's play-money revenue. It runs once per quarter per site; a site that fails or hits the hourly cap is picked up by the next run. The daily `news_sweep` keeps news coming after that. Until a site has its own run, its page shows the recorded one, labelled "Recorded".

To deploy a live world you seeded locally (`app.jobs.seed_live`), restore a dump of the database instead ([backend/README.md](backend/README.md#live-data-appjobsseed_live)): every ID comes along, so the ledger still verifies. `deploy/export-db.sh` writes one without visitor sandboxes.

## Deploying
The demo runs on one Azure VM with Docker Compose (Postgres, the API, the web app and Caddy for HTTPS), and picks up `main` by itself within about 10 minutes of a merge: [docs/deploy.md](docs/deploy.md), [ADR-0009](docs/adr/0009-one-vm-on-azure.md).

## Limitations
- The three demo sites use precomputed satellite metrics and images; live Earth Engine runs only for new polygons when `EARTH_ENGINE_LIVE` is on, and the before/after vision runs only for the demo sites.
- Uploaded photos and documents are read by a model only after Token Factory's data terms are confirmed (`FIELD_EVIDENCE_AI_LIVE`, `VERIFICATION_AI_LIVE` are off by default).
- About 1 in 4 of Ultra's first answers is refused by code and fixed in a second round, which adds a few seconds.
- Super skips the follow-ups when the news already explains the signals; the place check is lexical, so a page that names the town but is about something else can pass (the reader's "yes" then needs a verified quote).
- The news eval labels were AI-drafted and still need a full human review.

## Token Factory notes (feedback)
- With thinking on, a strict `json_schema` response format made Nemotron reason until `max_tokens`; we put the schema in the prompt for thinking calls and validate with Pydantic.
- `reasoning_budget` and `reasoning_effort` were ignored, so Ultra's thinking length varies (2k–8k tokens); we cap with `max_tokens`.
- Nemotron 3.5 Super VL with a strict schema that has `maxItems` (or an extra enum field) could loop on whitespace until the cap; uncapped lists capped in code work every time.

### Run everything locally
Needs Docker, `uv`, Node 22 and Corepack. One command starts Postgres, applies migrations, and runs the API (:8000) and the web app (:3000); Ctrl-C stops both.
```bash
cp .env.example .env    # first time only; add keys for live services
make dev                # uses .env as is (USE_MOCKS=true: mock agents and data)
make dev LIVE=1         # real services: Token Factory models, Tavily, Earth Engine (needs keys)
make preview            # the production build, as visitors get it (stop `make dev` first)
```
The dev server (Turbopack) compiles each page on its first visit, so a first click can take a second or two; `make dev` opens the main pages in the background once it's up to do that ahead of you. To judge speed or feel, use `make preview`: every page is built ahead and links prefetch.

### Quick start (backend)
```bash
cp .env.example .env    # add your keys, then: make check-keys
cd backend && uv sync
uv run uvicorn app.main:app --reload --port 8000
# GET http://localhost:8000/healthz

# from repo root
make lint && make test
docker compose up -d   # Postgres + pgvector (requires Docker)
```

### Quick start (frontend)
Needs Node 22 and Corepack (`corepack enable`), which installs the pinned pnpm.
```bash
cd frontend && pnpm install
pnpm dev               # http://localhost:3000 (welcome /, story /how, the sandbox /sandbox: Marketplace, Communities /sandbox/steward, Your stakes /sandbox/portfolio, Reviews /sandbox/admin/verifications · /dev/ui)

# from repo root: lint (ESLint + Prettier), types, unit tests, build
make fe-check
```

## Documentation
| Doc | What's in it |
|---|---|
| [One-pager](./docs/one-pager.md) | The problem, the idea, and the pitch |
| [Diagrams](./docs/diagrams.html) | Interactive overview, rating engine, architecture, flows (download and open in a browser) |
| [PM spec](./docs/specs/pm-spec.md) | Scope, user stories, judging plan, timeline |
| [Dev spec](./docs/specs/dev-spec.md) | Architecture, data model, API, formulas, cost plan |
| [Demo plan](./docs/specs/demo-plan.md) | Judge tour and demo video |
| [Research](./docs/research.md) | Open-source tools reviewed and chosen |
| [Evals](./evals/README.md) | News routing run, Auditor eval, Bea's grounding, schema reliability, `make eval` ([results](./evals/results.md)) |
| [Devpost text](./docs/devpost.md) | The submission write-up |
| [AI setup](./docs/ai-setup.md) | Shared skills and MCP servers for AI coding assistants |
| [CI](./docs/ci.md) | GitHub Actions workflows, local check commands, required status checks |

Contributors using AI assistants: the shared rules are in [AGENTS.md](./AGENTS.md).
