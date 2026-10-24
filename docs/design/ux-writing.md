# UX writing rules

> Part of P01 (#19). Product context: [PRODUCT.md](../../PRODUCT.md). Brand: [wildworth-brand-guidelines.html](./wildworth-brand-guidelines.html) (chapters 3, 9 and 10) and [bea-character.html](./bea-character.html). These rules apply to every string in the UI, the story, the tour and the demo video captions.

## 0. The name and the lines
- **WildWorth**: one word, two capitals, in running text, titles and the UI. Never Wild Worth, Wildworth, Wild-Worth, WILDWORTH in body text, or "WW".
- In a cold context, add a descriptor: "WildWorth · nature ratings".
- On first mention in any public place, the sandbox line: **"Sandbox · play money only"**.
- Lines that carry the brand:

| Context | Line |
|---|---|
| Tagline | Worth more wild. |
| Hero · judge invitation | The bees never sent an invoice. WildWorth works out what they're worth. |
| Video · the rating lands | Every quarter, WildWorth issues a Proof of Life. |
| Video close | Keeping nature alive should pay more than destroying it. |

- In a sentence: "WildWorth rates Xochimilco Wetland **A · 77.6 · Strong health**." · "WildWorth lowered Xochimilco Wetland to BBB: encroachment reported at the northern edge (12 Sep 2026)." · "Your wetland's first Proof of Life is in. It rates A."

## 1. Voice by surface
| Surface | Voice | Example |
|---|---|---|
| Proof of Life, grade, value, market, Agent Trace, The Record | **The rating voice:** precise, evidence-led, understated | "Health score fell from 74.2 to 63.8 after a reported 40 ha industrial expansion (source: 12 Sep 2026)." |
| Listing, community, the story, tour hints | **The steward voice:** warm and plain, celebrates stewards, still honest | "Draw the boundary of the land your community protects. We'll check the shape and area as you go." |

Everywhere:
- Short sentences, active voice, no exclamation marks in sober surfaces.
- Say what happened, then why, then what to do next.
- No hype words: *revolutionary, guaranteed, moon, returns, profit, opportunity, invest now*.
- Name the AI's role honestly: the AI **explains**, **classifies** and **audits**; formulas **compute**. Never "the AI valued your land".

## 2. Numbers
- **Values are always a range with a midpoint and confidence**, named the **Worth range**. Format: `Worth range $9.8M–$13.4M /yr · mid $11.7M · 87% confidence`. Never show a single value alone.
- Compact currency for large values (`$11.7M`, `$480K`); full precision only in tables and the trace (`$11,702,340`).
- Health score: one decimal (`77.6`), out of 100 when shown alone (`77.6 / 100`).
- Confidence: whole percent (`87%`). Below 70%, add the reason: "Low confidence (62%): few cloud-free images this year."
- Area in hectares with a thousands separator: `500 ha`, `12,400 ha`.
- Changes show direction in text, not only colour: `▲ 4.2%`, `▼ 1.8%`, or "up 4.2%".
- Dates: `12 Sep 2026`; relative time only for under 24 h ("3 min ago").
- Prices are play money and always labelled as such the first time they appear on a screen ("Sandbox price").

## 3. Grades
| Grade | Health score | Label (plain language) |
|---|---|---|
| AAA | ≥ 90 | Exceptional health |
| AA | ≥ 80 | Very strong health |
| A | ≥ 70 | Strong health |
| BBB | ≥ 60 | Good health |
| BB | ≥ 50 | Moderate health, some pressure |
| B | ≥ 40 | Under pressure |
| C | ≥ 30 | Serious pressure |
| D | < 30 | Critical |

- Always show the grade with its health score and plain label the first time on a screen: `A · 77.6 · Strong health`.
- Grade changes name both grades and the cause: "Downgraded A → BBB: encroachment reported on the northern edge."
- Never call a grade "good investment", "buy" or "sell". Grades describe the land's health, not a return.
- AI adjustments are explicit: "Auditor adjusted −6.0 (cited: event #3, NDVI trend)." Adjustments outside ±10 cannot happen; don't imply they could.

## 4. Sandbox wording
- The sandbox line: **"Sandbox · play money only."** It sits in the forest strip above every app's header, always, because "Exchange" alone could suggest a real securities exchange. The footer adds "Nothing here is a real security or investment." The trade panel repeats it near the confirm button; inside `/sandbox` the sandbox bar says it too (ADR-0007).
- Use "play money", "sandbox balance". Never "funds", "deposit", "withdraw", "wallet" for the user's own money.
- Mock or cached data is labelled: "Cached result (live service busy)" or "Mock mode: no API keys configured". Live AI steps get a **Live** badge.

## 5. Feature names
Name only what a judge should be able to repeat (guidelines chapter 9). Everything else stays plain.

| Name in the UI | Feature | How it appears |
|---|---|---|
| **Proof of Life** | Each quarter's rating report, with its seal (was "report") | Proof of Life · Q3 2026 · Ecological Performance Report |
| **Health score** | The 0–100 score behind every grade | A · 77.6 · Strong health |
| **Worth range** | The low, mid and high value per year | Worth range $9.8M–$13.4M /yr · mid $11.7M |
| **WildWatch** | Daily news sweeps, quarterly satellite checks and the alerts they raise | WildWatch · encroachment at the northern edge |
| **The Record** | The hash-chained ledger (was "Nature Ledger") | Verify the Record · Record broken at entry 14 |
| **Recovery plan** | Steps for a site that isn't eligible yet or was downgraded (was "stewardship plan") | Recovery plan · 4 actions |
| **Verified land** | The listing's ownership checks and badge | Verified land · How this listing was verified |
| **Agent Trace** | Every model call, formula and step | Open the Agent Trace |
| **Auditor** | The model that may move a score by ±10 with evidence | Auditor adjusted −6.0 (cited: event #3) |
| **News Scout** | Finds and classifies local news | News Scout found 3 events near the site |
| **Ask Bea** | Bea, the field guide, answering from the site's own Record (was "Copilot") | Ask Bea · Bea · your field guide |
| **Rated sites** | The marketplace page (was "Marketplace") | Rated sites · 3 sites |
| **Back this site** | Buying units, outside the trade panel | Back this site |
| **Your stakes** | The portfolio page | Your stakes · $10,000 play money |
| **Opening offer** | The IPO | Opened 5 Oct at $10.00 per unit |
| **Community fund** | The community's fund | Community fund · from supporters |
| **Time Machine** | The sandbox's narrator | Time Machine · next quarter |

- **Proof of Life** is written in full, always with a site and a quarter. Never "PoL" (it reads as crypto). "Ecological Performance Report" stays as its subtitle so finance readers see the lineage.
- **Apps** (routes unchanged: `/`, `/steward`, `/admin`): **Exchange** (always under the sandbox line), **Stewards** (was "Steward") and **Control room**.

## 6. Bea's voice
Bea is warm in tone and strict about facts. The personality changes how things are said, never what the numbers are.
- "Bzz" only to open a first answer, never mid-sentence or twice in a row.
- Every number comes from the Record, with its source tag.
- If the Record has no answer, she says so and suggests what to check: "I couldn't find that in the Record. The latest news check was 12 Sep."
- Never invest, returns, buy or profit. Play money is play money.
- In reports and the Agent Trace the rating voice leads; Bea is labelled with the model she runs on: "Bea (Nemotron 3 Nano)".
- Names in the UI: the button **Ask Bea**; the panel title **Bea · your field guide**, subtitle **Answers only from this site's Record**; thinking: "Bea is reading the Record…"; waking: "Bea is waking up…".

## 7. Vocabulary (softened market terms)
The API and database keep their names (`shares`, `ipo`, `orders`, `community_wallet`). The UI uses the terms below. Market terms appear **only inside the trade panel**, with sandbox framing.

> **Status: proposed.** Review in the P01 PR; change the table, not individual screens.

| API / spec term | UI term outside the trade panel | Inside the trade panel |
|---|---|---|
| asset | **site** ("Xochimilco Wetland site") | site |
| share(s) | **stake** / "units of stake" | units |
| IPO | **Opening offer** ("Opened 5 Oct at $10.00 per unit") | opening offer |
| buy / sell | **Back this site** / **Reduce stake** | Buy units / Sell units |
| order | action ("Your stake was added") | order |
| price | **stake price** | price per unit |
| market / exchange | **Rated sites** (the page); **Exchange** only as the app's name, with the sandbox line | |
| portfolio | **Your stakes** (page title), route stays `/portfolio` | |
| holdings | stakes | |
| community wallet | **Community fund** | |
| ledger | **The Record** | |
| report | **Proof of Life** (the quarterly report) | |
| value range | **Worth range** | |
| Copilot | **Bea** (**Ask Bea**) | |
| IPO proceeds | **from supporters** ("What supporters paid for units in the opening offer") | |
| launch the IPO | **Open to supporters** (the steward's next step); the screen's button stays **Launch opening offer** | |
| retained stake / retained shares | **the units your community keeps** | units kept |
| retained-stake dividends (treasury) | **payouts on the units you kept** ("Payouts on kept units" where space is short) | |
| investor | **supporter** (Arjun's persona label stays "investor") | |
| fair value per share | fair stake price | fair price per unit |
| P&L | change in value (play money) | P&L (play money) |

Say and don't say, everywhere:

| Concept | Say | Don't say |
|---|---|---|
| What the land provides | worth, value, services | returns, profit, yield to you |
| Supporting a site | back this site, your stakes | invest, buy now, opportunity |
| The money | play money, sandbox balance | funds, deposit, withdraw, wallet |
| Listing launch | opening offer, open to supporters | IPO (outside the trade panel) |
| The AI's role | reads, classifies, explains, audits | the AI valued your land |
| Wild | alive and able to renew itself | untouched by people |
| Any number | $9.8M–$13.4M /yr · mid $11.7M · 87% confidence | a single value on its own |

## 8. Errors, empty and waiting states
- Say what happened in plain words, then the fix. No codes unless in the trace.
  - Polygon too small: "This area is 6 ha. Sites need at least 10 ha."
  - Overlap: "This boundary overlaps the Xochimilco Wetland site. Adjust the edge to continue."
  - Not enough play money: "You have $420 of play money. This needs $1,000. You can buy up to 41 units now."
- When fewer units would go through, say how many and offer them as a one-tap fix that changes the field, never one that places the order: **Change to 41 units**. The number is the API's (the quote's `max_qty`, or the units held), never estimated in the browser.
- A refused order says "Nothing was traded."; a refused quote doesn't (nothing could have been).
- Waking server: "Waking up the WildWorth servers… this can take about 30 seconds."
- Loading: a page-shaped skeleton, never a centred spinner for a page; one status names what's loading ("Loading the site…"). After 8 seconds without an answer it says why, without claiming what it can't know: "Still loading. The WildWorth servers may be waking up, which can take about 30 seconds."
- Fallbacks are never errors: "Live satellite service is busy, so we're showing a cached example from a nearby site."
- Empty states invite the next action: "No stakes yet. Explore Rated sites to back a site."
  - In one or two sentences they say what will appear, what makes it appear and, where there is one, the next action.
  - They never contradict the screen: under a rated site, not "once a site has been rated" but "Mock ratings don't include the Auditor's recommendations. A live rating may list concrete steps here that would strengthen the grade."

## 9. Where feedback goes
Pick the lowest rung that's enough (#216; `frontend/src/lib/feedback.ts`). One announcement per change, and feedback never takes focus unless the user's own action removed what had it.

| Rung | Use for | How |
|---|---|---|
| 1. Inline | Field validity, a refused order | Text under the field (`aria-describedby`, polite), with the fix next to it |
| 2. In place | The surface the user acted on | A receipt, a row that washes (`nx-wash`), a number counting to its new value; a link to where the consequence also lives ("View your stakes") |
| 3. Toast | A consequence on another page, or from the background | Signed in or out, a new alert. Sonner, ≤ 4 s (the welcome 2.5 s, alerts 7 s), at most one action. Never an error the user has to fix |
| 4. Milestone | Listed, opened to supporters, a first stake | A staged reveal, once per journey step |

- **Trades:** the receipt is the confirmation, not a toast. After a fill the trade panel's balance and units count to their new values, and the stake's row on *Your stakes* washes once when the user next opens it, with a text badge ("+60 units just now").
- **Refused orders** are announced once, by their alert; the numbers under the field stay on screen without being read out again.
- **Live prices:** on the asset page's hero, a moved price flashes its colour for 600 ms, then settles back to ink and keeps a ▲/▼ arrow (with text for screen readers). Refreshing a cached price on arrival isn't a move. Ticks aren't announced, and Rated sites cards don't flash.
- **Toasts sit at the bottom:** bottom-left on wide screens, full width at the bottom on phones, so they never cover the header, the account menu or the trade panel.
- **Reduced motion:** washes, flashes and counts show their final state at once; the arrow and the text stay.

## 10. Tour hints
- Two layers on every step, each one or two sentences:
  - 💡 **Why this matters** (warm, product): "Rosa's cooperative gets paid for keeping the wetland alive, without selling it."
  - ⚙️ **Tech behind it** (sober, specific): "Nemotron 3 Ultra audits the evidence; the grade itself comes from a tested formula."
- Buttons: **Next**, **Back**, **Do it for me**, **Skip tour**. Never "Got it!".
- Name models exactly as on Token Factory ("Nemotron 3 Super"), and say **Live** only for real calls.

## 11. Capitalisation and mechanics
- Sentence case for headings, buttons and labels ("Back this site", not "Back This Site").
- Product names keep their case: WildWorth, Proof of Life, WildWatch, The Record (lowercase "the Record" mid-sentence), Agent Trace, Time Machine, Bea, Nemotron, Tavily.
- Use the Oxford comma; use "and" rather than "&" in body text.
