---
name: WildWorth
description: The AI rating agency for living nature. Worth more wild.
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
    fontFamily: "Gloock, Georgia, Times New Roman, serif"
    fontSize: "3.75rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Gloock, Georgia, Times New Roman, serif"
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
    backgroundColor: "{colors.card}"
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

# Design System: WildWorth

The brand's source of truth is [docs/design/wildworth-brand-guidelines.html](docs/design/wildworth-brand-guidelines.html) (logo, colour, type, icons, feature names, voice, motion); Bea's is [docs/design/bea-character.html](docs/design/bea-character.html). Every drawing and value in the code is taken from their scripts, never redrawn.

## Overview

Living land as a calm, credible instrument. The site's own Sentinel-2 image, blurred, is the ground of every key card, and numbers sit on it like readouts on a field instrument. The world is pinned by the team's references: a soft lichen-grey ground, off-white cards with generous radii and soft offset shadows, deep forest-green ink, lime for the reading and lilac as the second data colour. It refuses the trading-terminal default (dense red/green tickers on black) and the eco cliché (leaf icons on cream paper).

Two layers share one palette. The **land layer** (the Marketplace, site pages, Communities) is light, because judges use it on laptops in daylight and it is recorded for video. The **machine layer** (rating pipeline, Agent Trace, The Record, impact card, Time Machine timeline) is a dark forest green with pale lime text, so the AI's work reads as a distinct, inspectable surface.

Voice follows PRODUCT.md: sober on rating and market surfaces, warm on community and tour surfaces. Every value carries its range and confidence.

## Colors

### Primary
- **Forest** (`forest`): the logo's line, primary buttons, active tabs, the sandbox bar. **Forest ink** (`forest-ink`) is the text colour everywhere on light surfaces; there is no pure black.

### Secondary
- **Lime** (`lime`): **the reading**: the logo's last stroke and dot, the lit dots of the health dial and, on dark grounds, of the Proof of Life seal (on paper the seal lights in its grade colour), value bars and price fill, live states and confirmations. **Lime ink** (`lime-ink`) is the text-safe version for positive deltas and pass states, and the reading on light grounds.
- **Lilac** (`lilac`): the second chart series only.
- **Sky** (`sky`): water layers and the flood service only.

### Tertiary
- **Clay** (`clay`): pressure and negative states (downgrades, encroachment, alerts, negative news). **Clay ink** (`clay-ink`) for text.

### Neutral
- **Lichen ground** (`lichen-ground`) is the page; **card** is the content surface; **lichen raised** is the secondary band (tour prompt, map background).
- **Machine** tokens (`machine`, `machine-raised`, `machine-line`, `machine-ink`, `machine-muted`) build the dark layer.

### Named Rules
- **Lime means the reading.** Lime appears only for the reading, live states and confirmations, and stays rare (about 3% of a screen) so it always means something. It is never a button fill: buttons are forest on light grounds and paper (`card`) on dark grounds and photographs.
- **The grade scale is a ramp, never a traffic light.** AAA–A are deep to mid greens, BBB–B move through olive and mustard, C–D are clay to brick. A grade always appears with its letter and, on first mention, its health score and plain label. BBB, BB and B use dark ink for contrast.
- **Direction never relies on colour alone.** Deltas carry an arrow icon and a signed percentage; news events carry an up or down icon and a written direction.
- **Dynamic World colours stay Dynamic World's.** Land-cover bars and map overlays use the dataset's own class colours so the legend matches the imagery.

## Typography

Three free (OFL) faces from Google Fonts, loaded with `next/font`: **Gloock** (display), **Hanken Grotesk** (UI, body and numbers) and **Geist Mono** (the machine).

