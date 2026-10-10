"""Public, read-only demo-site images (T35): land-cover overlay, thumbnail and sidecar.

The files are precomputed public demo data, so no world or session is needed. The site key
must match an allowlist pattern and a committed demo site before any path is built.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse

from app.tools.site_images import MEDIA_TYPES, ImageKind, SiteImages, served_image_path

router = APIRouter(prefix="/media/demo-sites", tags=["media"])

# Not `immutable`: URLs aren't content-hashed, and a re-run of the precompute replaces files.
CACHE_CONTROL = "public, max-age=86400"
_HEADERS = {"Cache-Control": CACHE_CONTROL, "X-Content-Type-Options": "nosniff"}
_NOT_FOUND: dict[int | str, dict[str, Any]] = {404: {"description": "Unknown demo site"}}


def _binary(media_type: str, description: str) -> dict[int | str, dict[str, Any]]:
    schema = {"type": "string", "format": "binary"}
    return {200: {"description": description, "content": {media_type: {"schema": schema}}}}


def _file(site_key: str, kind: ImageKind) -> FileResponse:
    path = served_image_path(site_key, kind)
    if path is None:
        raise HTTPException(status_code=404, detail="Unknown demo site")
    return FileResponse(path, media_type=MEDIA_TYPES[kind], headers=_HEADERS)


@router.get(
    "/{site_key}/overlay.png",
    response_class=FileResponse,
    responses={**_binary("image/png", "Land-cover overlay PNG"), **_NOT_FOUND},
)
def get_overlay(site_key: str) -> FileResponse:
    """Dynamic World land cover clipped to the polygon (transparent outside it)."""
    return _file(site_key, "overlay")


@router.get(
    "/{site_key}/thumbnail.webp",
    response_class=FileResponse,
    responses={**_binary("image/webp", "Marketplace thumbnail WebP"), **_NOT_FOUND},
)
def get_thumbnail(site_key: str) -> FileResponse:
    """Sentinel-2 true-colour thumbnail with the polygon outline."""
    return _file(site_key, "thumbnail")


@router.get("/{site_key}/images.json", response_model=SiteImages, responses=_NOT_FOUND)
def get_site_images(site_key: str, response: Response) -> SiteImages:
    """Overlay bounds, palette and legend, thumbnail metadata, date windows and attributions."""
    path = served_image_path(site_key, "sidecar")
    if path is None:
        raise HTTPException(status_code=404, detail="Unknown demo site")
    response.headers.update(_HEADERS)
    return SiteImages.model_validate_json(path.read_text())
