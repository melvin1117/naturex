# NatureX — Product Requirements (PM Spec)

| | |
|---|---|
| **Product** | NatureX — AI rating agency & sandbox exchange for living nature |
| **Event** | Nebius × NVIDIA Global AI Hackathon (Devpost) |
| **Track** | Best Apps & Agents |
| **Deadline** | **Fri Oct 30, 2026, 10:00 AM PT** (target internal submit: Thu Oct 29) |
| **Status** | Draft v1 |

> Related docs: [one-pager.md](../one-pager.md) · [dev-spec.md](./dev-spec.md) · [demo-plan.md](./demo-plan.md) · [research.md](../research.md) · [diagrams.html](../diagrams.html)

---

## 1. Background
Living ecosystems produce enormous value (water filtration, flood protection, carbon storage, biodiversity) that markets don't price, so the only monetisation path for landowners is extraction or sale. The Natural Asset Company (NAC) concept proposes turning ecosystem services into investable equity, but the bottleneck is **cheap, credible, continuous measurement**. NatureX uses NVIDIA Nemotron agents on Nebius Token Factory to automate that measurement, and wraps it in a familiar "stock exchange" experience to make nature investable and understandable.

## 2. Goals & non-goals
**Goals (hackathon)**
1. A community can list a real piece of land and receive an AI-generated rating + Ecological Performance Report in < 2 minutes (precomputed satellite data allowed).
2. Investors can discover, compare, buy and sell (play money) and see prices react to AI ratings and news.
3. The full lifecycle — list → rate → IPO → trade → re-rate → alert → explain — is demoable in < 3 minutes.
4. Meets every Devpost requirement and clearly showcases Nemotron + Token Factory (+ Tavily).
5. **Real flows, not only a tour** ([ADR-0005](../adr/0005-accounts-roles-and-two-apps.md)): people sign up, roles are enforced server-side, and there are two experiences: **Steward** for communities and **Exchange** for investors. Judges get a one-click demo session.

**Non-goals**
- Real money, real securities, KYC/AML, custody.
- Certified valuations or carbon-credit issuance.
- Global coverage: 3 curated demo sites carry the story. New listings are rated live with quotas (T60); a failed live run never shows another site's data in the live world.
- KYC, email verification, password reset by email, MFA (OAuth sign-in is a *Could*).
- Mobile-native apps (responsive web only).

## 3. Personas
| Persona | Description | Key need |
|---|---|---|
| **Rosa — community steward** | Leads a cooperative that owns a wetland near an industrial zone | Prove the wetland is worth more alive; attract funding without selling |
| **Arjun — impact investor** | Manages a small nature-focused fund | Trustworthy, comparable data; know when something goes wrong |
| **Mia — curious retail user** | Wants to "own a piece of the Amazon" | Simple UI, visible impact |
| **Platform admin** | NatureX operator | Run re-ratings, inject events, suspend abusive listings |
| **Judge** | Hackathon judge | See the whole story fast: one click, no sign-up |

### 3.1 Roles and access ([ADR-0005](../adr/0005-accounts-roles-and-two-apps.md))
- **Anyone** can browse the Exchange: marketplace, asset pages, reports, ledger.
- **Any signed-in user** can invest: buy and sell, portfolio, alerts, Copilot.
- **Community roles come from membership.** The **owner** registers the community, manages members and launches the IPO. **Stewards** manage listings and evidence. Members can't trade their own asset's shares.
- **Admins** run the Time Machine and moderation, inside their own world only.
- **Real accounts live in one live world.** Demo sessions get a private sandbox world with ready-made personas.

## 4. User stories & acceptance criteria

