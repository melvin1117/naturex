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
| Biomass | `LARSE/GEDI/GEDI04_B_002` · `MU` | GEDI L4B Version 2; 2019-04-18 to 2021-08-04 | Official gridded above-ground biomass density in Mg/ha with coverage over the Mexico City site. ESA CCI Biomass was not used because the checked EE catalog URL was unavailable; GEDI L4B is documented and returned coverage for the hero polygon. **Superseded in the T13 review:** ESA CCI Biomass v6.0 (`ESA/CCI/Above_Ground_Biomass/V6_0`, 2022, 100 m) is now primary and GEDI L4B a cross-check (see below). |

Hero metrics produced by T11:
- NDVI last-12-month mean: 0.6008.
- Sen's slope: +0.0097 NDVI/year.
- Mann-Kendall: τ = +0.1469, p = 0.0986 (not significant at 5%).
- Cloud-free Sentinel-2 observations in the last 12 months: 73; all 60 months have clear data. A scene counts only if `cs_cdf >= 0.60` for at least 50% of the polygon's non-water pixels.
- JRC water change mean (`change_abs`): −6.6021.
- Hansen forest loss in the latest five complete dataset years, masked to `treecover2000 >= 30%`: 0.0 ha.
- Above-ground biomass: 17.7435 t/ha (ESA CCI v6.0, 2022; primary since the T13 review). GEDI L4B cross-check: 9.4681 t/ha (T11's original value).
- Soil organic carbon 0–30 cm (T13): 55.4083 t C/ha. Global Mangrove Watch share (T13): 0.

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
| Biomass (ESA CCI v6.0, 2022) | 18.51 t/ha (GEDI cross-check 10.72) | 63.62 t/ha (GEDI has no cell: null) |
| Mangrove share (GMW v3, 2020) | 94.84% | 0% |
| SOC 0–30 cm | 69.41 t C/ha | 56.71 t C/ha |
| JRC water change | −1.16 | +0.09 |

Notes:
- Dynamic World labels most closed mangrove canopy as **trees**, not flooded vegetation, so land cover alone can't say how much of a site is mangrove. **Decision (T13 review):** `mangrove_fraction` from Global Mangrove Watch v3 says it, and T14 values `min(mangrove_fraction, trees + flooded_vegetation)` as mangrove, taken from flooded vegetation first, then trees. Here GMW maps 94.8% of the polygon as mangrove against 93.6% trees + flooded vegetation, so 93.6% is valued as mangrove.
- The forest boundary was first drawn further north; it included 6.0 ha of 2025 loss (1.24% of the area), which fails the listing gate (`forest_loss_last_12m < 1% of area`). It was redrawn south to keep the 2021–2024 loss scars and exclude the 2025 clearing.
- The forest's NDVI series swings strongly with the dry season, so its trend isn't significant even with plausible restoration deltas (see the scenario table).

### New metrics (all three sites, wetland values otherwise unchanged)
- **`soc_t_c_ha`:** SoilGrids 2.0 organic carbon stock 0–30 cm, `projects/soilgrids-isric/ocs_mean`, band `ocs_0-30cm_mean`, polygon mean at its native 250 m. The mapped unit is t/ha (conversion factor 10 to kg/m², [ISRIC FAQ](https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_01.html)), so the mean is already t C/ha. **Licence verified: CC BY 4.0** (ISRIC data README at files.isric.org/soilgrids/latest/data and the [community catalog](https://gee-community-catalog.org/projects/isric/)); attribution: ISRIC, Poggio et al. (2021). Wetland: 55.41 t C/ha.
- **`forest_loss_last_12m_ha`:** Hansen v1.13 loss in the latest complete year only (`lossyear` 25 = 2025) with the same `treecover2000 ≥ 30` mask, computed in the same `reduceRegion` call as the 5-year loss. It's the calendar year 2025, the closest Hansen gets to "last 12 months". Wetland: 0 ha.
- **Biomass (decision in the T13 review):** **ESA CCI Biomass v6.0** (`ESA/CCI/Above_Ground_Biomass/V6_0`, band `agb`, 2022 map, 100 m, Mg/ha; cite Santoro & Cartus 2025) is now the primary `biomass_t_ha` for every site (`biomass_source: "esa_cci_biomass"`), matching `docs/research.md`. GEDI L4B (1 km, 2019–2021) is kept as the cross-check `biomass_gedi_t_ha`, which is null where GEDI has no 1 km cell inside the polygon (the forest has none within 3 km). Both come back in one `getInfo()` call. The wetland's biomass changes from 9.47 (GEDI) to 17.74 t/ha (ESA CCI). Each JSON lists only the datasets that returned a value, with their attributions.
- **`mangrove_fraction`:** area-weighted share of the polygon in **Global Mangrove Watch v3.0** (`projects/sat-io/open-datasets/GMW/extent/GMW_V3`, an ImageCollection of 11 epochs from 1996 to 2020; the latest, `gmw_v3_2020`, is used). Band `b1` is 1 for mangrove and masked elsewhere, at ~25 m; pixel area is summed at 10 m. Licence **CC BY 4.0** (Zenodo record 6894273, v3.0); cite Bunting et al. (2022), Remote Sensing 14(15):3657. Wetland 0, mangrove 0.9484, forest 0.
- Fix: a month with no usable Sentinel-2 scene used to fail the NDVI call (`Dictionary does not contain key: 'ndvi'`); it now returns null and the month is dropped, as intended. The wetland has data in all 60 months, so its series is unchanged.

All new fields are optional in `EarthObsMetrics`, so older JSON still loads.

### Time Machine scenarios
- **Method:** each simulated version applies scripted, deterministic deltas (`backend/data/demo_sites/scenarios.json`) to its parent version with the pure functions in `app/tools/scenarios.py`. No Earth Engine and no LLM: every number comes from tested code.
  - Land-cover transfers move percentage points between classes, taken from the source classes in proportion to their shares. A transfer larger than its sources is rejected, shares are re-rounded to sum to exactly 1, and `natural_fraction` is recomputed.
  - Tree cover removed by a transfer becomes forest loss (share × area) in both `forest_loss_ha` and `forest_loss_last_12m_ha`; gains never reduce past loss.
  - `ndvi_step_last_12m` shifts the latest 12 monthly values; the 12-month mean, Sen's slope, Kendall's τ and the Mann-Kendall p-value are then recomputed in Python with the same definitions as the Earth Engine reducers (verified against the observed baselines in `tests/test_scenarios.py`). The month labels stay the same.
  - `water_change_delta` and `biomass_pct_change` adjust those metrics (the GEDI cross-check scales with the primary biomass). SOC, area, cloud-free observations, datasets and attributions carry over.
  - `mangrove_fraction` shrinks in proportion to the trees + flooded vegetation that transfers clear (mangrove is assumed spread evenly over those classes). Gains never add mangrove, since replanted seedlings aren't mapped yet, and the result never exceeds trees + flooded vegetation.
  - Each version stores `simulated: true`, `scenario`, `based_on`, `period`, `data_version`, `observed_data_version`, its `scenario_deltas` and a `provenance_note`. The note says that `date_windows`, `datasets` and `thresholds` describe the observed data the chain starts from, not the simulated version. `date_windows` stays in place because T15 reads `date_windows["ndvi"]` for recency; the UI must not show it as an observation period (T38/T43 note in `tasks/todo.md`). `EarthObsMetrics` rejects files where `simulated` disagrees with `scenario` or a simulated version lacks these fields, and `load_site_metrics` rejects a file whose site or scenario isn't the one requested.
  - `computed_at_utc` is the observed baseline's, so regeneration is byte-stable.
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
- The mangrove is the stable blue chip: restoration can't lift it past AA, because N, L and the NDVI-mean term are already at 1 and its trend isn't significant. Its gain shows in value rather than grade: trees + flooded vegetation rise to 96.6%, so the mangrove T14 values rises from 93.6% to the full GMW 94.8%.
- The forest's restoration gain stays inside A under T15's significance rule. With the raw slope it would be A → AA.
- **Encroachment fails the listing gate for the mangrove and the forest** (27.5 and 30.0 ha of loss in the last 12 months, over 1% of area). That's deliberate, since cleared trees are forest loss. **Decision (T13 review):** the gate applies only at listing time; re-rating a listed asset doesn't suspend it (recorded under T38 in `tasks/todo.md`).

### Existing databases
`app/seed.py` refreshes each demo site's name, description, boundary, area and centroid on **every** asset with that `site_key`, in the template and in visitor worlds, because these are template content, not visitor state. Shares, cash, the community wallet and status are never touched. The API seeds only an empty database, so **databases seeded before T13 need `make seed` once** to replace the old placeholder squares.

### Re-run and check
```bash
cd backend
PATH=$HOME/.local/bin:$PATH uv run --with earthengine-api python ../scripts/precompute_sites.py          # all sites + scenarios
PATH=$HOME/.local/bin:$PATH uv run --with earthengine-api python ../scripts/precompute_sites.py --check  # EE sites + scenarios
PATH=$HOME/.local/bin:$PATH uv run python ../scripts/precompute_sites.py --scenarios-only [--check]     # scenarios only, no EE
```
`tests/test_scenarios.py` and `tests/test_precompute_sites.py` regenerate the scenarios offline in CI and compare them byte for byte with the committed files.

## As built (T35, 2026-10-07): land-cover overlays and thumbnails

Each demo site has two precomputed images and a sidecar in `backend/data/demo_sites/images/` (a subfolder, like `scenarios/`, so nothing that lists `demo_sites/*.json` picks them up):

| File | What | Format, size |
|---|---|---|
| `<site>.overlay.png` | Dynamic World land cover clipped to the polygon, for a Leaflet `ImageOverlay` | Indexed PNG: the 9 official classes + 1 transparent entry; 1024 px on the long side; 5.5–9 KB |
| `<site>.thumbnail.webp` | Sentinel-2 true-colour marketplace thumbnail with the polygon outline | 640×400 lossy WebP (quality 82); 14–39 KB |
| `<site>.images.json` | Sidecar (`SiteImages` in `app/tools/site_images.py`) | Bounds, CRS, palette, legend, date window, method, visualisation, attributions |

| Site | Overlay | Thumbnail |
|---|---|---|
| `wetland_mx` | 1024×946, 8,984 B | 640×400, 38,580 B |
| `mangrove_mx` | 894×1024, 8,916 B | 640×400, 14,504 B |
| `restoration_forest` | 1024×452, 5,542 B | 640×400, 27,884 B |

- **Overlay method:** the same per-pixel mode of `GOOGLE/DYNAMICWORLD/V1` `label` as the land-cover metric (2025-10-01 to 2026-10-01), `clip`ped to the polygon and `unmask(255)`ed so outside is a distinct value, fetched with `ee.data.computePixels` on an explicit **EPSG:3857 grid that spans exactly the polygon's bounding box** (nearest-neighbour at 1.8–3.4 Web Mercator metres per pixel, so each 10 m pixel stays a crisp block). Leaflet stretches an `ImageOverlay` linearly between its corner points in Web Mercator, so a Mercator grid lines up exactly; the sidecar's `bounds` (`[[south, west], [north, east]]`) are the GeoJSON's bounds.
  - Palette and class order are the official Dynamic World ones (`#419bdf` water, `#397d49` trees, `#88b053` grass, `#7a87c6` flooded vegetation, `#e49635` crops, `#dfc35a` shrub and scrub, `#c4281b` built, `#a59b8f` bare, `#b39fe1` snow and ice).
  - **Encoding:** a small stdlib encoder (`encode_indexed_png`) writes the PNG with no timestamps, so the same pixels give the same bytes. PNG, not WebP, because the overlay is categorical: lossless, a 10-entry palette with a transparent index, and it compresses to under 10 KB.
  - **Consistency:** the overlay's class shares match the committed `landcover` fractions within 0.3 pp (wetland: water 24.72% vs 24.84%, trees 35.64% vs 35.74%); the check allows 1.5 pp. Its opaque share matches the polygon's share of the bounding box within 2 pp.
- **Thumbnail method:** median of `COPERNICUS/S2_SR_HARMONIZED` B4/B3/B2 over the same 12 months, each scene masked where Cloud Score+ `cs_cdf` < 0.60 (as for NDVI), `visualize(min=0, max=2500, gamma=1.1)`, fetched on a 640×400 EPSG:3857 grid centred on the polygon with a 25% margin (square pixels, 5.3–8.6 Web Mercator metres). The outline is drawn locally with Pillow (white, 2 px, anti-aliased by 4× supersampling) from the GeoJSON, so it's exact. **WebP, not PNG,** because a 640×400 photo is 180–290 KB as PNG and 14–39 KB as WebP at quality 82, which every current browser decodes.
- **Attribution** isn't burned into the pixels: the sidecar carries it (overlay: Dynamic World and "Contains modified Copernicus Sentinel data 2025-2026"; thumbnail: Copernicus Sentinel and Cloud Score+), and the UI shows it in captions. The basemap credit (© OpenStreetMap contributors) is Leaflet's attribution control.
- **Scenarios: baseline only.** Time Machine versions change land-cover *fractions* by scripted deltas; there's no per-pixel map, so drawing one would invent pixels. The sidecar says so (`scenario: "baseline"`, `scenario_note`) and the UI must label the overlay as observed.
- **Serving:** `GET /media/demo-sites/{site_key}/overlay.png | thumbnail.webp | images.json` (`app/routers/media.py`), public (no world needed: public demo data), read-only. The key must match `^[a-z0-9_]{1,64}$` **and** be a committed demo site (a `*.geojson` stem) before any path is built; the resolved path must stay under `images/`. Everything else is 404. Responses carry the exact content type, `Cache-Control: public, max-age=86400` (not `immutable`: URLs aren't content-hashed) and `X-Content-Type-Options: nosniff`. The browser fetches them through the frontend's `/api` proxy. Serving from the backend keeps one copy of each file in git (no copy step into `frontend/public/`) and works the same wherever the backend is hosted (T20).

Re-run and check:

```bash
cd backend
PATH=$HOME/.local/bin:$PATH uv run --with earthengine-api --with pillow python ../scripts/precompute_sites.py --images  # ~2 min
PATH=$HOME/.local/bin:$PATH uv run python ../scripts/precompute_sites.py --images --check                             # offline, no EE
```

`--images` renders only the images (not the metrics). Byte-identical output isn't guaranteed: Earth Engine collections can gain or reprocess scenes. So `--images --check` (and `tests/test_site_images.py`, `tests/test_precompute_sites.py`) verify the committed files offline instead: they exist and decode; dimensions; the 300 KB budget; overlay bounds equal the GeoJSON bounds and the thumbnail grid contains the polygon; the official palette and legend; attributions; class shares against the metrics; transparency outside the polygon; and that the sidecar equals what the script would write.

## As built (T60, 2026-10-19): live metrics for new listings
The demo sites stay precomputed and the judging path still never calls Earth Engine. A **new listing**'s polygon has no precomputed file, so with `EARTH_ENGINE_LIVE=true` its rating run computes the same metrics live:
- **One implementation:** the reductions above moved to `backend/app/tools/earth_engine.py`; `scripts/precompute_sites.py` and the API both call `compute_polygon_metrics`. A live `--check` after the move matched the committed files (only Dynamic World drift of 0.001 on `mangrove_mx`, identical with the old script).
- **Bounded use of the Community tier:** results are cached by geometry hash and data version; one computation at a time per process, a 120 s timeout (per request, no retries, and overall), at most 5,000 ha; two live ratings per account per day and 50 a day in total for the live world. Details in dev-spec §7.2 "As built (T60)".
- **Demo sandboxes compute too, as hidden guardrails** (originally live world only; judges now rate land of their choice in their sandbox). One policy (`earth_obs_live.live_policy`) decides: at most 3 live ratings a day per sandbox (`SANDBOX_LIVE_RATINGS_PER_WORLD_PER_DAY`, all its personas together, so one visitor can't drain the rest) and 20 a day across all sandboxes (`SANDBOX_LIVE_RATINGS_PER_DAY`), counted apart from the live world's 50 so sandboxes never use them up. A sandbox takes the computation slot only if it is free right now: it never waits, so it can't queue ahead of a live-world rating; when busy, its live rating is refunded. A sandbox whose rating is refused (any cap, the slot, or the area limit) never sees an error: the submit succeeds and the run falls back to mocks or the cached example, as before sandboxes computed. Its overlay and before/after views render only when the run itself computed (never for a cache hit), on a lane of their own (one worker per kind, none queued, skipped when busy), so they never wait in or fill the live world's render queue.
- **Free-tier margin:** the Community tier allows 150 EECU-hours a month, about 5 a day. The caps allow at most 70 live computations a day (50 live world + 20 sandboxes), each with an overlay and two true-colour composites, so the tier holds while a rating with its renders costs under about 4 EECU-minutes (5 h / 70). **EECU per rating isn't measured yet** (the 12.2 s below is wall time, not EECU); measure it on Earth Engine's task and profiler pages before raising any cap.
- **Live run:** a 49 ha polygon next to the mangrove site took 12.2 s (cache hit 81 ms), in line with the T03 timings above.
- The terms reading below is unchanged: live ratings are still noncommercial play-money use, and the prize-money point is still open (research.md §6).

## Licence and terms
- **Earth Engine use appears noncommercial**, subject to the unverified prize-money point below: an individual using it for noncommercial purposes, an open-source project, play money only, no fees, no monetisation. That appears consistent with the "Individual using Earth Engine for noncommercial purposes" category (https://earthengine.google.com/noncommercial/). This is the team's reading, not legal clearance.
- **What counts as commercial:** the commercial examples are "monetization of services built on top of Earth Engine" and material made "to influence current and prospective customers' or investors' decisions". WildWorth does neither: the exchange is a sandbox and nothing is a real security.
- **Not addressed by the terms:** hackathon **prize money** isn't mentioned (https://earthengine.google.com/terms/). We treat a prize for an open-source prototype as compatible with noncommercial use, but this is **unverified**. If the team wants certainty, ask the organisers or Earth Engine support. Any real commercial use of WildWorth would need an Earth Engine commercial licence.
- **Attribution (CC-BY 4.0):**
  - **Dynamic World:** "This dataset is produced for the Dynamic World Project by Google in partnership with National Geographic Society and the World Resources Institute."
  - **Cloud Score+:** cite Pasquarella et al. (2023).
  - **Sentinel-2:** "Contains modified Copernicus Sentinel data [year]".
  - **SoilGrids (CC BY 4.0):** credit ISRIC and cite Poggio et al. (2021). **ESA CCI Biomass:** cite Santoro & Cartus (2025). **Global Mangrove Watch (CC BY 4.0):** cite Bunting et al. (2022).
  - T11/T13 store these in the precomputed output; the report page and README show them.

## Consequences
- T11 uses these exact methods in `scripts/precompute_sites.py`, with a hand-drawn hero boundary in the wetland area above, and stores dataset versions and attributions with the cached metrics.
- T13's `earth_obs` tool wraps the same functions behind the mock interface (`USE_MOCKS=true` in CI).
- Water change (JRC), forest loss (Hansen, 5-year and latest year), biomass (ESA CCI primary, GEDI L4B cross-check), Global Mangrove Watch share and SoilGrids SOC are in place (T11/T13), one call per metric.

## Alternatives considered
- **Microsoft Planetary Computer:** lacks Dynamic World, Hansen and GEDI (ADR-0001), so it's a fallback only.
- **QA60 cloud mask instead of Cloud Score+:** coarser; Google's catalog recommends Cloud Score+ for Sentinel-2 surface analysis.
- **Mean of daily NDVI instead of a monthly median composite:** more sensitive to residual clouds; the median composite is the standard approach.
