# `src/lib/prototype`: the clickable prototype

Every screen currently runs on a scripted sandbox world that lives in the browser. There are no
backend calls. This lets the full judge story (list → rate → back → Time Machine → ask → verify)
work before the agents, SSE and auth are wired in.

| File                     | Role                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sites.json`             | Real numbers for the 3 demo sites: the backend's `rate_site()` run over `backend/data/demo_sites` (baseline, restoration and encroachment scenarios). Regenerate it if the rating method changes. |
| `data.ts`                | Site metadata (fictional communities), land-cover colours, service groups, model routing (ADR-0003).                                                                                              |
| `rating.ts`              | Report versions from `sites.json`, plus the bounded Auditor overlay (±10, cited) and the §7.4 / §8 formulas.                                                                                      |
| `market.ts`              | Mirrors `backend/app/market/engine.py`: slippage, primary units, re-anchoring.                                                                                                                    |
| `ledger.ts`, `sha256.ts` | Hash-chained Nature Ledger with verify and the tamper demo.                                                                                                                                       |
| `geo.ts`                 | Polygon checks mirroring T36 (shape, 10–50,000 ha, overlap).                                                                                                                                      |
| `trace.ts`               | Recorded Agent Trace runs (illustrative tokens and timings).                                                                                                                                      |
| `copilot.ts`             | Scripted, cited Copilot answers.                                                                                                                                                                  |
| `world.ts`               | The world state and every action (rate, launch, order, next quarter, inject, verify, tamper).                                                                                                     |
| `store.tsx`              | React provider: persistence in `localStorage`, price ticks, drawer state.                                                                                                                         |

**What's illustrative:** news headlines (labelled "Sample"), Agent Trace token counts and timings,
Copilot wording and eval results (shown as "Pending"). Grades, values, confidence and land cover
come from the backend's deterministic code.

**Wiring to the API:** swap each screen's `usePrototype()` reads for the T32 hooks in
`src/lib/hooks.ts` (`useAssets`, `useAsset`, `usePortfolio`, `usePlaceOrder`, …). The components in
`src/components/proto/` take plain props, so most swaps happen in the page-level views
(`marketplace.tsx`, `asset-view.tsx`, `portfolio.tsx`, `steward-home.tsx`, `listing-flow.tsx`,
`control-room.tsx`).
