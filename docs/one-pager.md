# WildWorth — The AI rating agency for living nature

*Worth more wild.* (Brand: [wildworth-brand-guidelines.html](design/wildworth-brand-guidelines.html).)

**Nebius × NVIDIA Global AI Hackathon** · Track: **Best Apps & Agents** · Built on **NVIDIA Nemotron via Nebius Token Factory** + **Tavily**

---

## The problem
> "The bees never sent an invoice."

Nature delivers ~$100T/yr of services — clean water, flood protection, carbon storage, pollination — but markets only see **dead** nature (timber, minerals, land for factories). Communities protecting wetlands and forests get one tempting offer: *sell once*. Meanwhile, trillions in investor capital is earmarked for nature but has **no trusted way to see, compare or track** living ecosystems. Valuing a site today takes consultants, field surveys and months — and carbon-credit scandals made investors wary of unverifiable claims.

## The solution
**WildWorth turns any piece of living nature into a rated, trackable, investable asset — in minutes, with AI.**

1. **List** – A community draws its land on a map.
2. **Rate** – A team of Nemotron agents reads satellite data, values ecosystem services ($/yr with ranges), scans local news via Tavily, and writes an auditable **Ecological Performance Report** with a **grade (AAA–D)** and **confidence score**.
3. **Invest** – The asset "IPOs" on a sandbox exchange; investors buy shares.
4. **Monitor** – Scheduled jobs re-rate assets (satellite data quarterly, news daily). When nature heals, the grade and price rise; when a factory encroaches, investors get an alert and the price drops.

**Think: Moody's + a stock exchange — for wetlands, forests and reefs.**

## Who it's for
| User | Pain today | WildWorth gives them |
|---|---|---|
| 🏘️ Communities / landowners | Only way to monetise land is to sell or destroy it | A valuation + a path to recurring income for keeping nature alive |
| 💼 Impact investors | No trusted, comparable, continuously-updated data | Rated assets, live health, alerts, portfolio impact |
| 🏭 Companies (next phase) | Must disclose nature risk (TNFD) | Verified data on the ecosystems they depend on |

## Why AI — and why Nemotron on Nebius
| Agent | NVIDIA model (Token Factory) | Job |
|---|---|---|
| Rating Orchestrator | **Nemotron 3 Super** | Plans the rating run, calls tools |
| Auditor / Rating Analyst | **Nemotron 3 Ultra** | Deep reasoning: cross-checks evidence, flags greenwashing, grades, writes report |
| News Scout | **Nemotron Nano** + **Tavily** | Finds & classifies real-world events near the asset |
| Field Evidence | **MiniCPM-V** (perception) + **Nemotron 3 Ultra** (judgement) | Reads community photos (audio after the hackathon) |
| Bea, the field guide (was Copilot) | **Nemotron Nano** + RAG | Fast grounded Q&A |

The frontend runs on Vercel; the backend and database run on **Nebius Serverless** if event credits arrive, otherwise on team-approved Azure credits or free tiers (Hugging Face Spaces / Render + Supabase). All AI runs on Token Factory; re-rating and news sweeps run as scheduled jobs.

## What makes it different
- **Honest numbers** – every $ value has a low/mid/high range and a confidence score.
- **Always-on** – ratings update from satellites + news, not a one-off consultant report.
- **Community-first** – built for the people protecting the land, not just the investors.
- **Explainable** – every grade change links back to evidence (satellite deltas, news sources).
- **Tamper-evident** – every rating is written to a hash-chained *Record* (blockchain-style trust, no tokens or speculation).
- **Measured, not claimed** – an eval harness scores news classification, Auditor faithfulness and model routing (Nano vs Super vs Ultra); results published in the repo.

## Demo (3 min)
Xochimilco-style 500 ha wetland near Mexico City → AI rates it (Health 77.6, grade A, ~$11.7M/yr in services, 87% confidence) → IPO → judges buy shares → *Time Machine: +1 quarter* → restoration detected, price ↑ → *inject encroachment* → alert, grade A → BBB, price ↓ → Copilot explains why → portfolio shows impact (ha protected, t CO₂).

## Business model (post-hackathon)
Rating-as-a-service for funds & corporates · listing/verification fee per asset · data feed/API for investors & exchanges · TNFD disclosure add-on.

## Prize strategy
| Prize | Fit |
|---|---|
| **Grand / 2nd / 3rd** ($20k / $10k / $6k) | Eligible — strong on Impact & Idea |
| **Best Apps & Agents Track** (Jetson Orin Nano) | Primary track |
| **Best Use of Tavily** ($3k) | News Scout makes Tavily core to the product |
| **City Winner** ($500) | If a team member attends a Builders & Brews city event (e.g. Mexico City) |
| **Most Valuable Feedback** ($100) | Submit detailed Token Factory / Nemotron feedback |

> Rules: a project can win **one Overall OR one Track award, plus one Bonus award**.

## Where to read more
[diagrams.html](./diagrams.html) (the rating pipeline, architecture and design board) · [planning diagrams](./archive/planning-diagrams.html) (the original explainer) · [pm-spec.md](./specs/pm-spec.md) (scope & plan) · [dev-spec.md](./specs/dev-spec.md) (technical design) · [demo-plan.md](./specs/demo-plan.md) (judge tour & video).

## Honest limits
Sandbox with play money — **not** a securities offering. Valuations are screening estimates using published benefit-transfer coefficients (Brander et al. 2024 biome means in 2020 Int$ as the central and upper value, with an indicative low from the published median/mean ratios in Costanza et al. 2014; never raw ESVD data), not certified appraisals. Real-money trading would require licensed partners and regulation.
