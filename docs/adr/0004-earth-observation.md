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
  - Trend: `ee.Reducer.sensSlope()` over 5 years of monthly means, in NDVI per year, plus a **Mann-Kendall significance test** (dev-spec §7.2): `ee.Reducer.kendallsCorrelation(2)` gives Kendall's tau against time. Earth Engine returns `p-value: NaN` for table inputs, so the p-value is computed from tau with the standard normal approximation (S = τ·n(n−1)/2, Var(S) = n(n−1)(2n+5)/18).
- **One `getInfo()` round trip per metric:** land cover is one call; the 60-month NDVI series, slope and trend test come back together in one `ee.Dictionary`. Area is a separate call.
- **Demo sites are precomputed and cached** (T11). Earth Engine isn't called on the judging path.

## Evidence (T03 run, 2026-10-06)
`notebooks/ee_spike.ipynb` runs top to bottom in about 40 s (`nbconvert --execute`):

| Polygon | Area: our equal-area calculation vs Earth Engine | Land cover (top classes) | Natural fraction N | NDVI mean, last 12 months | Sen's slope | Mann-Kendall | Clear months |
|---|---|---|---|---|---|---|---|
| Seed placeholder (`app/seed.py`) | 465.5 vs 466.9 ha (0.30%) | **built 93%**, trees 3%, grass 2% | 5.5% | 0.358 | +0.006/yr | τ +0.26, p 0.004 (significant) | 60/60 (392 scenes) |
| Wetland candidate (Xochimilco Ecological Park area, 1.5 km box) | 261.8 vs 262.6 ha (0.30%) | trees 34%, **water 22%**, built 16%, grass 10%, shrub 10%, crops 6%, flooded vegetation 2% | 78.2% | 0.581 | +0.010/yr | τ +0.16, p 0.067 (**not** significant) | 60/60 (392 scenes) |

- **Run time varies a lot with Earth Engine's load:** across the T03 runs, land cover took 0.3–31 s per site, and the 5-year NDVI series with slope and trend test took 4–5 s once fetched in one round trip (8–30 s as separate calls). Usage is far inside the Community tier's 150 EECU-hours per month. Precompute, don't call it live.
- **Area check:** our T36 equal-area calculation agrees with Earth Engine's geodesic area to 0.3%.

## Findings
1. **The seed's hero polygon is the wrong place.**
   - The placeholder box is 93% built-up Xochimilco town, so the demo would rate a city as the "wetland".
   - A scan of nearby 1.5 km boxes finds the wetland **about 3 km north** of it, near Xochimilco Ecological Park (box with south-west corner −99.105, 19.28: 78% natural, 25% water or flooded vegetation), and **about 3 km east**, around San Gregorio Atlapulco (−99.06, 19.265: 42% water or flooded vegetation).
   - **T11 must draw the hero boundary there.** The seed's `area_ha` (500) also doesn't match its placeholder polygon (466 ha); T11 should derive the area from the real boundary.
2. **A slope alone isn't a trend.** The wetland candidate's Sen's slope is positive (+0.010/yr) but **not significant** (p = 0.067), while the urban placeholder's smaller slope is. T13/T15 should store the p-value and only feed the slope into vegetation vigour `V` when p < 0.05 (otherwise treat the trend as 0); the report should say "no significant change".
3. Cloud Score+ masking leaves clear data in **every** month of 5 years here, so the confidence coverage term (`cloud_free_obs / 24`) will be high for this site.
4. Dynamic World's mode can include **`snow_and_ice`** at 0.0x% on mixed urban pixels. Dropping classes under 0.5% keeps reports clean.

## As built (T11, 2026-10-06)

T11 replaced the seed placeholder with a committed hero boundary at `backend/data/demo_sites/wetland_mx.geojson`. The polygon is hand-digitised over the Xochimilco Ecological Park wetland area identified above, guided by Dynamic World natural/water pixels and our own visual judgement. It does **not** copy OpenStreetMap or other share-alike boundaries.

Hero polygon stats from `backend/data/demo_sites/wetland_mx.json`:

| Stat | Value |
|---|---:|
| Area | 206.6995 ha |
| Vertices | 16 |
| Centroid | 19.2873, −99.0976 |
| Natural fraction | 83.89% |
| Water | 24.84% |
| Trees | 35.74% |
| Grass | 10.24% |
| Flooded vegetation | 2.96% |
| Shrub and scrub | 10.11% |
| Crops | 3.23% |
| Built | 12.88% |
| Bare / snow and ice | 0.00% |