### Hierarchy
- **Display-xl** (Gloock 400, 88–104px, -0.025em): the judge story's opening title.
- **Display** (Gloock 400, 3.75–4rem, -0.025em): page titles ("Marketplace", "Time Machine") and the wordmark's "Wild".
- **Title** (Gloock 400, 2–2.5rem, 1.1): site names on feature cards and report cards, drawer titles, grade verdicts ("A · Strong health").
- **Numeral** (Hanken Grotesk 300, tabular, -0.03em): prices, health scores, value ranges, stats, and the wordmark's "Worth". Big numbers are light, never bold.
- **Body** (Hanken Grotesk 400, 1rem, 1.6): prose capped at 65ch.
- **Label** (Hanken Grotesk 500, 0.75rem): stat labels, metadata, chips, sentence case.
- **Data** (Geist Mono 11–13px): hashes, JSON output, model IDs and the seal's stamp only, never as decoration.

### Named Rules
- **Serif for names, sans for numbers, mono for the machine.** Places and pages get the serif; every number is set in tabular Hanken Grotesk. Gloock has no italic; emphasise with words, not slant.
- **No eyebrows.** Headings carry themselves; context goes in a sentence below.

## Logo

**Two Ws drawn as one line, with the last stroke rising to the land's Health score.** It reads as ripples on a wetland, as sedge in the wind and as a value line. The logo is a reading, not a picture (`components/brand/`, from `wwInner()` in the guidelines).

- **Construction:** 100-unit square, stroke 7.5 units, round caps and joins. The reading's end travels from y 80 (score 0) to y 16 (score 100); a dot of radius 6 marks today's reading.
- **The master logo shows 77.6.** On a site, the mark shows that site's real score and its reading takes the site's grade colour.
- **Colour of the parts:** the line and wordmark take the ground's ink (forest on light, paper on dark). The reading is lime on dark grounds, lime-ink on light, forest on lime.
- **Wordmark:** "Wild" in Gloock 400, "Worth" in Hanken Grotesk 300 at 0.9em, -0.045em. Mark to wordmark gap: 0.28 × the wordmark's size. Clear space: one W height on every side.
- **Lockups:** horizontal (default), stacked (square and centred frames), mark only where the name is already on screen.
- **Small sizes:** below 24 px use the single W (one W with the same reading stroke, no dot). Minimum 16 px mark, 72 px wide horizontal lockup. The app icon and favicon are the single W on a forest tile with a 22% corner radius.
- **Motion:** the line draws (1.1 s), then the reading rises (0.55 s) and the dot pops, only when a rating lands, never on hover or as a loader.
- **Don't** stretch, rotate, recolour, add a leaf, globe or dollar sign, add shadows or gradients, retype the wordmark, use the reading as a price, or place it on busy grounds without a tile.

## Layout

