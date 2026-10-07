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

## Licence and terms
- **Earth Engine use appears noncommercial**, subject to the unverified prize-money point below: an individual using it for noncommercial purposes, an open-source project, play money only, no fees, no monetisation. That appears consistent with the "Individual using Earth Engine for noncommercial purposes" category (https://earthengine.google.com/noncommercial/). This is the team's reading, not legal clearance.
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
