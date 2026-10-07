# Implementation Plan: NatureX (hackathon build)

> Task list: [todo.md](./todo.md). Specs: [pm-spec](../docs/specs/pm-spec.md) · [dev-spec](../docs/specs/dev-spec.md) · [demo-plan](../docs/specs/demo-plan.md). **Tasks are tracked in [GitHub Issues](https://github.com/melvin1117/naturex/issues):** 6 module epics (#1–#6) with 76 task sub-issues (#7–#65, plus #97–#111 from ADR-0005 and #113–#114 from ADR-0006), labelled `week:N`, `owner:X`, `size:X`, `priority:X`, `module:X`.

## Overview
Build the NatureX PoC in 5 weeks: a community lists land, Nemotron agents rate it from satellite data and news, investors trade play-money shares in a per-visitor sandbox, and ratings update as nature changes. Every Friday has a demo gate from `pm-spec.md` §8. Only the money is simulated; every AI step is real.

**Dates:** Mon Sep 28 → submit **Thu Oct 29** (deadline Fri Oct 30, 10:00 PT). **Feature freeze Fri Oct 23**; the last week (Oct 26–29) is **demo and presentation only**.

## Re-plan (Sun Oct 4): one week behind
Week 1 ended with 3 of 17 tasks done (T04, T06, T07). **The Oct 23 freeze and Oct 29 submission stay fixed.** To recover:

1. **Monday AM, everyone: T01** (accounts, credits, keys). It heads the longest remaining chain (12 tasks), because the Nemotron spike (T02) and the Earth Engine spike (T03) need keys.
2. **T05 frontend skeleton moves from D3 to D1.** D1 owns the API, T05 blocks T08 (the API contract), and D3 had 5 week-1 tasks.
3. **Scope:** T37 report diffs and T40 photo evidence drop to *only if ahead* (nothing depends on them). T41 revenue split stays: T38 and T44 need it, and it drives the portfolio "impact" moment in the demo.
4. **Fri Oct 9 gate = the original week-1 gate, run locally:** one site goes list → rating → report page with a real Nemotron-written summary on a laptop (Docker Compose). No cloud yet; T20 deploy waits until hosting is chosen.

**Week of Oct 5, in order:**
| Who | Sequence |
|---|---|
| D1 | T05 frontend skeleton → T08 API contract + generated client → T16 market engine |
| D2 | T03 Earth Engine spike → T11 hero-site precompute → T15 scoring |
| D3 | T02 Token Factory spike → T09 LLM client → T10 live AI summary → T12 bare report page |
| PD | P01 brief → P02 flows → P03 wireframes + P04 design system → P05 hi-fi key screens |

Pick tasks from [task-map.html](./task-map.html) (🟢 = every dependency done). Weeks 2–4 below keep their content. Anything not done by its Friday gate rolls into the next sprint, and the next *Should* item is cut first.

## Re-plan (Tue Oct 6): real accounts, roles and two apps ([ADR-0005](../docs/adr/0005-accounts-roles-and-two-apps.md))
The judge tour is a showcase; the product needs real flows. New tasks **T54–T68** (#97–#111), all *Must*. The quarterly revenue split (D4, T41, already merged) also becomes *Must*.

| Owner (suggested; AI-assisted) | New tasks |
|---|---|
| D1 | T54 accounts and sessions → T56 communities, treasury and tenant invariants → T68 authorization policy → T57 enforcement on every route |
| D2 | T67 ledger privacy (ready now) → T58 listing lifecycle → T59 IPO launch → T60 live rating for new listings |
| D3 | T66 auth hardening (CSRF, rate limits, pruning); T55 demo sessions; T69 listing verification ([ADR-0006](../docs/adr/0006-listing-verification.md)) |
| PD (+D1) | T61 sign-in → T62 two app shells → T65 `/judge` → T63 Steward home, T64 IPO screen, T70 verification screens |

**Two chains converge on T46 (E2E):**
- **Backend (now the longest chain):** T54 → T56 → T68 → T58 → T59 → T69 → T70 → T46. T58 also needs T19, so T14/T15 → T19 matter here too.
- **Frontend:** P04 → T21 → T61 → T62 → T33 → T45. **T21 is now the biggest single risk;** pair on it if it slips.

| Week | D1 | D2 | D3 | PD |
|---|---|---|---|---|
| 2 (now) | **T54** | T67, then T19 once #94/#95 merge | (agent work) | P02/P03 updated for two apps, sign-in, Steward home, judge landing |
| 3 | T56 → T68 → T57 | T58 → T59 | T66, T55, plus agent work | T21 → T61 → T62 → T65; T33 moves into Steward |
| 4 | Wire T63/T64/T70 with PD | T60 | T69, agent work | T63, T64, T70; T45 tour on top of T65 |

**Cut order if behind:** K5 delete account → community stewards (owner-only stays) → the AI document extraction in T69 (keep the deterministic checks, reviewer decision, ledger entry and public panel) → T60 live rating (fall back to the curated sites and mark new listings "awaiting satellite data").

## Team and ownership
| Who | Role | Owns (long-term) | Weeks 1–2 focus | Weeks 3–5 focus |
|---|---|---|---|---|
| **PD** | Product designer + frontend | UX, visual design, frontend quality, judge tour, video | Flows, wireframes, design system; then builds UI | UI build, tour, polish; week 5 video and presentation lead |
| **D1** | Platform & market | Repo/CI, DB schema, API, market engine, ledger, sandbox, deploy | Foundations, contract, market | Ledger, SSE, sandbox, jobs, deploy; **~50% frontend wiring with PD** |
| **D2** | Geo & rating data | Earth Engine, demo sites, valuation, scoring, confidence | Satellite pipeline, valuation, scoring | Map overlays, validation, photo evidence, revenue/impact; E2E test and tour support |
| **D3** | AI agents | Token Factory client, agents, trace, Copilot, evals | Model spike, LLM client, News Scout, FE skeleton | Auditor, Orchestrator, Copilot, evals, README |

**Your proposal (3 devs on backend, PD on design) holds for week 1**, with two adjustments:
1. **Backend devs set up the frontend plumbing in week 1** (Next.js skeleton, generated API client, a bare report page), so PD can start building screens in week 2 without setup work.
2. **From week 3, D1 spends about half their time on frontend wiring** (API calls, SSE, state) while PD focuses on visual quality, the tour and polish. With one person on all frontend work, Design (25% of the score) would become the bottleneck.

## Working model
- **Contract first (days 1–3):** agree the DB schema, the OpenAPI routes (served with mock data) and the agent output schemas early. Everyone then builds in parallel against mocks (`USE_MOCKS=true`).
- **Vertical slices:** each task leaves the app working. Wire features end to end early, then deepen them.
- **Risky things first:** the Token Factory model check (T02), Earth Engine access (T03) and a first deploy (T20) all happen in weeks 1–2.
- **Rituals:** a 10-minute written standup each day, a Monday 30-minute plan, a Friday gate demo, and at most 2 tasks in progress per person. PRs stay small with 1 review; `main` is protected.
- **Spare capacity:** D3 is lighter in week 2 (start T26 Auditor early, once T15 lands). D2 picks up photo evidence and revenue in week 3, and the E2E test and tour support in week 4.
- **AI assistants:** every task follows [AGENTS.md](../AGENTS.md) and the matching skill (e.g. `incremental-implementation`, `test-driven-development`, `impeccable`).

## Architecture decisions (decided in T06: see [ADR-0001](../docs/adr/0001-stack-and-versions.md) and [ADR-0002](../docs/adr/0002-repo-layout.md))
Open items from [research.md](../docs/research.md) §6:
- Next.js 15.5 or 16 (pin TypeScript 6, ESLint 9)
- **PydanticAI** vs a plain SDK loop
- Valuation coefficients: **Brander 2024 + Costanza 2014** instead of raw ESVD
- Carbon formula (roots + SoilGrids soil carbon)
- NDVI method (Cloud Score+, Sen's slope)
- Satellite platform: Earth Engine primary
- Embeddings: decided in ADR-0003 (`Qwen3-Embedding-8B` on Token Factory, no local models)
- Tracing: OpenTelemetry → Postgres + Langfuse
- Evals: promptfoo
- Hosting: decided in T20 from the ranked options in dev-spec §21 (Nebius Serverless → Azure with approved credits → free tiers)

## Modules at a glance
```
  🧱 FOUNDATION ──► 🛰️ SATELLITE & RATING ──► 🤖 AI AGENTS ──► 📈 MARKET & TRUST
  (repo, DB, API)    (real numbers)             (Nemotron)       (trading, ledger,
        │                                                          sandbox, alerts)
        └──────────────────────► 🎨 DESIGN & UI ◄──────────────────────┘
                                        │
                                        ▼
                                🎬 DEMO & PRESENTATION
```
| Module | Owner | Tasks |
|---|---|---|
| 🧱 Foundation (#1) | D1 (+D3) | T01, T04–T08, T20, T42 |
| 🛰️ Satellite & rating (#2) | D2 | T03, T11, T13–T15, T19, T35–T37 |
| 🤖 AI agents (#3) | D3 (+D2) | T02, T09, T10, T24–T28, T39, T40, T47 |
| 📈 Market & trust (#4) | D1 (+D2) | T16, T17, T29–T31, T38, T41 |
| 🎨 Design & UI (#5) | PD (+D1) | P01–P06, T12, T18, T21–T23, T32–T34, T43–T45, T48 |
| 🎬 Demo & presentation (#6) | All | T46, T49–T53 |

**How a task gets its week:** (1) it goes in the earliest week after the tasks it needs; (2) risky checks go early; (3) whatever a Friday gate needs goes in that week; (4) about 3–5 small or medium tasks per person per week.

## Task index by week
Full details, acceptance criteria and dependencies are in [todo.md](./todo.md).

### Week 1 · Foundations and walking skeleton (Sep 28 – Oct 2)
| PD | D1 | D2 | D3 |
|---|---|---|---|
| P01 Product brief & voice · P02 User flows & IA · P03 Wireframes · P04 Design system v1 · P05 Hi-fi key screens | T04 Backend skeleton & CI · T06 ADRs · T07 DB schema v1 · T05 Frontend skeleton (moved from D3) · T08 API contract + client | T03 Earth Engine spike · T11 Hero-site precompute | T02 Token Factory spike · T09 LLM client · T10 AI summary · T12 Bare report page |

All: T01 accounts and credits (day 1).

**✅ Gate (Fri Oct 2):** one demo site goes list → (mock) rating → report page with a **real Nemotron-written summary**; CI green; flows, wireframes and tokens reviewed.

### Week 2 · Real data and the exchange (Oct 5 – Oct 9)
| PD | D1 | D2 | D3 |
|---|---|---|---|
| P06 Remaining hi-fi screens · T21 Design system in code · T22 Marketplace · T23 Asset page v1 | T16 Market engine · T17 Orders & portfolio API · T18 Trade panel & portfolio UI · T20 Deploy skeleton | T13 Other 2 sites + scenarios · T14 Valuation · T15 Scoring & confidence · T19 Deterministic rating → reports API | T24 News Scout · T25 News eval dataset |

**✅ Gate (Fri Oct 9):** real satellite metrics, $ ranges and a grade for all 3 sites in the UI; buy/sell works; the News Scout returns classified events; the skeleton is deployed.

### Week 3 · Live agents, ledger, trace (Oct 12 – Oct 16)
| PD | D1 | D2 | D3 |
|---|---|---|---|
| T33 Listing flow + rating progress · T34 Trace drawer & ledger tab | T29 SSE events · T30 Ledger · T31 Per-visitor sandbox · T32 Frontend data layer (FE pairing) | T35 Map overlays · T36 Polygon validation · T37 Report diffs · T40 Photo evidence · T41 Revenue split & impact | T26 Auditor · T27 Orchestrator · T28 Agent Trace API |

**✅ Gate (Fri Oct 16):** a full rating run is 100% live AI (Super → tools → Nano → Ultra), started from the UI; the trace drawer shows every step; the ledger verifies; listing works.

### Week 4 · Monitoring loop, Copilot, evals, deploy (Oct 19 – Oct 23)
| PD | D1 | D2 | D3 |
|---|---|---|---|
| T44 Copilot & impact UI · T45 Judge tour (lead) · T48 UI polish pass | T38 Time Machine, re-rating & alerts · T42 Demo deploy · T43 Time Machine & alerts UI | T46 E2E demo test · T45 tour support | T39 Copilot RAG · T47 Eval harness |

**✅ Gate (Fri Oct 23) = feature freeze:** the public URL runs the whole 3-minute demo script; `make eval` and the E2E test are green; UI polish done.

### Week 5 · Demo & presentation only (Oct 26 – Oct 29)
No new features: only the video, the Devpost presentation, docs, judging readiness and fixes for bugs found while recording.

| PD | D1 | D2 | D3 |
|---|---|---|---|
| T50 Demo video (lead) · T53 Presentation kit | T51 Judging readiness + fixes | T50 support · T53 support | T49 README, Devpost text & feedback |

All: **T52 submit on Devpost (Thu Oct 29).**

## Critical path
T02/T03 → T09/T11 → T14/T15/T24 → T26 Auditor → T27 Orchestrator → T38 Time Machine → T42 deploy → T45 tour → T46 E2E → **freeze Fri Oct 23** → T50 video → T52 submit.

Since ADR-0005, two more chains converge on T46: accounts (T54 → T56 → T68 → T58 → T59 → T63/T64) and the app shells (T21 → T61 → T62 → T33/T65). A slip on T26/T27 (week 3) threatens everything. **Fallback:** the fixed Python pipeline (dev-spec §7.1) keeps the demo working with the same agents.

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Nemotron model IDs / JSON mode / thinking behave differently than documented | High | T02 spike on days 1–2; fallback tiers; thinking off for JSON calls |
| Earth Engine onboarding or quota slow | High | T03 spike on day 1; precompute and cache demo sites; Planetary Computer fallback |
| PD is the only frontend person | High | Backend devs do FE plumbing (T05, T12, T18); D1 ~50% on FE from week 3; shadcn blocks |
| Credits run out | Medium | `LLM_BUDGET_USD` cap, Nano for dev, caching, precomputed sites |
| Free hosting sleeps during judging (Dec 1–15) | Medium | Deploy early (T20); keep-alive pings; checks before Dec 1 (T51) |
| Scope creep | Medium | Must/Should/Could labels; freeze Fri Oct 23; week 5 reserved for demo and presentation |
| Accounts and authorization (ADR-0005) add 15 tasks 2.5 weeks before the freeze | High | Owner-only communities for the *Must*; cut order in the Oct 6 re-plan; `security-and-hardening` review on every auth PR; the curated demo flow keeps working throughout |
| A security bug in auth leaks across worlds or lets roles escalate | High | Composite foreign keys across worlds, a pure policy with a full matrix test, a route-inventory test, cross-world 404 tests |
| ADR decisions change the formulas, so the worked-example numbers change | Low | Update the Rating Engine page, specs and tests together (T06 follow-up) |

## Open questions
1. GitHub handles for each role (for CODEOWNERS and assignment)?
2. Which design tool: Figma (free Starter plan) or Penpot (open source)?
3. Does anyone attend a Builders & Brews city event (City Winner prize, extra credits)?
4. ~~Where to track tasks~~ Decided: GitHub Issues + the generated task map (`tasks/task-map.html`), with the Project board mirroring status (`make board`).
