# UX writing rules

> Part of P01 (#19). Product context: [PRODUCT.md](../../PRODUCT.md). These rules apply to every string in the UI, the tour and the demo video captions.

## 1. Voice by surface
| Surface | Voice | Example |
|---|---|---|
| Report, grade, value, market, Agent Trace, ledger | **Sober rating agency:** precise, evidence-led, understated | "Health score fell from 74.2 to 63.8 after a reported 40 ha industrial expansion (source: 12 Sep 2026)." |
| Listing, community, judge landing, tour hints | **Warm and plain:** celebrates stewards, still honest | "Draw the boundary of the land your community protects. We'll check the shape and area as you go." |

Everywhere:
- Short sentences, active voice, no exclamation marks in sober surfaces.
- Say what happened, then why, then what to do next.
- No hype words: *revolutionary, guaranteed, moon, returns, profit, opportunity, invest now*.
- Name the AI's role honestly: the AI **explains**, **classifies** and **audits**; formulas **compute**. Never "the AI valued your land".

## 2. Numbers
- **Values are always a range with a midpoint and confidence.** Format: `$9.8M–$13.4M /yr · mid $11.7M · 87% confidence`. Never show a single value alone.
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
- The persistent banner: **"Sandbox · play money only. Nothing here is a real security or investment."**
- First-run judge landing repeats it in one line; the trade panel repeats it near the confirm button.
- Use "play money", "sandbox balance". Never "funds", "deposit", "withdraw", "wallet" for the user's own money.
- Mock or cached data is labelled: "Cached result (live service busy)" or "Mock mode: no API keys configured". Live AI steps get a **Live** badge.

## 5. Vocabulary (softened market terms)
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
| market / exchange | **Marketplace** (the page), "the sandbox exchange" only in the pitch | |
| portfolio | **Your stakes** (page title), route stays `/portfolio` | |
| holdings | stakes | |
| community wallet | **Community fund** | |
| IPO proceeds | **from supporters** ("What supporters paid for units in the opening offer") | |
| launch the IPO | **Open to supporters** (the steward's next step); the screen's button stays **Launch opening offer** | |
| retained stake / retained shares | **the units your community keeps** | units kept |
| retained-stake dividends (treasury) | **payouts on the units you kept** ("Payouts on kept units" where space is short) | |
| investor | **supporter** (Arjun's persona label stays "investor") | |
| fair value per share | fair stake price | fair price per unit |
| P&L | change in value (play money) | P&L (play money) |

## 6. Errors, empty and waiting states
- Say what happened in plain words, then the fix. No codes unless in the trace.
  - Polygon too small: "This area is 6 ha. Sites need at least 10 ha."
  - Overlap: "This boundary overlaps the Xochimilco Wetland site. Adjust the edge to continue."
  - Not enough play money: "You have $420 of play money. This needs $1,000. You can buy up to 41 units now."
- When fewer units would go through, say how many and offer them as a one-tap fix that changes the field, never one that places the order: **Change to 41 units**. The number is the API's (the quote's `max_qty`, or the units held), never estimated in the browser.
- A refused order says "Nothing was traded."; a refused quote doesn't (nothing could have been).
- Waking server: "Waking up the NatureX servers… this can take about 30 seconds."
- Loading: a page-shaped skeleton, never a centred spinner for a page; one status names what's loading ("Loading the site…"). After 8 seconds without an answer it says why, without claiming what it can't know: "Still loading. The NatureX servers may be waking up, which can take about 30 seconds."
- Fallbacks are never errors: "Live satellite service is busy, so we're showing a cached example from a nearby site."
- Empty states invite the next action: "No stakes yet. Explore the Marketplace to back a site."
  - In one or two sentences they say what will appear, what makes it appear and, where there is one, the next action.
  - They never contradict the screen: under a rated site, not "once a site has been rated" but "Mock ratings don't include the Auditor's recommendations. A live rating may list concrete steps here that would strengthen the grade."

## 7. Where feedback goes
Pick the lowest rung that's enough (#216; `frontend/src/lib/feedback.ts`). One announcement per change, and feedback never takes focus unless the user's own action removed what had it.

| Rung | Use for | How |
|---|---|---|
| 1. Inline | Field validity, a refused order | Text under the field (`aria-describedby`, polite), with the fix next to it |
| 2. In place | The surface the user acted on | A receipt, a row that washes (`nx-wash`), a number counting to its new value; a link to where the consequence also lives ("View your stakes") |
| 3. Toast | A consequence on another page, or from the background | Signed in or out, a new alert. Sonner, ≤ 4 s (the welcome 2.5 s, alerts 7 s), at most one action. Never an error the user has to fix |
| 4. Milestone | Listed, opened to supporters, a first stake | A staged reveal, once per journey step |

- **Trades:** the receipt is the confirmation, not a toast. After a fill the trade panel's balance and units count to their new values, and the stake's row on *Your stakes* washes once when the user next opens it.
- **Live prices:** a moved price flashes its colour for 600 ms, then settles back to ink and keeps a ▲/▼ arrow (with text for screen readers). Ticks aren't announced.
- **Toasts sit at the bottom:** bottom-left on wide screens, full width at the bottom on phones, so they never cover the header, the account menu or the trade panel.
- **Reduced motion:** washes, flashes and counts show their final state at once; the arrow and the text stay.

## 8. Tour hints
- Two layers on every step, each one or two sentences:
  - 💡 **Why this matters** (warm, product): "Rosa's cooperative gets paid for keeping the wetland alive, without selling it."
  - ⚙️ **Tech behind it** (sober, specific): "Nemotron 3 Ultra audits the evidence; the grade itself comes from a tested formula."
- Buttons: **Next**, **Back**, **Do it for me**, **Skip tour**. Never "Got it!".
- Name models exactly as on Token Factory ("Nemotron 3 Super"), and say **Live** only for real calls.

## 9. Capitalisation and mechanics
- Sentence case for headings, buttons and labels ("Back this site", not "Back This Site").
- Product names keep their case: NatureX, Nature Ledger, Agent Trace, Time Machine, Copilot, Nemotron, Tavily.
- Use the Oxford comma; use "and" rather than "&" in body text.
