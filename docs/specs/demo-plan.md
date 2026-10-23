# NatureX — Demo & Judge Experience Plan

> Related: [pm-spec.md](./pm-spec.md) · [dev-spec.md](./dev-spec.md) · [one-pager.md](../one-pager.md) · [diagrams.html](../diagrams.html). The judge story (§3) is built; the video (§4) is not yet.

**Core idea: build the guided tour once, use it twice.** Judges click through it live, and the YouTube video is a recording of the same tour, so the two never drift apart.

---

## 1. How judging works (from the hackathon rules)
- Judging is **online, Dec 1–15, 2026**. There's no live pitch; judges review entries whenever they like.
- Judges **may** test the app but "are not required to". Many will only watch the **video (< 3 min)** and read the text.
- The app must stay **free and testable until judging ends**, with login credentials in the testing instructions if login is needed.
- The video must show the app actually running, with **no third-party trademarks or copyrighted music** without permission.

## 2. Three ways judges experience NatureX
| # | Channel | Audience | Priority |
|---|---|---|---|
| A | **3-minute YouTube video** | Every judge | 🔴 Most important |
| B | **Hosted app in Judge Mode**: one link, no signup | Judges who click around | 🔴 Must be flawless |
| C | **Local run** (`docker compose up`) from GitHub | Technical judges (NVIDIA, Nebius) | 🟡 Must work; README quick start |

---

## 3. Judge Mode: "Story Mode"

> **As built (Oct 22): the story at `/judge`.** One full-screen story on the hero wetland, on live satellite imagery, then the judge's own sandbox. Every part is skippable ("Skip to your sandbox", or Esc). It opens on the problem and lets a bar at the bottom carry the argument: **land health → rating → price a unit → community fund**.
> 1. **Opening:** the map flies from Mexico City to the wetland, then draws its boundary. *This wetland is alive. Keeping it that way pays its community nothing.*
> 2. **Measure:** the wetland's recorded real run, step by step on the map:
>    - Super plans the work;
>    - Earth Engine's land cover sweeps in under a scan line, with five years of greenness;
>    - Tavily's real news items appear;
>    - Super VL's views five years apart slide across the map (then draggable);
>    - Ultra gives its verdict, with its citations checked by code.
>
>    Health and grade fill the bar.
> 3. **Fund:** the rating sets the price. Arjun backs 100 units, and the fund counts up: the community is paid without selling.
> 4. **Watch:** a simulated encroachment appears on the north edge. The bar drops to BBB, the price falls and Arjun gets an alert. A simulated restoration takes it back up to AA.
> 5. **Trust:** a five-entry Nature Ledger. Try to edit the downgrade into an AA: the chain shows where it broke.
> 6. **Your turn:** each choice starts a no-sign-up demo session (`POST /demo/start`) and lands in the right app: rate the wetland live (as Rosa, opening its Agent Trace), back a community (as Arjun), move time forward (as the admin), or run a community. The demo bar then switches persona in the same sandbox (`POST /demo/persona`) and links back to the story.
>
> Every number comes from `GET /story`: the product's own rating, market and ledger code over committed data. Simulated steps are labelled. The AI steps quote the recorded run, which is labelled with its date. In the sandbox, ratings run live.
>
> The sections below are the original plan, kept for reference; the scripted 10-chapter tour (§3.3) still exists but is no longer linked from `/judge`.

### 3.1 Judge landing `/judge` (no sign-up)
> The product has real accounts and two apps, Steward and Exchange ([ADR-0005](../adr/0005-accounts-roles-and-two-apps.md)). Judge mode is a fast way *into* those real flows, not a separate product.

- **One click to explore:** *Explore as a community steward* (opens Steward), *Explore as an investor* (opens Exchange) or *Explore as the platform admin* (opens `/admin`). Each click starts a **demo session** with a **private sandbox**: its own copy of the demo world with every persona pre-created, so judges never affect each other or the live world.
- ▶ **Guided tour** (optional overlay, ~7 min): one story across all personas.
- **Create a real account:** for judges who want to try real sign-up in the live world.
- Devpost and the README link straight to `/judge`; no shared passwords are published.

