"""Download the Natural Earth 1:10m coastline bundled for the valuation coastal check (T14).

Run from the repository root (stdlib only, no uv needed):

    python3 scripts/fetch_coastline.py

It fetches the GeoJSON from the tagged natural-earth-vector release, checks its SHA-256,
and writes it gzip-compressed (level 9, mtime 0, so the output is byte-for-byte
reproducible) to ``backend/data/coastline/ne_10m_coastline.geojson.gz``. The content is
not simplified or rounded: the gzip only shrinks it from ~10 MB to ~3.4 MB.
Natural Earth data is public domain.
"""

from __future__ import annotations

import gzip
import hashlib
import sys
import urllib.request
from pathlib import Path

VERSION = "v5.1.2"
URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    f"{VERSION}/geojson/ne_10m_coastline.geojson"
)
SHA256 = "6f75ae0e0de157b14946e2255eb1f5486d9a13819032e26d4610852d296788f6"
OUT = Path(__file__).resolve().parents[1] / "backend" / "data" / "coastline"
OUT_FILE = OUT / "ne_10m_coastline.geojson.gz"


def main() -> int:
    with urllib.request.urlopen(URL, timeout=120) as response:
        raw: bytes = response.read()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != SHA256:
        print(f"SHA-256 mismatch: got {digest}, expected {SHA256}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    print(f"Wrote {OUT_FILE} ({OUT_FILE.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
