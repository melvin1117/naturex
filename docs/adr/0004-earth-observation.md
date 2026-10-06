# ADR-0004: Earth observation on Google Earth Engine

## Status
Accepted (pending team review). Builds on [ADR-0001](./0001-stack-and-versions.md) (Earth Engine as the primary platform, Sen's slope for the NDVI trend) and dev-spec §7.2.

## Date
2026-10-06

## Context
The rating needs per-polygon land cover, an NDVI series with a trend, water change, forest loss and biomass (dev-spec §7.2). T03 checks the riskiest parts on the real platform before T11 (hero-site precompute) and T13/T15 (tools and scoring) build on them:
- authentication from Python;
- the land-cover and NDVI computations;
- run time;
- the licence terms.

## Decision
- **Auth:** an Earth Engine service account in the team's noncommercial Cloud project (Community tier, no billing).
  - The key file lives outside the repo, and `EE_SERVICE_ACCOUNT_JSON` points to it.
  - Code calls `ee.Initialize(ee.ServiceAccountCredentials(client_email, key_path), project=key["project_id"])`.
  - The account needs the **Earth Engine Resource Viewer** and **Service Usage Consumer** roles. Without the second, initialising fails with "Caller does not have required permission to use project".
- **Land cover:** the per-pixel **mode** of the Dynamic World V1 `label` (`GOOGLE/DYNAMICWORLD/V1`) over the last 12 months, then each class's share of pixels at 10 m (`frequencyHistogram`).
- **NDVI:**
  - Sentinel-2 SR Harmonized (`COPERNICUS/S2_SR_HARMONIZED`), joined with Cloud Score+ (`GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED`) via `linkCollection` and masked at **`cs_cdf` ≥ 0.60** (the catalog page says 0.50–0.65 generally works).
  - Water pixels are excluded using the Dynamic World mode.
  - For each month, the median composite, then its mean over the polygon.
  - Trend: `ee.Reducer.sensSlope()` over 5 years of monthly means, in NDVI per year.
- **One `getInfo()` per metric** (the whole 60-month series is built server-side), so a site costs a few seconds.
- **Demo sites are precomputed and cached** (T11). Earth Engine isn't called on the judging path.

## Evidence (T03 run, 2026-10-06)
`notebooks/ee_spike.ipynb` runs top to bottom in about 40 s (`nbconvert --execute`):

| Polygon | Area: our equal-area calculation vs Earth Engine | Land cover (top classes) | Natural fraction N | NDVI mean, last 12 months | Sen's slope | Clear months |
|---|---|---|---|---|---|---|
| Seed placeholder (`app/seed.py`) | 465.5 vs 466.9 ha (0.30%) | **built 93%**, trees 3%, grass 2% | 5.5% | 0.358 | +0.006/yr | 60/60 (392 scenes) |
| Wetland candidate (Xochimilco Ecological Park area, 1.5 km box) | 261.8 vs 262.6 ha (0.30%) | trees 34%, **water 22%**, built 16%, grass 10%, shrub 10%, crops 6%, flooded vegetation 2% | 78.2% | 0.581 | +0.010/yr | 60/60 (392 scenes) |

- **Run time:** land cover takes 0.3–1.5 s per site; the 5-year NDVI series plus trend takes 8–30 s. Usage is far inside the Community tier's 150 EECU-hours per month.
- **Area check:** our T36 equal-area calculation agrees with Earth Engine's geodesic area to 0.3%.

## Findings
1. **The seed's hero polygon is the wrong place.**
   - The placeholder box is 93% built-up Xochimilco town, so the demo would rate a city as the "wetland".
   - A scan of nearby 1.5 km boxes finds the wetland about 3 km north-east: near Xochimilco Ecological Park (78% natural, 25% water or flooded vegetation) and around San Gregorio Atlapulco (42% water or flooded vegetation).
   - **T11 must draw the hero boundary there.** The seed's `area_ha` (500) also doesn't match its placeholder polygon (466 ha); T11 should derive the area from the real boundary.
2. Cloud Score+ masking leaves clear data in **every** month of 5 years here, so the confidence coverage term (`cloud_free_obs / 24`) will be high for this site.
3. Dynamic World's mode can include **`snow_and_ice`** at 0.0x% on mixed urban pixels. Dropping classes under 0.5% keeps reports clean.

## Licence and terms
- **Earth Engine use is noncommercial:** an individual using it for noncommercial purposes, an open-source project, play money only, no fees, no monetisation. That matches the "Individual using Earth Engine for noncommercial purposes" category (https://earthengine.google.com/noncommercial/).
- **What counts as commercial:** the commercial examples are "monetization of services built on top of Earth Engine" and material made "to influence current and prospective customers' or investors' decisions". NatureX does neither: the exchange is a sandbox and nothing is a real security.
- **Not addressed by the terms:** hackathon **prize money** isn't mentioned (https://earthengine.google.com/terms/). We treat a prize for an open-source prototype as compatible with noncommercial use, but this is **unverified**. If the team wants certainty, ask the organisers or Earth Engine support. Any real commercial use of NatureX would need an Earth Engine commercial licence.
- **Attribution (CC-BY 4.0):**
  - **Dynamic World:** "This dataset is produced for the Dynamic World Project by Google in partnership with National Geographic Society and the World Resources Institute."
  - **Cloud Score+:** cite Pasquarella et al. (2023).
  - **Sentinel-2:** "Contains modified Copernicus Sentinel data [year]".
  - T11 stores these in the precomputed output; the report page and README show them.

## Consequences
- T11 uses these exact methods in `scripts/precompute_sites.py`, with a hand-drawn hero boundary in the wetland area above, and stores dataset versions and attributions with the cached metrics.
- T13's `earth_obs` tool wraps the same functions behind the mock interface (`USE_MOCKS=true` in CI).
- Water change (JRC), forest loss (Hansen) and biomass (GEDI or ESA CCI) are still to be added in T11/T13 using the same one-call-per-metric pattern.

## Alternatives considered
- **Microsoft Planetary Computer:** lacks Dynamic World, Hansen and GEDI (ADR-0001), so it's a fallback only.
- **QA60 cloud mask instead of Cloud Score+:** coarser; Google's catalog recommends Cloud Score+ for Sentinel-2 surface analysis.
- **Mean of daily NDVI instead of a monthly median composite:** more sensitive to residual clouds; the median composite is the standard approach.