### 3.2 Demo bar and persona switcher (demo sessions only, instant)
| Persona | Role | What the judge experiences |
|---|---|---|
| 🏘️ **Rosa, community steward** | Lists the wetland | Registration, drawing the land, receiving IPO money, stewardship tips |
| 💼 **Arjun, investor** | Buys shares | Marketplace, compare, buy, portfolio, alerts, Copilot |
| 🛰️ **NatureX AI** ("under the hood") | Rating engine | Live view of every agent, model call, formula and ledger entry |
| 🎛️ **Time Machine** (narrator) | Advances the story | Next quarter; inject fire, encroachment or restoration |

### 3.3 Tour chapters (with a progress bar)
| Chapter | Persona | Judge does | Wow moment |
|---|---|---|---|
| 1. Register | Rosa | Fills a prefilled community form (editable) in the Steward app | Community registered in 10 seconds |
| 2. List the land | Rosa | Watches the boundary draw itself, or draws their own | Map zooms to the Xochimilco wetland |
| 3. AI rates it | 🛰️ | Clicks **Rate** | Agent pipeline lights up live: Super plans → satellite → valuation → Tavily news → Ultra audits; report card revealed, grade stamps in |
| 4. IPO | Rosa | Clicks **Use sample documents (demo)**, watches the verification checklist pass, then sets shares offered and % retained on the Steward IPO screen | "How this listing was verified" is visible, not a black box; IPO price formula shown step by step |
| 5. Invest | Arjun | Switches to the Exchange, browses, compares, buys 100 shares | **Split screen:** Arjun's cash goes down, Rosa's community wallet (Steward home) goes up |
| 6. Time passes | 🎛️ | "Next quarter" | Restoration detected → new report → price rises |
| 7. Bad news | 🎛️ | "Inject: factory encroachment" | 🔔 Phone-style alert for Arjun, grade A → BBB, price drops; Rosa gets stewardship actions |
| 8. Ask why | Arjun | Asks the Copilot "Why did it drop?" | Answer cites the report and the news link |
| 9. Trust | 🛰️ | **Verify ledger**, then **Tamper** | ✅ turns ❌: tamper-evident history |
| 10. Under the hood | 🛰️ | Opens Agent Trace and eval results | Every Nemotron model with tokens and latency; quality scores |
| Finish | All | Summary card | "What you just saw" in 5 bullets, with links to the repo, video and architecture |

