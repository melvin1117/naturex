# NatureX — Product Requirements (PM Spec)

| | |
|---|---|
| **Product** | NatureX — AI rating agency & sandbox exchange for living nature |
| **Event** | Nebius × NVIDIA Global AI Hackathon (Devpost) |
| **Track** | Best Apps & Agents |
| **Deadline** | **Fri Oct 30, 2026, 10:00 AM PT** (target internal submit: Thu Oct 29) |
| **Status** | Draft v1 |

> Related docs: [one-pager.md](./one-pager.md) · [dev-spec.md](./dev-spec.md) · [diagrams.html](./diagrams.html)

---

## 1. Background
Living ecosystems produce enormous value (water filtration, flood protection, carbon storage, biodiversity) that markets don't price, so the only monetisation path for landowners is extraction or sale. The Natural Asset Company (NAC) concept proposes turning ecosystem services into investable equity, but the bottleneck is **cheap, credible, continuous measurement**. NatureX uses NVIDIA Nemotron agents on Nebius Token Factory to automate that measurement, and wraps it in a familiar "stock exchange" experience to make nature investable and understandable.

## 2. Goals & non-goals
**Goals (hackathon)**
1. A community can list a real piece of land and receive an AI-generated rating + Ecological Performance Report in < 2 minutes (precomputed satellite data allowed).
2. Investors can discover, compare, buy and sell (play money) and see prices react to AI ratings and news.
3. The full lifecycle — list → rate → IPO → trade → re-rate → alert → explain — is demoable in < 3 minutes.
4. Meets every Devpost requirement and clearly showcases Nemotron + Token Factory (+ Tavily).

**Non-goals**
- Real money, real securities, KYC/AML, custody.
- Certified valuations or carbon-credit issuance.
- Global coverage — 3 curated demo sites; live rating of user-drawn polygons is a *Could* (best-effort, falls back to cached sites).
- Mobile-native apps (responsive web only).

## 3. Personas
| Persona | Description | Key need |
|---|---|---|
| **Rosa — community steward** | Leads a cooperative that owns a wetland near an industrial zone | Prove the wetland is worth more alive; attract funding without selling |
| **Arjun — impact investor** | Manages a small nature-focused fund | Trustworthy, comparable data; know when something goes wrong |
| **Mia — curious retail user** | Wants to "own a piece of the Amazon" | Simple UI, visible impact |
| **Judge / Demo admin** | Hackathon judge | See the whole story fast |

## 4. User stories & acceptance criteria

### Epic A — Listing (Community)
| ID | Story | Acceptance criteria |
|---|---|---|
| A1 | As Rosa, I draw my land on a map | Polygon tool; area shown in ha; rejects self-intersecting polygons, < 10 ha or > 50,000 ha, and overlaps with existing listings |
| A2 | I enter community details | Name, country, description, photo, total shares (default 1,000,000), community retained % (default 51%) |
| A3 | I submit for rating | Rating job starts; progress UI shows agent steps (satellite → valuation → news → evidence → audit) |
| A4 | I upload field evidence | Up to 5 geotagged photos (audio is post-hackathon); analysis appears in report; confidence increases |
| A5 | If not eligible, I get a stewardship plan | 3–5 concrete, location-specific recommendations |

### Epic B — AI rating & report
| ID | Story | Acceptance criteria |
|---|---|---|
| B1 | System computes land cover mix | % per class (water, trees, flooded vegetation, grass, crops, shrub, built, bare) |
| B2 | System computes 5-yr health trend | NDVI trend slope & label (improving / stable / degrading) with chart |
| B3 | System estimates annual ecosystem value | Low / mid / high $/yr, broken down by service (carbon, water, flood, habitat, recreation) |
| B4 | System scans news | ≥ 1 Tavily query per asset; each event has title, URL, date, impact type, direction (+/−), severity (1–5) |
| B5 | Auditor issues rating | Health Score 0–100, grade AAA–D, confidence %, greenwashing flags, markdown report with cited evidence (formulas: dev-spec §7.4) |
| B6 | Reports are versioned | Each re-rating produces a new version; diff view shows what changed and why |

### Epic C — Exchange (sandbox)
| ID | Story | Acceptance criteria |
|---|---|---|
| C1 | As Arjun, I browse the marketplace | Cards show name, map thumbnail, price, 24h/quarter change, grade, trend, confidence; sort & filter |
| C2 | I buy / sell shares | Starting balance $10,000 play money; instant fill with small slippage; can't exceed balance/holdings |
| C3 | I see a live price chart | Price history with markers on report/news events |
| C4 | IPO proceeds go to community | Community wallet balance increases with each primary-share sale |
| C5 | Everything is labelled sandbox | Persistent "Sandbox — play money, not a real security" banner |

