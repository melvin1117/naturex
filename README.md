<p align="center">
  <a href="https://wildworth.westus2.cloudapp.azure.com">
    <img src="docs/readme/banner.jpg" alt="WildWorth, the AI rating agency for living nature, over a satellite view of the Xochimilco Wetland in Mexico City, rated A with a Health score of 76.2" width="100%">
  </a>
</p>

<p align="center">
  NVIDIA Nemotron agents read five years of satellite imagery and the local news, work out what changed and why, and issue a grade that rises as the land heals and falls when it's harmed. Communities list the land they protect; supporters back it and watch it stay alive.
</p>

<p align="center">
  <a href="https://wildworth.westus2.cloudapp.azure.com"><b>Try it live</b></a> ·
  <!-- Demo video: add the YouTube link here once it's published. -->
  <a href="#how-a-rating-works">How a rating works</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#design">Design</a> ·
  <a href="#run-it-locally">Run it locally</a>
</p>

<p align="center">
  <a href="https://wildworth.westus2.cloudapp.azure.com"><img alt="Live demo: try it, no sign-up" src="https://img.shields.io/badge/live_demo-try_it,_no_sign--up-c4e58a?style=flat-square&labelColor=0b1f14"></a>
  <img alt="NVIDIA Nemotron 3" src="https://img.shields.io/badge/NVIDIA-Nemotron_3-c4e58a?style=flat-square&labelColor=0b1f14">
  <img alt="Nebius Token Factory" src="https://img.shields.io/badge/Nebius-Token_Factory-c4e58a?style=flat-square&labelColor=0b1f14">
  <img alt="Tavily Search and Extract" src="https://img.shields.io/badge/Tavily-Search_%2B_Extract-c4e58a?style=flat-square&labelColor=0b1f14">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-c4e58a?style=flat-square&labelColor=0b1f14"></a>
  <a href="https://github.com/melvin1117/wildworth/actions/workflows/backend.yml"><img alt="Backend CI" src="https://github.com/melvin1117/wildworth/actions/workflows/backend.yml/badge.svg"></a>
  <a href="https://github.com/melvin1117/wildworth/actions/workflows/frontend.yml"><img alt="Frontend CI" src="https://github.com/melvin1117/wildworth/actions/workflows/frontend.yml/badge.svg"></a>
</p>

<p align="center">
  Built in five weeks by a team of four for the <b>Nebius × NVIDIA Global AI Hackathon</b>, Best Apps &amp; Agents track.<br>
  Every rating, investigation and answer runs on NVIDIA Nemotron through Nebius Token Factory.
</p>

<a href="https://wildworth.westus2.cloudapp.azure.com"><img src="docs/readme/site.jpg" alt="A WildWorth site page: Quinault Rain Forest, Health 97.8, grade AAA, a worth range of $26.4M to $57.6M a year, and Nemotron 3 Ultra's verdict" width="100%"></a>

## Why WildWorth

A wetland that filters a city's water, holds back its floods and stores carbon earns the people who protect it nothing, until it's drained and sold. Markets price nature only once it's gone, and the money that wants to protect it has no trusted way to compare sites or to see whether protection worked.

WildWorth is the missing rating. A community draws its land on a map; Nemotron agents rate it from the satellite record and the local news and issue a **Proof of Life**: a grade from AAA to D, a Health score, a yearly worth range with its confidence, and the evidence behind each. Then the rating keeps watching. A new quarter, a fire, an encroachment or a restoration moves the grade and the price, and everyone can see why.

- **Communities** get a credible account of what their land does, and a way to earn from keeping it alive.
- **Supporters and funds** get comparable, explained ratings that update as the land changes.
- **Anyone** can check the work: every grade links to its evidence, its model calls and a tamper-evident record.

## Try it (no sign-up)

