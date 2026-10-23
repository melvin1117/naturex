"""The demo-world "cached example" (T60).

In a demo sandbox, a new listing waiting in `rating` for satellite metrics (none: live Earth
Engine is off or `SANDBOX_LIVE_RATINGS_PER_DAY=0`, or a failed live computation) is pointed by
`AssetDetail` to the nearest precomputed demo site of the same world, with an explicit notice.
It is shown next to the listing, never as its data: the listing keeps no report and stays in
`rating`. Never in the live world.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from uuid import UUID

from sqlmodel import Session, col, select

from app.models import Asset, AssetStatus
from app.services.lifecycle import NO_SATELLITE_METRICS, RATING_FAILED_PREFIX
from app.services.visibility import public_assets
from app.worlds import LIVE_WORLD_ID

EARTH_OBS_FAILED = f"{RATING_FAILED_PREFIX}earth_obs_failed:"
EARTH_RADIUS_KM = 6371.0088


@dataclass(frozen=True, slots=True)
class CachedExample:
    asset_id: UUID
    name: str
    site_key: str
    distance_km: float
    notice: str


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle (haversine) distance."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def waiting_for_satellite_metrics(asset: Asset) -> bool:
    """A new listing still in `rating` because it has no satellite metrics (none, or a failed
    live computation)."""
    reason = asset.status_reason or ""
    return (
        asset.site_key is None
        and asset.status is AssetStatus.RATING
        and (reason == NO_SATELLITE_METRICS or reason.startswith(EARTH_OBS_FAILED))
    )


def cached_example(session: Session, asset: Asset) -> CachedExample | None:
    """The nearest precomputed demo site of the asset's demo world, or None (the live world, a
    listing not waiting for metrics, or no public demo site)."""
    if asset.world_id == LIVE_WORLD_ID or not waiting_for_satellite_metrics(asset):
        return None
    lat, lon = asset.centroid_lat, asset.centroid_lon
    if lat is None or lon is None:
        return None
    sites = [
        (site, site.site_key, site.centroid_lat, site.centroid_lon)
        for site in session.exec(
            select(Asset).where(
                Asset.world_id == asset.world_id,
                col(Asset.site_key).is_not(None),
                public_assets(),
            )
        ).all()
    ]
    located = [
        (distance_km(lat, lon, s_lat, s_lon), site, key)
        for site, key, s_lat, s_lon in sites
        if key is not None and s_lat is not None and s_lon is not None
    ]
    if not located:
        return None
    km, site, key = min(located, key=lambda item: item[0])  # a tie keeps the first
    return CachedExample(
        asset_id=site.id,
        name=site.name,
        site_key=key,
        distance_km=round(km, 1),
        notice=(
            f"Cached example: there are no satellite metrics for this land yet. "
            f"{site.name}, a precomputed demo site {km:,.0f} km away, shows what a rating looks "
            f"like. Its numbers describe that site, not this land."
        ),
    )
