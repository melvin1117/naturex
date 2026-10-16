---
name: NatureX
description: AI rating agency and sandbox exchange for living nature
colors:
  lichen-ground: "oklch(0.932 0.012 128)"
  card: "oklch(0.988 0.005 118)"
  forest-ink: "oklch(0.255 0.045 148)"
  forest: "oklch(0.31 0.062 148)"
  forest-muted: "oklch(0.47 0.035 145)"
  lichen-raised: "oklch(0.905 0.018 128)"
  border: "oklch(0.885 0.014 128)"
  lime: "oklch(0.86 0.135 126)"
  lime-ink: "oklch(0.42 0.1 135)"
  lilac: "oklch(0.79 0.075 312)"
  clay: "oklch(0.66 0.13 48)"
  clay-ink: "oklch(0.5 0.13 42)"
  sky: "oklch(0.72 0.08 232)"
  machine: "oklch(0.215 0.035 158)"
  machine-raised: "oklch(0.26 0.038 156)"
  machine-line: "oklch(0.34 0.04 152)"
  machine-ink: "oklch(0.94 0.045 122)"
  machine-muted: "oklch(0.74 0.045 135)"
  grade-aaa: "oklch(0.43 0.1 152)"
  grade-aa: "oklch(0.5 0.115 146)"
  grade-a: "oklch(0.54 0.12 138)"
  grade-bbb: "oklch(0.66 0.13 120)"
  grade-bb: "oklch(0.7 0.13 92)"
  grade-b: "oklch(0.67 0.13 66)"
  grade-c: "oklch(0.56 0.14 46)"
  grade-d: "oklch(0.52 0.16 30)"
  destructive: "oklch(0.54 0.17 32)"
typography:
  display:
    fontFamily: "Instrument Serif, ui-serif, Georgia, serif"
    fontSize: "3.75rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Instrument Serif, ui-serif, Georgia, serif"
    fontSize: "2.25rem"
    fontWeight: 400
    lineHeight: 1.1
  numeral:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 300
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  data:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: "12px"
  pill: "9999px"
  panel: "24px"
  feature: "32px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  section: "48px"
components:
  button-primary:
    backgroundColor: "{colors.forest}"
    textColor: "{colors.card}"
    rounded: "{rounded.pill}"
    padding: "8px 20px"
    height: "40px"
  button-on-image:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.pill}"
    height: "40px"
  button-outline:
    backgroundColor: "{colors.card}"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.pill}"
    height: "40px"
  panel:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.panel}"
    padding: "24px"
  machine-panel:
    backgroundColor: "{colors.machine}"
    textColor: "{colors.machine-ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.forest-ink}"
    rounded: "{rounded.control}"
    height: "44px"
  grade-badge:
    backgroundColor: "{colors.grade-a}"
    textColor: "{colors.card}"
    rounded: "{rounded.pill}"
    height: "28px"
---

# Design System: NatureX

## Overview

Living land as a calm, credible instrument. The site's own Sentinel-2 image, blurred, is the ground of every key card, and numbers sit on it like readouts on a field instrument. The world is pinned by the team's references: a soft lichen-grey ground, off-white cards with generous radii and soft offset shadows, deep forest-green ink, and lime and lilac as data colours. It refuses the trading-terminal default (dense red/green tickers on black) and the eco cliché (leaf icons on cream paper).

Two layers share one palette. The **land layer** (marketplace, asset pages, steward home) is light, because judges use it on laptops in daylight and it is recorded for video. The **machine layer** (rating pipeline, Agent Trace, Nature Ledger, impact card, Time Machine timeline) is a dark forest green with pale lime text, so the AI's work reads as a distinct, inspectable surface.

Voice follows PRODUCT.md: sober on rating and market surfaces, warm on community and tour surfaces. Every value carries its range and confidence.

## Colors

### Primary
- **Forest** (`forest`): primary buttons, active tabs, the demo bar. **Forest ink** (`forest-ink`) is the text colour everywhere on light surfaces; there is no pure black.

### Secondary
- **Lime** (`lime`): positive data (value bars, price fill, health instrument on dark), the call to action on photographic grounds, and the tour spotlight. **Lime ink** (`lime-ink`) is the text-safe version for positive deltas and pass states.
- **Lilac** (`lilac`): the second data colour (trend guides, carbon).

### Tertiary
- **Clay** (`clay`): pressure and negative states (downgrades, encroachment, alerts, negative news). **Clay ink** (`clay-ink`) for text.

### Neutral
- **Lichen ground** (`lichen-ground`) is the page; **card** is the content surface; **lichen raised** is the secondary band (tour prompt, map background).
- **Machine** tokens (`machine`, `machine-raised`, `machine-line`, `machine-ink`, `machine-muted`) build the dark layer.