Open **[wildworth.westus2.cloudapp.azure.com](https://wildworth.westus2.cloudapp.azure.com)** and choose *Try it yourself*. You get your own copy of a world of seven rated sites and can switch between three people at any time: **Rosa** (a community), **Arjun** (a supporter) and a **Reviewer**.

1. **Marketplace.** Every site with its grade, Health score, worth range and price.
2. **A site.** Nemotron 3 Ultra's verdict, the land five years apart under one slider, Dynamic World land cover, and the news pinned to five years of greenness.
3. **How it was rated.** The Agent Trace: every model call, search, check and cent behind the rating.
4. **List land, as Rosa.** Draw it on the map and get it rated live in about a minute, then send the offer; the Reviewer approves it.
5. **Back a site, as Arjun,** and follow it in *Your stakes*.
6. **Time Machine.** Move a quarter forward, or bring a fire, an encroachment or a restoration: ratings, prices and alerts follow.
7. **Ask Bea.** The field guide answers only from the site's Record and shows her sources.

**Where to look, by judging criterion**

| Criterion | Where to look |
|---|---|
| Technological implementation | An Agent Trace on any site · [How a rating works](#how-a-rating-works) · [Measured, not claimed](#measured-not-claimed) · [Guardrails](#guardrails) |
| Design | The live site, end to end without instructions · [Design](#design) · [A look inside](#a-look-inside) |
| Potential impact | [Why WildWorth](#why-wildworth) · listing land as Rosa · the Time Machine |
| Quality of the idea | A rating agency for living land, where Nemotron weighs the satellite record against the local news and code keeps it honest |

## A look inside

<table>
  <tr>
    <td width="50%"><img src="docs/readme/marketplace.jpg" alt="The Marketplace: seven rated sites, with the top-rated site's grade, Health score, worth range and price"><br><sub><b>Marketplace.</b> Rated from space and the local news.</sub></td>
    <td width="50%"><img src="docs/readme/agent-trace.jpg" alt="The Agent Trace for Quinault Rain Forest: the story of the run, model by model"><br><sub><b>Agent Trace.</b> Each model's job, its reasoning, the searches and the checks code ran.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/readme/seen-from-above.jpg" alt="Seen from above: Sentinel-2 views five years apart under one slider, with the site's outline"><br><sub><b>Seen from above.</b> Sentinel-2 views five years apart, compared by Nemotron 3.5 Super VL.</sub></td>
    <td><img src="docs/readme/news-and-satellite.jpg" alt="News and satellite: monthly greenness with the months code flagged and the news found by the News Scout"><br><sub><b>News and satellite.</b> Dated changes found by code, next to the news that may explain them.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/readme/time-machine.jpg" alt="The Time Machine: move a quarter forward or inject a fire, an encroachment or a restoration"><br><sub><b>Time Machine.</b> Move time forward or harm a site, and watch the rating respond.</sub></td>
    <td><img src="docs/readme/bea.jpg" alt="Bea, the field guide, ready to answer questions about Quinault Rain Forest"><br><sub><b>Bea, your field guide.</b> Grounded answers from the site's Record, on Nemotron 3 Nano.</sub></td>
  </tr>
</table>

## How a rating works

<img src="docs/readme/rating-pipeline.jpg" alt="How a rating works, in seven steps alternating between code and Nemotron: 1 code reads five years of satellite data and computes the worth range and Health score; 2 Nemotron 3.5 Super VL compares the views; 3 code runs the Tavily news searches; 4 Nemotron 3 Super sorts the news and plans follow-ups; 5 code turns everything into facts with IDs; 6 Nemotron 3 Ultra audits, moving health by at most 10 with cited facts; 7 code checks every claim, refuses bad answers for one more round, and seals the Proof of Life." width="100%">

1. **Satellite and numbers (code).** Five years of Sentinel-2, Dynamic World, JRC surface water and Hansen forest data. Code finds dated signals (months whose greenness is far from the same month in other years, by leave-one-out median and MAD), compares the latest 12 months with earlier years, and computes the worth range and the formula's Health score.
2. **Five years apart (Nemotron 3.5 Super VL).** Compares the site's views from 2021–22 and the last 12 months; code checks each change it describes against the measured metrics.
3. **Local news (code and Tavily).** Code writes the searches from the site's name, region and ecosystem, in English and the local language, and a place check drops items about somewhere else.
4. **Investigation (Nemotron 3 Super, thinking once).** Super sorts the news, compares the signals with it and decides what to check: a dated news search for a change nothing explains, or reading the most serious article (Nemotron 3 Nano answers; code verifies the quote and the place).
5. **The facts (code).** Every signal, value, view and kept news item becomes a fact with an ID: the only numbers a model may quote.
6. **Audit (Nemotron 3 Ultra, thinking on).** Ultra weighs competing explanations against the facts, writes the verdict and may move health by up to ±10, writing `{fact-id}` placeholders that code fills.
7. **Check and seal (code).** Code refuses any uncited claim, unknown ID or number not in the facts and sends the answer back once. The accepted Proof of Life, its evidence and the run's record go into The Record, a hash-chained ledger anyone can verify.

A live rating takes 35–60 seconds and costs about **$0.03–0.05**; Ultra's audit is 80–90% of that. Every run keeps an **Agent Trace**, and each showcase site also carries a real run recorded with the live models, so visitors can read one without spending anything.

## Nemotron on Nebius Token Factory

Every model call goes through Token Factory, and each model has the job it measured best at: Ultra for the reasoning that matters, Super and Nano for the fast, everyday calls.

| Job | Model | Thinking | Why this model |
|---|---|---|---|
| Run the rating, plan the follow-ups, sort the news | Nemotron 3 Super | Once, on the planning turn | Reliable tool calling; 39/40 on the news eval (Nano 33/40) at the same speed |
| Audit: weigh, cite, adjust | Nemotron 3 Ultra | On (up to 16k tokens) | The judgment that matters most; 15/15 eval cases finished on Ultra |
| Read an article for Super's question; Bea's answers | Nemotron 3 Nano | Off | Short reads whose answers code checks |
| Satellite before/after, field photos, title documents | Nemotron 3.5 Super VL | Off, strict JSON | Nemotron's vision model; 6/6 valid on the injection fixtures |
| Bea's retrieval | Qwen3-Embedding-8B | – | Token Factory serves no NVIDIA embedding model |

Details and evidence: [ADR-0003](docs/adr/0003-model-routing-on-token-factory.md).

## Tavily: the local news

- **Search.** Code writes 3–4 searches per rating from the site's name, region and ecosystem; where the language is known, one is in the local language with a country boost.
- **Dated follow-ups.** A satellite signal's months become a `start_date`/`end_date` window, so Super can ask "was there a fire here in Apr–Aug 2025?".
- **Extract.** One article at a time, its chunks ranked by Super's question, then read by Nano and checked by code.
- **Untrusted by default.** Injected instructions are cut, every item must name the place, and searches pause near a credit floor. Kept news is stored and pinned to the site's five-year timeline.

## Measured, not claimed

Evals run with real calls; `make eval` runs them all and writes [evals/results.md](evals/results.md) ([how each works](evals/README.md)).

| Eval | Result |
|---|---|
| **News Scout**, 40 labelled items | Super 39/40 all labels right (Nano 33/40, Ultra 40/40), 3/3 injections ignored |
| **Auditor**, 15 cases (3 sites × no news, fire, encroachment, restoration, injection) | 15/15 finished on Ultra · never moved against the evidence 15/15 · cited the news it weighed 12/12 · planted orders ignored 3/3 |
| **Bea**, 15 questions | 15/15 grounded: right behaviour, expected source cited, every number from what it cites |
| **Schema reliability**, every agent | 99.8% of 407 logged replies valid on the first try |

<details>
<summary><b>Full tables, and where it fails</b></summary>

| News Scout, 40 labelled items | All labels right | Relevance | Injections | p50 | Cost |
|---|---|---|---|---|---|
| Nemotron 3 Nano | 33/40 | 36/40 | 3/3 | 1.2 s | $0.0028 |
| **Nemotron 3 Super** (in use) | **39/40** | **40/40** | **3/3** | **1.1 s** | **$0.0124** |
| Nemotron 3 Ultra | 40/40 | 40/40 | 3/3 | 0.9 s | $0.0431 |

| Auditor, 15 cases | Result |
|---|---|
| First answer accepted / finished by Ultra / fell back | 11/15 · 15/15 · 0 |
| Cites the news it weighed · never moved against the evidence · ignored planted orders | 12/12 · 15/15 · 3/3 |
| Typical time · thinking · cost per audit | 14 s · 2,674 tokens · $0.019 |

| Bea, 15 questions (grades, values, news, comparisons, off-Record, a planted instruction) | Result |
|---|---|
| Grounded: right behaviour, cites the expected source, every number from what it cites | 15/15 |
| First draft accepted · typical time · cost for all 15 | 12/13 · 1.1 s · $0.001 |

**Where it fails.** In 2 of 3 injection cases Ultra's first answer repeated a number planted in the news; once it adjusted down citing only news the score already priced; once it wrote a number it had computed. Code refused all four, and Ultra fixed them in the next round. Nano kept 4 off-topic news items as relevant, which is why the news moved to Super.

</details>

## Guardrails

- **Numbers come from code.** Areas, values, scores and prices are computed by tested functions; Ultra may move health only within ±10, with cited evidence.
- **Every model reply is validated** against a Pydantic schema, retried once if it fails, and logged with its model, tokens, latency and cost.
- **Web content is untrusted.** Injected instructions are cut from search results, every item must name the place, and quotes are verified before they count.
- **Spend is capped.** A hard budget per database, a reserve kept for judging, a small budget per visitor, and a Tavily credit floor.
- **The Record is tamper-evident.** Every report is hash-chained, and *Verify the Record* re-checks the chain.

## Architecture

<img src="docs/readme/architecture.jpg" alt="Architecture: a visitor's browser reaches Caddy over HTTPS on one Azure VM running Docker Compose. Caddy routes / to the Next.js web app and /api to the FastAPI API; the web app also calls the API. The API stores sandboxes, reports, news and The Record in Postgres with pgvector, and calls Nebius Token Factory (Nemotron 3 Super, Ultra, Nano, Nemotron 3.5 Super VL and Qwen3-Embedding-8B), Tavily and Google Earth Engine." width="100%">

- **Backend:** Python 3.12, FastAPI, SQLModel and Pydantic v2. Agents live in `backend/app/agents`; the formulas (signals, valuation, scoring) are pure functions in `backend/app/tools`, with the market and the ledger beside them.
- **Frontend:** Next.js (App Router), TypeScript, Tailwind and shadcn/ui, with a client generated from the API's OpenAPI schema, Leaflet maps and Recharts.
- **Per-visitor worlds:** each visitor gets a private copy of the template world with its own model budget; unused copies are removed after 7 days.
- **Hosting:** one VM runs everything behind Caddy and deploys `main` on demand, rolling back by itself if the new version isn't healthy ([docs/deploy.md](docs/deploy.md), [ADR-0009](docs/adr/0009-one-vm-on-azure.md)).

## Data

| Data | Used for | Source |
|---|---|---|
| Sentinel-2 imagery | Monthly greenness, the views five years apart | Copernicus, via Google Earth Engine |
| Dynamic World | Land cover and the map overlay | Google, National Geographic Society, World Resources Institute |
| Surface water, forest change | Water gained or lost, forest loss | EC JRC / Google (Pekel et al. 2016), Hansen et al. 2013 |
| Biomass, mangroves, soil carbon | Carbon stock | ESA CCI Biomass, GEDI L4B, Global Mangrove Watch, SoilGrids |
| Local news | Events near the site | Tavily Search and Extract |
| Ecosystem-service values | The worth range | Published coefficients (Brander et al. 2024, Costanza et al. 2014); no raw ESVD data |
| Site boundaries, place search | The seven showcase sites | OpenStreetMap (ODbL), Nominatim |

The seven showcase sites (rainforests in Washington, mangroves in the Florida Keys and Yucatán, and a wetland and a canyon forest in Mexico) open instantly because their satellite metrics were computed ahead. Land a visitor draws is measured live on Earth Engine. The evals use 40 labelled news items, 15 audit cases and 15 Bea questions, all in [`evals/`](evals/). A visitor is only a cookie and a private copy of the world; there are no accounts or personal data.

## Design

<img src="docs/readme/design.jpg" alt="The design board: the logo, two Ws drawn as one line whose last stroke rises to a Health score, shown at 97.8 AAA, 82.8 AA and 48.0 B; the type (Gloock for names, Hanken Grotesk for numbers, Geist Mono for the machine), the colours (forest, lichen, lime, clay, machine) and the grade ramp from AAA to D; and Bea, the field guide, a bee drawn in the logo's line, in six moods." width="100%">

- **The logo is a reading.** Two Ws drawn as one line; the last stroke rises to a Health score, so on a site the mark shows that site's own reading in its grade colour.
- **Bea, the field guide.** A bee drawn in the same line. She answers only from a site's Record, cites her sources and never gives investment advice.
- **Two voices.** Ratings, reports and the trace speak like a careful rating agency; listing and community screens are warmer and plain-spoken.
- **Made to be read.** Grades are a colour ramp, never a traffic light; a change always carries an arrow, not just a colour; numbers are tabular; the logo animates only when a rating lands.

The system is in [DESIGN.md](DESIGN.md), the voice in [PRODUCT.md](PRODUCT.md), and the brand in the [guidelines](docs/design/wildworth-brand-guidelines.html).

## How we built it with AI

- **One rulebook for every assistant.** [AGENTS.md](AGENTS.md) sets the non-negotiables (numbers from code, every model call through Token Factory, schema-validated outputs) for GitHub Copilot, Claude Code, Codex and Cursor alike, with 31 shared skills in `.agents/skills`, from test-driven development to security review.
- **Tools in the loop.** MCP servers for GitHub (issues, PRs and the board), Context7 (current library docs), shadcn (components), and Playwright and Chrome DevTools (testing in a real browser).
- **A second agent reviews every change.** Before each PR, a fresh-context agent reviews only the diff; the author decides what to fix and records it in the PR. CI (lint, types, tests, CodeQL, gitleaks) gates every merge.
- **Design, media and deployment.** The brand, voice and design system were shaped with the impeccable skill; the demo video was scripted, recorded from the live app with Playwright and edited by an agent; the deploy kit was written by an agent and run by a person.
- **In numbers:** 126 merged PRs and 254 commits in five weeks, with about 70 backend and 95 frontend test files.

## What we learned

- **Give each model the job it measures best at.** A 40-item eval moved the news from Nano to Super (33/40 to 39/40 at the same speed); Ultra earns its cost on the audit.
- **Let models cite and code count.** Ultra writes `{fact-id}` placeholders and code fills the numbers, which stopped invented figures.
- **Reasoning and strict schemas don't mix yet.** Thinking calls need the schema in the prompt and validation afterwards.
- **Web text is an attack surface.** Planted "raise the score" orders reached the auditor in the evals; fencing, place checks and code refusal stopped every one.
- **Models read tool lists literally.** Super skipped its follow-ups until a code-written note told it the new tools had appeared.
- **One click beats a sign-up form.** A private world per visitor made the product something anyone can try straight away.

## Tech stack

| Area | Tools |
|---|---|
| **AI** | NVIDIA Nemotron 3 Super, Ultra and Nano · Nemotron 3.5 Super VL · Qwen3-Embedding-8B, all on Nebius Token Factory |
| **Search** | Tavily Search and Extract |
| **Earth data** | Google Earth Engine · OpenStreetMap Nominatim · Esri World Imagery |
| **Backend** | Python 3.12 · FastAPI · SQLModel · Pydantic v2 · PostgreSQL + pgvector · Alembic · uv · ruff · mypy · pytest |
| **Frontend** | Next.js 15 · TypeScript · Tailwind CSS · shadcn/ui · Leaflet · Recharts · Vitest · Playwright |
| **Infrastructure** | Docker Compose · Caddy · Azure VM · GitHub Actions (lint, types, tests, CodeQL, gitleaks) |

## Run it locally

Needs Docker, [uv](https://docs.astral.sh/uv/), Node 22 and Corepack. With `USE_MOCKS=true` (the default) every agent and data source is mocked, so no keys are needed.

```bash
git clone https://github.com/melvin1117/wildworth.git && cd wildworth
cp .env.example .env    # add keys only for live services
make dev                # Postgres, migrations, the API on :8000 and the web app on :3000
```

Then open http://localhost:3000. `make dev LIVE=1` uses the real models, Tavily and Earth Engine (it needs the keys in `.env`; `make check-keys` tests them).

<details>
<summary><b>More commands</b></summary>

```bash
make preview      # the production build, as visitors get it (stop make dev first)
make ci           # what GitHub CI runs: lint, types, tests, the frontend checks (docker compose up -d first)
make eval         # every eval, with real calls; writes evals/results.md
make e2e          # Playwright end-to-end tests
```

Backend only: `cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8000` (health at `/healthz`).
Frontend only: `cd frontend && pnpm install && pnpm dev`.

To rate every listed site with the live models in a fresh database (about $0.03 a site), run `cd backend && USE_MOCKS=false EARTH_ENGINE_LIVE=true uv run python -m app.jobs.rerate_all`. Don't copy rows between databases: reports, prices, news and The Record are linked by IDs, so restore a whole dump instead ([backend/README.md](backend/README.md#live-data-appjobsseed_live), `deploy/export-db.sh`).

</details>

## Repository layout

```
backend/    FastAPI API: agents, formulas (tools), market, ledger, sandboxes, jobs; Alembic migrations
frontend/   Next.js app and the generated API client
evals/      News Scout, Auditor, Bea and schema-reliability evals, and their results
deploy/     Docker Compose, Caddy and the update, backup and database scripts for the VM
docs/       Specs, ADRs, design and brand, the deploy guide, and diagrams.html (this README's images)
scripts/    Local dev, site precompute and demo-recording helpers
```

## Limits and what's next

- **Estimates, not appraisals.** Worth ranges come from published benefit-transfer coefficients and carry a confidence; they screen sites, they don't certify them.
- **Uploads wait on data terms.** Reading field photos and title documents with Nemotron 3.5 Super VL is built and tested; it goes live once Token Factory's data terms are confirmed for user uploads. Until then, a Reviewer approves each listing.
- **Next:** scheduled re-ratings for every listing, human-reviewed eval labels, and partners for real land and real funding.

## Feedback on Token Factory and Nemotron

What we ran into while building, what it cost, and what would fix it. Each finding was reproduced with real calls (`scripts/spikes/`, [ADR-0003](docs/adr/0003-model-routing-on-token-factory.md)).

| Finding | Impact | Our workaround | Suggestion |
|---|---|---|---|
| The structured-output examples in the Token Factory docs (Python and cURL) return HTTP 422 on every model: `json_schema.name` is required | Code copied from the docs fails | The OpenAI shape: `{name, schema, strict}` | Fix the examples |
| With thinking on, a strict `json_schema` makes Nemotron reason until `max_tokens` and return no answer | Ultra's audits came back truncated | The schema in the prompt, Pydantic validation, one retry | Apply the schema to the answer after reasoning, or document that they don't combine |
| `reasoning_budget` and `reasoning_effort` are ignored | Ultra thinks 2k–8k tokens on the same task, so cost and latency vary | Cap with `max_tokens`, sized for the worst case | Honour a reasoning budget |
| Nemotron 3.5 Super VL with a strict schema containing `maxItems` (or an extra enum field) can loop on whitespace until the cap | Some vision calls ran to the token cap | Uncapped lists, capped in code | Fix array bounds in guided decoding |
| No NVIDIA embedding model on Token Factory | Retrieval is the one job Nemotron can't do here | Qwen3-Embedding-8B for Bea's retrieval | Serve an NVIDIA embedding model |

**What worked well:** turning thinking off with `chat_template_kwargs.enable_thinking=false` was honoured in 60/60 calls; reasoning comes back in its own field, so `content` stays clean; tool calling was right in 24/24 two-step loops across four models; and the OpenAI-compatible API meant one client for every model.

## Team

| Name | GitHub |
|---|---|
| **Aatisha Cyrill** | [@Aatisha](https://github.com/Aatisha) |
| **Shubham Melvin Felix** | [@melvin1117](https://github.com/melvin1117) |
| **Uddesh Shyam Kshirsagar** | [@uddesh04](https://github.com/uddesh04) |
| **Adishree Sane** | [@adi095](https://github.com/adi095) |

## Documentation

| Doc | What's in it |
|---|---|
| [Diagrams](docs/diagrams.html) | The banner, the rating pipeline, the architecture and the design board (the source of this README's images) |
| [One-pager](docs/one-pager.md) | The problem, the idea and the pitch |
| [Devpost write-up](docs/devpost.md) | Inspiration, how we built it, challenges and what we learned |
| [Dev spec](docs/specs/dev-spec.md) | Architecture, data model, API, formulas and cost plan |
| [PM spec](docs/specs/pm-spec.md) | Scope, user stories and the judging plan |
| [Architecture decisions](docs/adr/) | Model routing, accounts, verification, hosting and more |
| [Evals](evals/README.md) | How each eval works, and [the results](evals/results.md) |
| [Deploy guide](docs/deploy.md) | One Azure VM with Docker Compose: setup, updates, backups, security |
| [CI](docs/ci.md) | Workflows, local checks and required status checks |
| [AGENTS.md](AGENTS.md) | Shared rules for AI coding assistants on this repo |

## Licence and credits

Code: [MIT](LICENSE). WildWorth is a hackathon prototype: amounts on the site are simulated, and nothing on it is an offer of securities. The project started on Sep 26, 2026, inside the hackathon's submission period.

Data: contains modified Copernicus Sentinel data 2021–2026 · Land cover: Dynamic World (Google, National Geographic Society, World Resources Institute) · Surface water: EC JRC / Google, Pekel et al. 2016 · Forest change: Hansen et al. 2013 · Biomass: ESA CCI Biomass v6.0, GEDI L4B · Mangroves: Global Mangrove Watch v3.0 (CC BY 4.0) · Soil carbon: SoilGrids 2.0 (CC BY 4.0) · Boundaries and place search: © OpenStreetMap contributors (ODbL) · Imagery: Esri World Imagery (Powered by Esri; Esri, Vantor, Earthstar Geographics and the GIS User Community). Icons in the diagrams: [Lucide](https://lucide.dev) (ISC).