The cached metrics are written by `scripts/precompute_sites.py` to `backend/data/demo_sites/<site_key>.json`. The runtime app does not import Earth Engine; it loads the JSON through `app.tools.earth_obs.load_site_metrics(site_key)`, which returns frozen Pydantic models and raises a clear error for unknown site keys.

T11 stores the following output fields:
- `area_ha` and `centroid` from the same local equal-area calculation used by listing validation;
- `landcover` and `natural_fraction`;
- 60 monthly `ndvi_series` rows, `ndvi_mean`, canonical `ndvi_trend` (Sen's slope per year), and `ndvi_trend_details` with Mann-Kendall tau and p-value;
- `water_change`;
- `forest_loss_ha`;
- `biomass_t_ha`;
- `cloud_free_obs` and `cloud_free_months_5y`;
- `data_version`, exact date windows, thresholds, dataset IDs/versions/bands/catalog URLs, computation timestamp and attributions.

Dataset choices as built:

| Metric | Dataset ID and bands | Version / window | Reason |
|---|---|---|---|
| Land cover | `GOOGLE/DYNAMICWORLD/V1` · `label` | V1; 2025-10-01 to 2026-10-01 | Required by §7.2; 10 m classes map directly into T14/T15 natural fraction and valuation inputs. |
| NDVI and coverage | `COPERNICUS/S2_SR_HARMONIZED` · `B8`, `B4` joined with `GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED` · `cs_cdf` | 2021-10-01 to 2026-10-01; `cs_cdf >= 0.60`; a scene counts as cloud-free only when at least 50% of non-water pixels in the polygon are clear | Same method as the T03 notebook, with the stricter T11 scene-level coverage definition so a single clear pixel cannot inflate confidence. Cloud Score+ is the catalog-recommended QA companion for Sentinel-2 surface analysis. |
| Water change | `JRC/GSW1_4/GlobalSurfaceWater` · `change_abs` | v1.4; source observations 1984-03-16 to 2021-12-31 | Official JRC global surface-water occurrence change layer; stored as mean absolute occurrence change intensity over the polygon with never-water pixels treated as 0. |
| Forest loss | `UMD/hansen/global_forest_change_2025_v1_13` · `lossyear`, masked by `treecover2000 >= 30` | 2025 v1.13; latest five complete Hansen years, 2021-2025 (`lossyear` 21-25) | Current official catalog version. The project definition is Hansen loss only where 2000 canopy cover was at least 30%, a common conservative forest threshold that avoids counting sparse trees, orchards or urban vegetation as forest loss. The Hansen tree-cover definition is vegetation taller than 5 m in 2000. |
| Biomass | `LARSE/GEDI/GEDI04_B_002` · `MU` | GEDI L4B Version 2; 2019-04-18 to 2021-08-04 | Official gridded above-ground biomass density in Mg/ha with coverage over the Mexico City site. ESA CCI Biomass was not used because the checked EE catalog URL was unavailable; GEDI L4B is documented and returned coverage for the hero polygon. |

Hero metrics produced by T11:
- NDVI last-12-month mean: 0.6008.
- Sen's slope: +0.0097 NDVI/year.
- Mann-Kendall: τ = +0.1469, p = 0.0986 (not significant at 5%).
- Cloud-free Sentinel-2 observations in the last 12 months: 73; all 60 months have clear data. A scene counts only if `cs_cdf >= 0.60` for at least 50% of the polygon's non-water pixels.
- JRC water change mean (`change_abs`): −6.6021.
- Hansen forest loss in the latest five complete dataset years, masked to `treecover2000 >= 30%`: 0.0 ha.
- GEDI L4B mean above-ground biomass: 9.4681 t/ha.

Re-run and check:

```bash
cd backend
PATH=$HOME/.local/bin:$PATH uv run --with earthengine-api python ../scripts/precompute_sites.py
PATH=$HOME/.local/bin:$PATH uv run --with earthengine-api python ../scripts/precompute_sites.py --check
```

`--check` recomputes every committed demo-site GeoJSON and compares the result with the committed JSON using a small numeric tolerance. Existing `computed_at_utc` values are preserved during recompute so the cache stays stable to diff.

## As built (T13, 2026-10-07): mangrove and forest sites, SOC, 12-month loss, Time Machine

### Two more real demo sites
Both boundaries are hand-digitised over Dynamic World pixels and checked with the T36 polygon validation (valid, no self-intersections). Protected-area membership was checked against WDPA in Earth Engine (UNEP-WCMC and IUCN, Protected Planet); no WDPA, OpenStreetMap or other share-alike boundary is copied.

| | `mangrove_mx` | `restoration_forest` |
|---|---|---|
| Place | East bank of the Ría Celestún estuary, Yucatán; 100% inside the Ría Celestún Biosphere Reserve and Ramsar site | Forested slopes north of the Grijalva river in the Sumidero Canyon, Chiapas, ~12 km NNE of central Tuxtla Gutiérrez; ~53% inside Cañón del Sumidero National Park, the rest on its edge |
| Why | A famous, protected coastal mangrove: the "blue chip" (pm-spec §6). The seed's placeholder near Holbox (Yum Balam) was also scanned: Dynamic World shows mostly bare ground, grass and scrub behind its lagoon shore, with flooded vegetation only in a narrow fringe, so Celestún tells the mangrove story better | Tropical dry forest with Hansen loss scars from 2021–2025 (mostly 2021–2024) and regrowth: "healing after damage". The seed placeholder (16.75, −93.10) was Tuxtla Gutiérrez city |
| Area, vertices, centroid | 457.88 ha, 11, 20.9457 / −90.3182 | 400.21 ha, 13, 16.8453 / −93.0598 |
| Coast check (T14) | Centroid 2.5 km from the Natural Earth 1:10m coastline (which follows the ría): inside the 5 km rule | — |
| Land cover | trees 72.6%, flooded vegetation 21.0%, water 2.2%, grass 2.2%, shrub 2.0% | trees 60.7%, shrub 36.5%, water 2.4%, grass 0.3% |
| Natural fraction | 100% | 100% |
| NDVI (last 12 months) | 0.800 | 0.665 |
| Sen's slope, Mann-Kendall | −0.0083/yr; τ −0.16, p 0.071 (not significant) | −0.0013/yr; τ −0.01, p 0.90 (not significant) |
| Cloud-free obs (12 months), months with data | 64; 59/60 | 63; 59/60 |
| Hansen loss 2021–2025 / 2025 only | 0 / 0 ha | 26.81 / 0.86 ha (6.7% / 0.21% of area: listable) |
| Biomass | 10.72 t/ha (GEDI L4B) | 63.62 t/ha (ESA CCI v6.0, 2022; GEDI has no cell) |
| SOC 0–30 cm | 69.41 t C/ha | 56.71 t C/ha |
| JRC water change | −1.16 | +0.09 |

Notes:
- Dynamic World labels most closed mangrove canopy as **trees**, not flooded vegetation. T14's coastal rule maps only `flooded_vegetation` to mangrove/tidal marsh, so 73% of this mangrove will be valued as tropical forest unless T14 also treats coastal trees in a mangrove site as mangrove (open question for T14).
- The forest boundary was first drawn further north; it included 6.0 ha of 2025 loss (1.24% of the area), which fails the listing gate (`forest_loss_last_12m < 1% of area`). It was redrawn south to keep the 2021–2024 loss scars and exclude the 2025 clearing.
- The forest's NDVI series swings strongly with the dry season, so its trend isn't significant even with plausible restoration deltas (see the scenario table).

### New metrics (all three sites, wetland values otherwise unchanged)
- **`soc_t_c_ha`:** SoilGrids 2.0 organic carbon stock 0–30 cm, `projects/soilgrids-isric/ocs_mean`, band `ocs_0-30cm_mean`, polygon mean at its native 250 m. The mapped unit is t/ha (conversion factor 10 to kg/m², [ISRIC FAQ](https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_01.html)), so the mean is already t C/ha. **Licence verified: CC BY 4.0** (ISRIC data README at files.isric.org/soilgrids/latest/data and the [community catalog](https://gee-community-catalog.org/projects/isric/)); attribution: ISRIC, Poggio et al. (2021). Wetland: 55.41 t C/ha.
- **`forest_loss_last_12m_ha`:** Hansen v1.13 loss in the latest complete year only (`lossyear` 25 = 2025) with the same `treecover2000 ≥ 30` mask, computed in the same `reduceRegion` call as the 5-year loss. It's the calendar year 2025, the closest Hansen gets to "last 12 months". Wetland: 0 ha.
- **`biomass_source`:** GEDI L4B stays the primary biomass so the wetland is unchanged. Where GEDI L4B has no 1 km cell inside the polygon (the forest: none within 3 km), the script falls back to **ESA CCI Biomass v6.0** (`ESA/CCI/Above_Ground_Biomass/V6_0`, band `agb`, 2022 map, 100 m; cite Santoro & Cartus 2025). Each JSON lists only the datasets it used, with their attributions.
- Fix: a month with no usable Sentinel-2 scene used to fail the NDVI call (`Dictionary does not contain key: 'ndvi'`); it now returns null and the month is dropped, as intended. The wetland has data in all 60 months, so its series is unchanged.

All new fields are optional in `EarthObsMetrics`, so older JSON still loads.

### Time Machine scenarios
- **Method:** each simulated version applies scripted, deterministic deltas (`backend/data/demo_sites/scenarios.json`) to its parent version with the pure functions in `app/tools/scenarios.py`. No Earth Engine and no LLM: every number comes from tested code.
  - Land-cover transfers move percentage points between classes, taken from the source classes in proportion to their shares. A transfer larger than its sources is rejected, shares are re-rounded to sum to exactly 1, and `natural_fraction` is recomputed.
  - Tree cover removed by a transfer becomes forest loss (share × area) in both `forest_loss_ha` and `forest_loss_last_12m_ha`; gains never reduce past loss.
  - `ndvi_step_last_12m` shifts the latest 12 monthly values; the 12-month mean, Sen's slope, Kendall's τ and the Mann-Kendall p-value are then recomputed in Python with the same definitions as the Earth Engine reducers (verified against the observed baselines in `tests/test_scenarios.py`). The month labels stay the same.
  - `water_change_delta` and `biomass_pct_change` adjust those metrics; SOC, area, cloud-free observations, datasets and attributions carry over.
  - Each version stores `simulated: true`, `scenario`, `based_on`, `period`, `data_version` and its `scenario_deltas`. `computed_at_utc` is the observed baseline's, so regeneration is byte-stable.
- **Timeline for T38/T43** (chained, so each step's diff shows only that quarter's change):

| Step | `scenario` | `data_version` | Shown as | Based on |
|---|---|---|---|---|
| 1 | `baseline` (observed) | `2026Q3` | 2026Q3 | — |
| 2 | `restoration` ("Next quarter") | `sim-1` | 2026Q4 | `2026Q3` |
| 3 | `encroachment` ("Inject encroachment") | `sim-2` | 2027Q1 | `sim-1` |

- Files: `backend/data/demo_sites/scenarios/<site>.<scenario>.json`; load them with `load_site_metrics(site_key, scenario)`.
- **Resulting base health** with T15's rules (Sen's slope used only when p < 0.05; W only when water + flooded vegetation ≥ 20%; no events, T = 1; no auditor adjustment):

| Site | Scenario | Deltas | V | N | L | W | Base health | Grade |
|---|---|---|---|---|---|---|---|---|
| wetland_mx | baseline | — | 0.625 | 0.839 | 1.000 | 0.434 | 76.2 | A |
| wetland_mx | restoration | crops/built → flooded veg +4 pp, → trees +4 pp; NDVI +0.03 (slope +0.015, p 0.015); water +5; biomass +3% | 0.894 | 0.919 | 1.000 | 0.484 | 87.1 | AA |
| wetland_mx | encroachment | marsh/grass/scrub/water → built 12 pp, trees → built 0.8 pp (1.65 ha loss); NDVI −0.08; water −30; biomass −2% | 0.594 | 0.791 | 0.920 | 0.184 | 68.8 | BBB |
| mangrove_mx | baseline | — | 0.750 | 1.000 | 1.000 | 0.488 | 84.8 | AA |
| mangrove_mx | restoration | grass/scrub → flooded veg 3 pp; NDVI +0.02; water +10; biomass +2% | 0.750 | 1.000 | 1.000 | 0.588 | 86.3 | AA |
| mangrove_mx | encroachment | mangrove → built 3 pp and bare 5 pp (27.5 ha loss); NDVI −0.05 (slope −0.014, p 0.004); water −10; biomass −8% | 0.481 | 0.920 | 0.399 | 0.488 | 62.7 | BBB |
| restoration_forest | baseline | — | 0.666 | 1.000 | 0.330 | 1 (not wetland) | 76.6 | A |
| restoration_forest | restoration | scrub → trees 10 pp; NDVI +0.05 (p 0.24, not significant); biomass +5% | 0.697 | 1.000 | 0.330 | 1 | 77.5 | A |
| restoration_forest | encroachment | forest/scrub → crops 8 pp, → built 2 pp (29.1 ha loss); NDVI −0.06; biomass −10% | 0.659 | 0.900 | 0.000 | 1 | 67.3 | BBB |

- The hero wetland moves one grade up and two down (A → AA → BBB), matching the tour's "A → BBB" against the starting grade. Its encroachment clears only 0.8 pp of trees, so its 2025-equivalent loss stays under the 1% listing-gate limit.
- The mangrove is the stable blue chip: restoration can't lift it past AA, because N, L and the NDVI-mean term are already at 1 and its trend isn't significant. Its gain shows in value (more flooded vegetation, T14) rather than grade.
- The forest's restoration gain stays inside A under T15's significance rule. With the raw slope it would be A → AA.
- **Encroachment fails the listing gate for the mangrove and the forest** (27.5 and 30.0 ha of loss in the last 12 months, over 1% of area). That's deliberate, since cleared trees are forest loss, but T38 must decide whether a re-rated, listed asset that fails the gate is suspended.

### Re-run and check
```bash
cd backend
PATH=$HOME/.local/bin:$PATH uv run --with earthengine-api python ../scripts/precompute_sites.py          # all sites + scenarios
PATH=$HOME/.local/bin:$PATH uv run --with earthengine-api python ../scripts/precompute_sites.py --check  # EE sites + scenarios
PATH=$HOME/.local/bin:$PATH uv run python ../scripts/precompute_sites.py --scenarios-only [--check]     # scenarios only, no EE
```
`tests/test_scenarios.py` and `tests/test_precompute_sites.py` regenerate the scenarios offline in CI and compare them byte for byte with the committed files.

## Licence and terms
- **Earth Engine use appears noncommercial**, subject to the unverified prize-money point below: an individual using it for noncommercial purposes, an open-source project, play money only, no fees, no monetisation. That appears consistent with the "Individual using Earth Engine for noncommercial purposes" category (https://earthengine.google.com/noncommercial/). This is the team's reading, not legal clearance.
- **What counts as commercial:** the commercial examples are "monetization of services built on top of Earth Engine" and material made "to influence current and prospective customers' or investors' decisions". NatureX does neither: the exchange is a sandbox and nothing is a real security.
- **Not addressed by the terms:** hackathon **prize money** isn't mentioned (https://earthengine.google.com/terms/). We treat a prize for an open-source prototype as compatible with noncommercial use, but this is **unverified**. If the team wants certainty, ask the organisers or Earth Engine support. Any real commercial use of NatureX would need an Earth Engine commercial licence.
- **Attribution (CC-BY 4.0):**
  - **Dynamic World:** "This dataset is produced for the Dynamic World Project by Google in partnership with National Geographic Society and the World Resources Institute."
  - **Cloud Score+:** cite Pasquarella et al. (2023).
  - **Sentinel-2:** "Contains modified Copernicus Sentinel data [year]".
  - **SoilGrids (CC BY 4.0):** credit ISRIC and cite Poggio et al. (2021). **ESA CCI Biomass:** cite Santoro & Cartus (2025).
  - T11/T13 store these in the precomputed output; the report page and README show them.

## Consequences
- T11 uses these exact methods in `scripts/precompute_sites.py`, with a hand-drawn hero boundary in the wetland area above, and stores dataset versions and attributions with the cached metrics.
- T13's `earth_obs` tool wraps the same functions behind the mock interface (`USE_MOCKS=true` in CI).
- Water change (JRC), forest loss (Hansen, 5-year and latest year), biomass (GEDI L4B with an ESA CCI fallback) and SoilGrids SOC are in place (T11/T13), one call per metric.

## Alternatives considered
- **Microsoft Planetary Computer:** lacks Dynamic World, Hansen and GEDI (ADR-0001), so it's a fallback only.
- **QA60 cloud mask instead of Cloud Score+:** coarser; Google's catalog recommends Cloud Score+ for Sentinel-2 surface analysis.
- **Mean of daily NDVI instead of a monthly median composite:** more sensitive to residual clouds; the median composite is the standard approach.