### Epic D — Monitoring & alerts
| ID | Story | Acceptance criteria |
|---|---|---|
| D1 | Assets are re-rated periodically | Serverless Job re-rates all assets; demo "Time Machine" triggers it on demand |
| D2 | Significant changes trigger alerts | Health Δ ≥ 5, grade change, or news severity ≥ 4 → alert to holders + community |
| D3 | Admin can inject events | Presets: fire, encroachment, drought, restoration success, new protection law |
| D4 | Quarterly revenue split (simulated) | Revenue = f(annual value); split community fund vs dividends; visible in portfolio |

### Epic E — Copilot & portfolio
| ID | Story | Acceptance criteria |
|---|---|---|
| E1 | I ask "why did this drop?" | Answer grounded in latest report/news, with citations; < 5 s response |
| E2 | I compare two assets | Copilot returns a side-by-side table |
| E3 | I see my impact | Portfolio shows ha protected, t CO₂ stored, $ services supported (pro-rata to holdings) |

## 5. PoC scope — "narrow product, deep engineering"
Principle: **one flawless end-to-end story on 3 real sites** beats a wide app with mocked internals. Every AI component must be *real* (live Token Factory calls, real satellite data, real Tavily results). Only the *money* is simulated.

| Must (PoC core) | Should | Could | Won't |
|---|---|---|---|
| A1–A3, B1–B5, C1–C5, D1–D3, E1 · Time Machine · 3 real demo sites (cached satellite data) · **Nature Ledger** (F1–F2) · **Agent Trace** (G1) · **Eval harness** (G2) · deployed on Nebius Serverless Endpoint + Jobs · CI with tests | A4 field evidence (**photos only**), B6 report diffs, D4 revenue split, E3 impact | Live rating of arbitrary user polygons (fallback to cached), A5 stewardship plan, E2 compare, Spanish report, OpenTimestamps anchoring (F3) | Real money, tokens/blockchain trading, full auth/KYC, audio evidence, mobile app, PDF export |

### Epic F — Nature Ledger (tamper-evident records)
| ID | Story | Acceptance criteria |
|---|---|---|
| F1 | Every report, rating change, event and payout is appended to a hash-chained ledger | `hash = SHA256(canonical_json(entry) + prev_hash)`; append-only; no UPDATE/DELETE path in code |
| F2 | Anyone can verify an asset's history | Asset page shows "✅ History verified (n entries)" computed live via `/ledger/{asset_id}/verify`; demo shows a tampered row turning it ❌ |
| F3 *(could)* | Quarterly anchor to a public chain | Latest head hash timestamped via OpenTimestamps; proof file downloadable |

### Epic G — Engineering visibility (for Technological Implementation score)
| ID | Story | Acceptance criteria |
|---|---|---|
| G1 | Judges can see how Nemotron is used | "Agent Trace" drawer per rating: each step, model, tokens, latency, tool calls, JSON output |
| G2 | We can prove AI quality | `make eval` runs: news-classification accuracy on ≥ 30 labelled items, Auditor faithfulness (numbers unchanged, all citations resolve), JSON-schema pass rate; results table in README |
| G3 | Model routing is justified | README table comparing Nano / Super / Ultra on our tasks (quality, latency, cost) from the eval run |

## 6. Demo sites (curated)
| Site | Why | Story role |
|---|---|---|
| Wetland near Mexico City (e.g. Xochimilco area) | Mirrors documentary; urban/industrial pressure | Hero asset — encroachment event |
| A mangrove forest (e.g. coastal Mexico or Sundarbans) | Very high blue-carbon & flood value | High grade, stable — "blue chip" |
| A degraded forest parcel under restoration | Improving trend | Price rises after Time Machine |