### Epic A — Listing (Community)
| ID | Story | Acceptance criteria |
|---|---|---|
| A0 | As Rosa, I create an account and register my community | Sign-up with email and password; I become the community's owner; the Steward app opens on an empty home with "List your land" |
| A1 | As Rosa, I draw my land on a map | Polygon tool; area shown in ha; rejects self-intersecting polygons, < 10 ha or > 50,000 ha, and overlaps with existing listings |
| A2 | I enter community details | Name, country, description, photo, total shares (default 1,000,000), community retained % (default 51%) |
| A3 | I submit for rating | Rating job starts; progress UI shows agent steps (satellite → valuation → news → evidence → audit) |
| A4 | I upload field evidence | Up to 5 geotagged photos (audio is post-hackathon); analysis appears in report; confidence increases |
| A5 | If not eligible, I get a stewardship plan | 3–5 concrete, location-specific recommendations |
| A6 | My listing moves through clear states | draft → rating → listed / needs evidence / ineligible; each state shows the next action; admins can suspend and resume; every change is in the ledger |
| A7 | I launch the IPO | Owner only, once the asset is listed: choose shares offered and % retained, see the price formula step by step, confirm; trading opens in the Exchange |
| A8 | I see what the community earns | Steward home shows the wallet, IPO proceeds, holders, quarterly payouts, alerts and stewardship actions |

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
| C6 | Insiders can't trade | Members of an asset's community get 403 `insider_trading_blocked` on that asset's orders; a holder can't be added as a member (409); admins and treasury accounts never trade |
| C7 | Browsing is open, trading needs an account | Anonymous visitors browse; buy/sell, portfolio and alerts ask them to sign in |

### Epic D — Monitoring & alerts
| ID | Story | Acceptance criteria |
|---|---|---|
| D1 | Assets are re-rated periodically | A scheduled job re-rates all assets; the demo "Time Machine" triggers it on demand |
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
| A0–A3, A6–A8, B1–B5, C1–C7, D1–D4, E1, **K1–K4** · Steward and Exchange apps · live rating of new listings (quota) · Time Machine · 3 real demo sites (cached satellite data) · **Nature Ledger** (F1–F2) · **Agent Trace** (G1) · **Eval harness** (G2) · **One-click judge demo sessions + optional tour** (J1–J2) · deployed (host per dev-spec §21) · CI with tests | A4 field evidence (**photos only**), B6 report diffs, E3 impact, K5 delete account, community stewards (more members than the owner) | OAuth sign-in, A5 stewardship plan, E2 compare, Spanish report, OpenTimestamps anchoring (F3) | Real money, tokens/blockchain trading, KYC, email verification and password reset by email, audio evidence, mobile app, PDF export |

### Epic F — Nature Ledger (tamper-evident records)
| ID | Story | Acceptance criteria |
|---|---|---|
| F1 | Every report, rating change, event and payout is appended to a hash-chained ledger | `hash = SHA256(canonical_json(entry) + prev_hash)`; append-only; no UPDATE/DELETE path in code |
| F2 | Anyone can verify an asset's history | Asset page shows "✅ History verified (n entries)" computed live via `/ledger/{asset_id}/verify`; demo shows a tampered row turning it ❌ |
| F3 *(could)* | Quarterly anchor to a public chain | Latest head hash timestamped via OpenTimestamps; proof file downloadable |

### Epic J — Judge experience (details in [demo-plan.md](./demo-plan.md))
| ID | Story | Acceptance criteria |
|---|---|---|
| J1 | Each judge gets a private sandbox in one click | `/judge` → "Explore as a community steward / an investor / the platform admin" starts a demo session with its own world (personas, holdings, demo assets) and opens the matching app; no sign-up; "Reset my demo" restores it; visitors never affect each other |
| J2 | A judge can follow an optional guided tour | A demo bar with a persona switcher (demo sessions only); the 10-chapter tour is an overlay on demo mode, with spotlight hints, "Do it for me" and Live badges; completes in ~7 minutes; "Create a real account" shows real sign-up |

