# Natural Earth coastline (valuation coastal check)

`ne_10m_coastline.geojson.gz` is the **Natural Earth 1:10m Coastline** layer, release
**v5.1.2**, gzip-compressed but otherwise unmodified (no simplification or rounding).
The valuation engine (`app/tools/coastline.py`, dev-spec §7.3) uses it to decide whether a
site's centroid is within 5 km of the sea coast.

| | |
|---|---|
| Source | https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_10m_coastline.geojson (also at https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-coastline/) |
| Version | v5.1.2 (4,133 LineStrings, 410,957 vertices, WGS84 lon/lat) |
| SHA-256 of the uncompressed GeoJSON | `6f75ae0e0de157b14946e2255eb1f5486d9a13819032e26d4610852d296788f6` |
| Size | 10.1 MB raw, 3.4 MB gzipped |
| Licence | Public domain ([terms of use](https://www.naturalearthdata.com/about/terms-of-use/)); attribution optional |
| Attribution | Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com. |

## Regenerate

From the repository root (stdlib only):

```bash
python3 scripts/fetch_coastline.py
```

The script downloads the tagged release, checks the SHA-256 above and rewrites the gzip
with a fixed header (level 9, mtime 0), so the committed file is reproduced byte for byte.
`backend/tests/test_coastline.py` checks the hash.