Max width 1280px with a 16px gutter on phones and 24px from `sm`. Pages open with a serif title, then one sentence that carries their numbers inline (no stat strip, no boxed metrics), then their content: the Marketplace's feature card and site cards, a community's site tiles. **Your stakes** is the exception: it opens on its money panel (the total, then stakes and sandbox balance on one split bar) beside the impact band, then a row per stake, because a supporter's first question is what they paid and how it's doing. Lists of sites are grids of picture tiles (the site's satellite view first), three to a row from `lg`. Detail pages use a two-column grid (content plus a 360px sticky aside for the trade panel) from `lg`. Headers wrap navigation onto a second row below 640px. No horizontal page scroll at 390px.

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
Primary: forest pill, 40px. On a photograph or the machine layer: paper (`card`) pill with forest ink. Outline: card pill with input border. Ghost for tertiary actions. Pressed state nudges down 1px. Never lime (lime is the reading).

### Chips
Ecosystem and verification chips are small pills; on images they are white at 15% with white text. A site tile's state chip (top left of its picture) is solid and says where the site stands at a glance: forest for On the Marketplace, lime for Rated, sky for in progress (Being rated, Waiting for the Reviewer), clay for what needs the community (Sent back, Needs more evidence), card for a draft. The tile's link says the state too, so the chip is hidden from screen readers.

### Cards / Containers
`panel`: card surface, 24px radius, soft shadow, 24px padding, a semibold 16px title row with an optional action. Never nested inside another panel; inner groupings use the `secondary` band with 16px radius.

### Inputs / Fields
44px, 12px radius, card fill, input border, forest caret, ring on focus. Errors in destructive text below the field, wired with `aria-describedby`.

### Navigation
One bar for the whole sandbox (ADR-0008), sticky and translucent, holding from left to right:
- the WildWorth lockup (it leads to the Marketplace);
- the pill nav: **Marketplace · Communities · Your stakes** (the Reviewer: **Marketplace · Reviews**), the active page raised on a card. Below `md` the pills wrap onto their own row;
- **Time Machine** (a ghost button with the brand pack's Time Machine icon) that opens a side sheet;
- the alerts bell;
- **who you are**: a switcher, an outlined pill with everyone's round avatars stacked, the current person in front (Rosa lime, Arjun forest, the Reviewer on the machine layer with a check; phones show only the current one), "Viewing as Rosa" over her role, and up-and-down chevrons. Its menu opens on "Switch person": the three people as radio items, then start the sandbox over or leave it.

**Ask Bea** floats bottom-right on every sandbox page: a forest pill with Bea's avatar, "Ask Bea" and an "AI" tag (its name is "Ask Bea AI assistant"); below `sm` only her avatar. Her wings and antennae stir for about two seconds when it's hovered or focused.

The footer is one quiet line: the lockup, "A hackathon prototype. Values are screening estimates, not appraisals." and a "Data sources" dialog. The sandbox line is said once on the welcome and once in the trade panel.

### Welcome (signature)
`/` is full-bleed: Esri imagery of the hero wetland settles from 108% over 4.5 s, its boundary is drawn in lime (the "Draw" move), and Bea makes the page's one authored moment (`components/welcome/bea-intro.tsx`, once per page load): she flies in from the left as a solid ink silhouette with beating wings (still ink only, her stripe and face cut out), the display-xl title "Welcome to WildWorth." is written where she passes (a feathered mask that follows her), the sentence on what WildWorth does and the two buttons rise, **Show me how** (paper, primary) and **Try it yourself** (paper outline, `on-image-outline`), and she lands in **Ask Bea** at the bottom right, which grows out of her before she's her usual outline again and says "Hi, I'm Bea." for a few seconds. About 2.7 s; any key, click or scroll ends it at its last frame. Reduced motion shows the final frame, and if the script never runs everything shows at 3.5 s.

### Site page (signature)
One scroll that a judge reads top to bottom, with depth one tap away and never on another page (ADR-0008 §4):
- **Hero** on the site's own satellite ground: place and verification badge, the name, one line on the land, the **Worth range** and the price a unit, the live health dial with its grade, and two ways in: **How it was rated** (paper, primary) and **Proof of Life report** (paper outline). On phones a third, **Back this site**, leads first and jumps to the trade panel.
- **The verdict band** (machine layer): the Auditor's one-line verdict, the models that worked on the run (from its own receipt, busiest first, then the web searches) and **Open the Agent Trace**.
- **Three sections**, each one panel: **What the land does each year**, **Seen from above** (the views five years apart, or the land cover, one at a time) and **News and satellite** (five years of greenness with what explains it, then the latest news). **Price a unit** follows once there are trades to chart.
- **Back this site** is the sticky right column on wide screens.
- **Everything else is in two drawers** over the page, named by `?tab=` so links still land: the **Agent Trace** (machine layer, `?tab=trace`) and the **Proof of Life drawer** (paper, tabs Proof of Life · The Record · Verification · Field photos · Data sources). A row of quiet buttons under the sections opens each tab.

### Marketplace map (secondary view)
**Cards · Map** beside the grade filter (`?view=map`); cards stay the default. Every site's drawn boundary on Esri imagery in its grade colour, with a paper pin (grade badge and name). A list beside the map (below it on phones) flies the map to a site and opens its card; the map takes the wheel only after a click, so the page scrolls past it.

### Health instrument (signature)
A dotted radial dial (`DotRing`): 100 columns of dots in 5 rings, one column per point of health, lit up to the score (forest on light, lime on dark), with the light numeral in the centre. It reads literally, not decoratively, and stays wherever a live score is shown.

### Proof of Life seal (signature)
Each quarter's rating report is a **Proof of Life**. Its seal is drawn as the guidelines' `sealInner()`: a single ring of 100 dots, one per point of health, lit up to the report's score (the grade's colour on paper, lime on forest; unlit dots are the ink at 20%), with "PROOF OF LIFE" and the quarter (Geist Mono) and the grade letter (Gloock) in the centre. It is deliberately not the five-ring health dial: the dial is the live reading, the seal the verdict issued each quarter. Use it only on the quarterly report's header and its share card, always with the site's name and the quarter, with the evidence one click away. "Ecological Performance Report" stays as the subtitle. Never abbreviate it to "PoL".

### Icons
The WildWorth pack (`components/icons/`, from the guidelines' `GL` object) for every WildWorth feature and ecosystem service; Lucide stays for generic UI (close, chevrons, menu). Both share Lucide's metrics: 24 px grid, 2 px padding, 1.75 px stroke, round caps and joins, and the same props. Each icon lights exactly one part, what the feature reads or confirms: filled accents are lime with an ink outline, accent strokes are lime-ink on light and lime on the machine layer. Never recolour the accent to show state. Icons in navigation always have a text label; icon-only buttons need an accessible name. Bea's icon is her drawing scaled down.

### Bea, the field guide (character)
Bea replaces "Copilot". She is drawn in the logo's line, **ink only** (forest on light, paper on dark), no fills and no colour: a round body with two carets of the WildWorth zigzag as her stripe, outline wings and antennae, dot eyes and a line smile (`bea()` in the character sheet). Six states, each tied to a product moment: **Hello** (panel opens, between answers), **Thinking** (the model is answering), **Found it** (an answer with evidence, or a grade went up), **Downgrade** (a grade fell or WildWatch raised an alert), **Can't answer** (the Record has nothing), **Waking up** (the free-tier backend is starting). When she appears or changes state her wings flutter (0.32 s), she bobs (3.6 s) and blinks, then she rests within 5 seconds (WCAG 2.2.2); thinking and waking loop only while the work runs. On an upgrade she hops once (750 ms), on a downgrade she shakes once (600 ms). Full character from 64 px, an avatar below that, the 24 px icon in buttons. Never fill her with colour, add a lime accent, bring back a rising stroke, or stretch her.

Her chat follows the character sheet's product mock (`components/bea/chat-parts.tsx`), the same in the header's sheet, on a site's page and in the scripted preview:
- **Title:** her avatar, "Bea · your field guide" in Gloock and what she answers from, on paper.
- **Messages:** the reader's questions in forest bubbles on the right; her answers in paper bubbles beside her avatar, which shows the turn's state.
- **Sources:** small chips (the ref in mono, then the source's name).
- **How the answer was made:** a mono footnote under the bubble: searched, written by, code checked.
- **Working:** what she's doing, as a quiet line beside her avatar.
- **Empty:** Bea, "Ask Bea about {site}", a sentence and question chips. The chips show only before the first question.
- **Field:** paper, inset, with the send button inside it, and a mono footnote: "Runs on NVIDIA Nemotron 3 Nano · Not advice."

## Motion
Every animation means something, plays once, ends on the real value, and is replaced by its final frame under `prefers-reduced-motion`. Four moves, all on `--ww-ease-out` (`cubic-bezier(.16,1,.3,1)`): **Draw** (something is being measured: the logo line, a boundary, a chart; 900–1100 ms), **Rise** (a reading arrived: the logo's last stroke, the seal's dots; 550 ms after the draw), **Count** (a number changed; 600–900 ms) and **Stamp** (a verdict was issued: grade reveal or change; 520 ms, once). Bea's idle motion settles within 5 seconds (her thinking and waking loops last only as long as the work), and stops for reduced motion too.

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
- Don't use emoji or unicode glyphs as icons; use the WildWorth pack for features and Lucide for generic UI, at one stroke weight.
- Don't fill a button with lime; lime is the reading.
- Don't add gradient text, coloured side borders on cards, or decorative glass on flat surfaces.
- Don't say "invest", "returns" or "profit"; follow the softened vocabulary in docs/design/ux-writing.md.