### Epic K — Accounts and access ([ADR-0005](../adr/0005-accounts-roles-and-two-apps.md))
| ID | Story | Acceptance criteria |
|---|---|---|
| K1 | I sign up, sign in and sign out | Email + password; generic login errors; rate-limited; signing out ends the session immediately, open live streams included (registration enumeration is an accepted risk without email verification) |
| K2 | My session is safe | Server-side session in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; no tokens in browser storage; cross-site writes rejected |
| K3 | I can only do what my role allows | Every API route, reads included, checks the ADR-0005 matrix; 401 / 403 with a reason / 404 across worlds; a test fails if a route has no check; the database rejects rows that link across worlds |
| K4 | Each audience has its own app | Exchange at `/` and Steward at `/steward`, each with its own navigation; an app switcher for community members |
| K5 *(should)* | I can delete my account | Credentials and sessions deleted, name pseudonymised; market history stays consistent |

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
| **Technological implementation** | Well built; effective use of Token Factory + Nemotron | Nemotron models routed by task with eval-backed justification (Super, Ultra, Nano required; non-NVIDIA helpers only for vision and embeddings, ADR-0003); tool-calling orchestrator; schema-validated outputs; deployed demo with scheduled re-rating (Nebius Serverless if event credits); Tavily in the loop; hash-chained ledger; CI + tests | Agent Trace drawer open during rating; README eval + routing tables; architecture diagram |
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
| 3 — Real agents | Oct 10 – Oct 16 | Orchestrator tool-calling, Auditor (Ultra) with schema validation, Nature Ledger, Agent Trace, field-evidence photos, revenue split | **Full rating run is 100% live AI; trace drawer shows every step; ledger verifies** |
| 4 — Loop + deploy | Oct 17 – Oct 23 | Time Machine + events, re-rating job, alerts, Copilot RAG, judge tour, UI polish, demo deploy (host per dev-spec §21), eval harness | **Public URL runs the entire 3-min demo script; `make eval` green. Feature freeze Fri Oct 23** |
| 5 — Demo & presentation | Oct 24 – Oct 30 | **No new features:** demo video, Devpost page and presentation kit, README with eval/routing tables, feedback, judging readiness, bug fixes | **Submitted Oct 29** (1-day buffer) |

## 9. Submission checklist (Devpost)
- [ ] Working app uses ≥ 1 NVIDIA open model via **Token Factory** runtime calls (or Nebius AI Cloud compute); for our track, **Nemotron via Token Factory**, with Ultra for deep reasoning and Nano/Super for fast calls
- [ ] The judged demo makes **live** Token Factory calls (never `USE_MOCKS=true`)
- [ ] Public GitHub repo with **OSS license visible in About** (MIT / Apache-2.0)
- [ ] README: setup, run steps, **how Nemotron + Token Factory + other Nebius tools are used**
- [ ] Hosted demo URL + test credentials (if any), **free to use and kept running until judging ends (Dec 15, 2026)**
- [ ] Demo keeps working through judging: free hosts woken or kept alive; `LLM_BUDGET_USD` leaves credits for judges
- [ ] YouTube demo video **< 3 min**, public, shows the app actually running; no copyrighted music and **no third-party trademarks/logos without permission** (don't film the logo-based architecture tab)
- [ ] Text description of features
- [ ] Track selected: **Best Apps & Agents**
- [ ] Feedback on Token Factory / AI Cloud / NVIDIA models (also targets *Most Valuable Feedback*)
- [ ] Tavily runtime call present (for *Best Use of Tavily*)
- [ ] Every third-party API/dataset used within its terms (Earth Engine non-commercial, ESVD licence and citation, Tavily); raw ESVD data not redistributed in the repo unless its licence allows **(verify)**
- [ ] Explanation that the project was created during the submission period (after Aug 26, 2026)
- [ ] City event association if attending one

## 10. Risks & mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Earth Engine slow / quota during demo | Broken demo | Precompute & cache demo sites; live mode is optional |
| Valuation credibility challenged | Impact score | Show ranges + confidence; cite ESVD; say "screening estimate" |
| Looks like a securities/crypto scheme | Judge skepticism | Sandbox banner, no tokens, "rating agency first" pitch |
| LLM hallucination in reports | Trust | Auditor only reasons over structured tool outputs; every claim cites a metric or URL; JSON schema validation |
| Token Factory credits run out | Blocked dev | Nano for dev loops; Ultra only in Auditor; cache responses |
| Scope creep | Late submission | MoSCoW, freeze Fri Oct 23, week 5 demo-only |
| Free host sleeps or pauses during judging (Dec 1–15) | Judges see a broken demo | Health-check pings, a wake-up note in the testing instructions, the backup video; re-check before Dec 1 |
| Trademarked logos or music in the video | Rule violation | Use only our own UI and footage; no third-party logos or music |

## 11. Open questions
1. Team size and who attends a city event (affects City Winner eligibility)?
2. Earth Engine vs Planetary Computer — who has access already?
3. Hero site final choice and whether we localise the report to Spanish.