**Who may act (T57, ADR-0005 §3):** the backend enforces the role matrix in sandboxes too. Chapter 3 (**Rate**) must run as Rosa (her community's listing) or the demo admin persona; chapters 6–7 (**Time Machine**, inject) and 9 (**Tamper**) need the demo admin persona (`persona_key = admin`, an admin only inside its own sandbox). The 🛰️ and 🎛️ chapters therefore switch to the demo admin; demo investors (Arjun, Mia) get 403 `admin_only` for all three. The demo admin can't trade (403 `admins_cannot_trade`), and Rosa can't buy her own community's units (`insider_trading_blocked`), so chapter 5 stays Arjun's.

### 3.4 Interaction mechanics
- **Spotlight overlay:** dims the page except the element to click, with a short hint.
- **Two-layer hints** on every step: 💡 *Why this matters* (product) and ⚙️ *Tech behind it* (model, formula, API call).
- **"Do it for me"** auto-plays a step for judges in a hurry.
- **"Live" badge** on steps that really call Nemotron or Tavily, so real AI is distinguishable from cached results.
- **"Under the hood" drawer:** can stay open and streams what each click does technically (endpoint, model, tokens, latency, ledger hash).
- **Skip, back, resume later**, plus **Reset my demo**.
- **Free libraries:** Driver.js or react-joyride (MIT) for tours; Framer Motion for animations.

### 3.5 Reliability and cost safeguards
| Problem | Solution |
|---|---|
| Judges affect each other or the live world | Each demo session gets its own sandbox world: `world_id` on every tenant table (users, communities, members, sessions, assets, holdings, orders, prices, events, reports, alerts, ledger), composite foreign keys so rows can't link across worlds (ADR-0005), plus Reset my demo |
| Credit costs | Demo sites use **cached real ratings** (browsing is free), and each shows a **recorded real run** (verdict, Agent Trace, follow-ups) labelled "Recorded" until it is rated live; Time Machine uses a short live Auditor call; "Rate your own land" limited to **2 live runs per visitor**; global `LLM_BUDGET_USD` cap |
| Free host asleep | GitHub Actions `/healthz` pings every few hours; "Waking up… ~30 s" screen; re-check everything before Dec 1 |
| Credits run out during judging | Reserve ~40% of the budget for Dec 1–15; at the cap, live steps fall back to cached results with a clear notice |
| Earth Engine slow or down | "Live satellite service busy; showing a nearby cached example" instead of an error |
| Judge unsure what to do | Guided tour + Devpost testing instructions (§6) |

---

## 4. The 3-minute YouTube video
### 4.1 Story structure (target 2:50, hard limit 3:00)
| Time | Scene | Criterion proved |
|---|---|---|
| 0:00–0:15 | Hook: wetland beside factories, *"The bees never sent an invoice."* | Impact |
| 0:15–0:35 | Problem → idea: *"What if nature were a listed company, with an AI rating agency?"* | Quality of idea |
| 0:35–1:15 | Rosa lists the land → live pipeline animation; a caption names each Nemotron model as it runs | **Technological implementation** |
| 1:15–1:40 | Report card: grade, value range, confidence; *"Every number is formula-based; the AI explains and audits."* | Technology + trust |
| 1:40–2:05 | Arjun buys; split screen shows the community funded without selling its land | Design + impact |
| 2:05–2:30 | Time Machine: restoration ↑, encroachment ↓, alert, Copilot explains | Design + idea |
| 2:30–2:45 | Ledger verify and tamper; eval scores; "Runs on Nebius Token Factory" | Technology |
| 2:45–2:50 | Close: *"Keeping nature alive should pay more than destroying it."* | Impact |

### 4.2 Production approach (free tools)
1. **Script first:** ~380–400 words for 2:50 at a natural pace; every sentence earns its place.
2. **Storyboard** each shot.
3. **Script the browser with Playwright** for flawless, repeatable takes (perfect clicks, timing and data).
4. **Capture with OBS Studio:** 1080p/4K, 60 fps, browser zoom ~125%, clean profile (no bookmarks or notifications), cursor highlight.
5. **Voice-over recorded separately** with a decent mic; clean up in **Audacity**.
6. **Edit in DaVinci Resolve** (free): zoom-ins on key UI, captions naming each model as it fires (e.g. "Nemotron 3 Ultra: Auditor"), smooth transitions, split screen for the two personas.
7. **Captions:** burned in, plus YouTube subtitles (generate locally with Whisper, then correct).
8. **Rules:** no third-party logos (don't film the logo-based architecture tab); no copyrighted music (none, or a clearly licensed track); only our own UI and footage. Mentioning NVIDIA, Nebius and Tavily by name is fine.

### 4.3 Pre-publish checklist
- [ ] Under 3:00, public, link works in a private browser window
- [ ] Title, description (links to repo, live demo, Devpost), chapter timestamps, clean thumbnail
- [ ] Watched on a phone and a laptop
- [ ] Tested with 2–3 people new to the idea: after one viewing, can they explain it? If not, rework the script.

---

## 5. Local run for technical judges (README quick start)
```bash
git clone https://github.com/melvin1117/naturex && cd naturex
cp .env.example .env        # add a Token Factory key and a Tavily key
docker compose up           # http://localhost:3000, 3 demo sites preloaded
```
Without keys the app runs in clearly labelled **mock mode**. The hosted Judge Mode is always the live version.

## 6. Devpost "Testing instructions" template
> **Try it:** https://naturex-demo… (no login needed)
> 1. Click **Start judge tour** (~5–7 minutes).
> 2. Key moments: **Agent Trace** (live Nemotron calls), **Time Machine → Inject encroachment**, and the **Copilot**.
> 3. Optional: **Rate your own land** runs a live satellite + AI rating (2 per visitor).
> 4. First load may take ~30 s to wake up. **Reset my demo** restores your sandbox.
> Everything is play money; nothing is a real security.

## 7. When we build it
- Design the **sandbox (`world_id`)** and the **tour step system** in week 1; every screen needs stable anchor points for spotlight hints.
- The tour's autoplay path doubles as the **Playwright script for the video** and as an **E2E test** in CI.