## 7. Success metrics
**Hackathon — each criterion is 25%. Every one needs a visible "proof moment":**
| Criterion (25% each) | What judges look for | Our proof | Demo / submission moment |
|---|---|---|---|
| **Technological implementation** | Well built; effective use of Token Factory + Nemotron | Nemotron models routed by task with eval-backed justification (Super, Ultra, Nano required; Nano Omni with photo evidence); tool-calling orchestrator; schema-validated outputs; Serverless Endpoint + Jobs actually running; Tavily in the loop; hash-chained ledger; CI + tests | Agent Trace drawer open during rating; README eval + routing tables; architecture diagram |
| **Design** | Complete, coherent product — *not* a PoC feel | Polished flows: list → rating progress → report → trade → alert → copilot; consistent UI; sandbox framing | 3-min video with zero dead ends; live URL that works without instructions |
| **Potential impact** | Credible, specific problem + real audience; demo actually solves it | Documentary case (wetland vs factories); Steward-vs-Sell numbers; uncertainty ranges; honest limits | Opening 20 s of video; one-pager; "what it would take to go live" slide |
| **Quality of idea** | Creative, non-obvious use of Nemotron; understands problem space | AI as a *rating agency* for ecosystems; news that moves "nature stocks"; Auditor that catches greenwashing | Encroachment event → grade A → BBB with cited evidence |

> Tie-break order follows criteria order, so **Technological implementation is the tie-breaker** — another reason to invest there.

**Product KPIs (post-hackathon):** time-to-rating, % ratings with confidence ≥ 70%, analyst agreement with expert valuations (±30%), assets listed, investor retention.

## 8. Timeline — 5 weeks with weekly demo gates
Each Friday the team must be able to run the gate demo end-to-end. If a gate slips, cut from *Should/Could*, never from the gate.

| Week | Dates | Build | ✅ Friday gate |
|---|---|---|---|
| 1 — Walking skeleton | Sep 26 – Oct 2 | Credits, repo (MIT, CI), docker-compose, schema, Token Factory client + call logging, mock tools, UI shell | **One hard-coded site goes list → (mock) rating → report page, with a real Nemotron call writing the summary** |
| 2 — Real data | Oct 3 – Oct 9 | Earth-obs pipeline for 3 sites (cached), valuation + scoring (unit-tested), market engine + IPO, marketplace & asset page | **Real satellite metrics + $ ranges + grade on all 3 sites; buy/sell works** |
| 3 — Real agents | Oct 10 – Oct 16 | Orchestrator tool-calling, News Scout (Tavily), Auditor (Ultra) with schema validation, Nature Ledger, Agent Trace | **Full rating run is 100% live AI; trace drawer shows every step; ledger verifies** |
| 4 — Loop + deploy | Oct 17 – Oct 23 | Re-rating as Nebius Serverless Job, Time Machine + events, alerts, Copilot RAG, field-evidence photos, deploy to Nebius, eval harness | **Public URL runs the entire 3-min demo script; `make eval` green** |
| 5 — Polish + submit | Oct 24 – Oct 30 | Feature freeze **Oct 26**; UX polish, README, eval/routing tables, video, Devpost text, feedback | **Submitted Oct 29** (1-day buffer) |

## 9. Submission checklist (Devpost)
- [ ] Working app uses ≥ 1 NVIDIA open model via **Token Factory** runtime calls (or Nebius AI Cloud compute)
- [ ] Public GitHub repo with **OSS license visible in About** (MIT / Apache-2.0)
- [ ] README: setup, run steps, **how Nemotron + Token Factory + other Nebius tools are used**
- [ ] Hosted demo URL + test credentials (if any)
- [ ] YouTube demo video **< 3 min**, public, no copyrighted music
- [ ] Text description of features
- [ ] Track selected: **Best Apps & Agents**
- [ ] Feedback on Token Factory / AI Cloud / NVIDIA models (also targets *Most Valuable Feedback*)
- [ ] Tavily runtime call present (for *Best Use of Tavily*)
- [ ] City event association if attending one

## 10. Risks & mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Earth Engine slow / quota during demo | Broken demo | Precompute & cache demo sites; live mode is optional |
| Valuation credibility challenged | Impact score | Show ranges + confidence; cite ESVD; say "screening estimate" |
| Looks like a securities/crypto scheme | Judge skepticism | Sandbox banner, no tokens, "rating agency first" pitch |
| LLM hallucination in reports | Trust | Auditor only reasons over structured tool outputs; every claim cites a metric or URL; JSON schema validation |
| Token Factory credits run out | Blocked dev | Nano for dev loops; Ultra only in Auditor; cache responses |
| Scope creep | Late submission | MoSCoW, freeze Oct 26 |

## 11. Open questions
1. Team size and who attends a city event (affects City Winner eligibility)?
2. Earth Engine vs Planetary Computer — who has access already?
3. Hero site final choice and whether we localise the report to Spanish.
