# WildWorth: Devpost submission text

Draft for the Devpost form (Nebius × NVIDIA Global AI Hackathon, Best Apps & Agents). Every number here comes from a live run or an eval on Oct 22, 2026; update them if you re-run.

## Inspiration
A mangrove is worth more alive than cleared, but nobody prices that. Rating agencies and exchanges made other assets legible to investors; nature has no rating that updates as it heals or is damaged. We wanted an agent that reads the evidence the way a careful analyst would: the satellite record, the local news, and what each says about the other.

## What it does
A community lists its land. Nemotron agents rate it from five years of satellite data and local news, the rating becomes a play-money asset on a sandbox exchange, and it is re-rated as things change: a fire, an encroachment, a restoration.

Every rating is explained. The Agent Trace shows each model's job, its reasoning where it thought, the web searches and the articles it read, the checks code ran on every answer, and what it all cost. The site page shows five years of greenness with the dated changes code found, the news pinned on the same timeline, and the two satellite views five years apart under one slider.

## How we built it
- **Nemotron 3 Super** runs each rating with tool calls. On one turn it thinks: it compares the dated satellite signals with the news and decides what to check, a dated news search for a change nothing explains, or reading the most serious article. It also sorts the news (39/40 on our 40-item eval, against Nano's 33/40, at the same speed).
- **Nemotron 3 Ultra** audits with thinking on: it weighs two or three competing explanations against cited facts, writes a verdict, and may move health by up to ±10. Numbers come only from code: it writes `{fact-id}` placeholders that code fills.
- **Nemotron 3 Nano** answers Super's question about one article, and powers Bea, the field guide, who answers only from a site's Record.
- **Nemotron 3.5 Super VL** compares the site's Sentinel-2 views from 2021–22 and the last 12 months; code checks each change against the metrics before Ultra sees it.
- **Tavily Search** with local-language queries and `start_date`/`end_date` windows taken from the satellite signals; **Tavily Extract** with chunks ranked by Super's question.
- **Nebius Token Factory** serves every model through one OpenAI-compatible client with a hard spend cap, per-call logging and retries.
- FastAPI, SQLModel and Postgres; Next.js, Tailwind and shadcn/ui; Google Earth Engine for the satellite record; a hash-chained ledger for every report.

## Challenges we ran into
- With thinking on, a strict JSON schema made Nemotron reason until it ran out of tokens; we moved the schema into the prompt for thinking calls and validate with Pydantic.
- Super skipped its follow-ups in early runs. Its own notes showed why: it took the opening list of tools as final. A code-written note when the tools appear fixed it.
- Ultra sometimes repeats numbers from untrusted news or computes its own. Code refuses those answers and says exactly what to delete; the second round fixes it.
- The first news queries found fires in the wrong county. Queries now name the region and the ecosystem, and a place check drops items about somewhere else.

## Accomplishments that we're proud of
- On 15 audit cases (three real sites with no news, fire, encroachment, restoration and a planted "raise the score" order), every audit finished on Ultra, cited the news it weighed (12/12), never moved against the evidence (15/15) and ignored the planted orders (3/3).
- We publish the failures too: 4 of 15 first answers were refused by code (two repeated a planted number), and Nano's misses moved the news to Super.
- A live rating costs about $0.03–0.05; building and evaluating all of this used under $2 of our $25 Token Factory credit (as of Oct 22).

## What we learned
Give each model the job it is best at, and make every number come from code. The visible reasoning matters most where it changes a decision: Super's one planning turn and Ultra's audit.

## What's next
Field photos and title documents read by Super VL once Token Factory's data terms are confirmed, live Earth Engine for every new listing, more human-reviewed eval labels, and quarterly re-ratings with the news sweep.

## Built with
NVIDIA Nemotron 3 (Nano, Super, Ultra), Nemotron 3.5 Super VL, Nebius Token Factory, Tavily, Google Earth Engine, Sentinel-2 (Copernicus), Dynamic World, JRC Global Surface Water, Hansen Global Forest Change, OpenStreetMap Nominatim, FastAPI, PostgreSQL, Next.js, shadcn/ui, Recharts.