### Named Rules
- **The grade scale is a ramp, never a traffic light.** AAA–A are deep to mid greens, BBB–B move through olive and mustard, C–D are clay to brick. A grade always appears with its letter and, on first mention, its health score and plain label. BBB, BB and B use dark ink for contrast.
- **Direction never relies on colour alone.** Deltas carry an arrow icon and a signed percentage; news events carry an up or down icon and a written direction.
- **Dynamic World colours stay Dynamic World's.** Land-cover bars and map overlays use the dataset's own class colours so the legend matches the imagery.

## Typography

### Hierarchy
- **Display** (Instrument Serif, 3.75rem, -0.025em): page titles only ("Marketplace", "Time Machine") and the wordmark. One italic word is allowed on the judge landing.
- **Title** (Instrument Serif, 2.25rem): site names on feature cards and report cards, drawer titles.
- **Numeral** (Hanken Grotesk Light, tabular): prices, health scores, value ranges, stats. Big numbers are light, never bold.
- **Body** (Hanken Grotesk 400, 1rem, 1.6): prose capped at 65ch.
- **Label** (Hanken Grotesk 500, 0.75rem): stat labels, metadata, chips.
- **Data** (Geist Mono 11px): hashes, JSON output and model IDs only, never as decoration.

### Named Rules
- **Serif for names, sans for numbers.** Places and pages get the serif; every number is set in tabular Hanken Grotesk.
- **No eyebrows.** Headings carry themselves; context goes in a sentence below.

## Layout

Max width 1280px with a 16px gutter on phones and 24px from `sm`. Pages open with a serif title row, a stat strip in one card, then a full-width feature card on a photographic ground. Detail pages use a two-column grid (content plus a 360px sticky aside for the trade panel) from `lg`. Headers wrap navigation onto a second row below 640px. No horizontal page scroll at 390px.

## Elevation & Depth

### Shadow Vocabulary
- **soft**: `0 1px 2px oklch(0.3 0.05 145 / 0.05), 0 10px 30px -14px oklch(0.3 0.05 145 / 0.18)`: every card at rest.
- **lift**: `0 2px 4px oklch(0.3 0.05 145 / 0.06), 0 22px 48px -20px oklch(0.3 0.05 145 / 0.3)`: hovered cards, feature cards, tour card, toasts.

### Named Rules
- **Glass only on photographs.** Backdrop blur appears only where a panel sits on a satellite image (feature card price box, asset hero ring). Elsewhere surfaces are opaque.

## Shapes

Pills for every control (buttons, tabs, toggles, chips, selects). 12px for inputs. 24px for panels, 28–32px for feature cards and steps. Icon tiles are rounded squares (12–16px), never circles.

## Components

### Buttons
Primary: forest pill, 40px. On a photograph: lime pill with forest ink. Outline: card pill with input border. Ghost for tertiary actions. Pressed state nudges down 1px.

### Chips
Ecosystem, verification and status chips are small pills; on images they are white at 15% with white text.

### Cards / Containers
`panel`: card surface, 24px radius, soft shadow, 24px padding, a semibold 16px title row with an optional action. Never nested inside another panel; inner groupings use the `secondary` band with 16px radius.

### Inputs / Fields
44px, 12px radius, card fill, input border, forest caret, ring on focus. Errors in destructive text below the field, wired with `aria-describedby`.

### Navigation
Sticky translucent header per app (Exchange, Steward, Control room) with the serif wordmark and app name, pill nav with the active page raised on a card, then Copilot, Agent Trace and the alerts bell. The forest demo bar sits above with the persona switcher, guided tour and reset.

### Health instrument (signature)
A dotted radial dial: 100 columns of dots, one per point of health, lit up to the score (forest on light, lime on dark), with the light numeral in the centre. It reads literally, not decoratively.

### Rating pipeline (signature)
Machine-layer list of agent steps that light up in order with a running line, model name and Live badge, used in the listing flow and mirrored by the Agent Trace drawer.

## Do's and Don'ts

### Do:
- Show every value as a range with its midpoint and confidence.
- Use the site's own satellite image as the ground of its key cards.
- Put AI work on the machine layer and label replayed runs as recorded.
- Label sample news and illustrative data where a visitor could mistake it for real.

### Don't:
- Don't use red/green ticker styling or neon-on-black trading UI.
- Don't use emoji or unicode glyphs as icons; use Lucide at one stroke weight.
- Don't add gradient text, coloured side borders on cards, or decorative glass on flat surfaces.
- Don't say "invest", "returns" or "profit"; follow the softened vocabulary in docs/design/ux-writing.md.
