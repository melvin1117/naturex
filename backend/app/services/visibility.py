"""`lifecycle.is_public` as a query filter, for the routes and services that list assets. Kept
apart from `app.services.listings` (which imports the policy) so the sandbox can use it without an
import cycle; `tests/test_lifecycle.py` checks that both answer the same for every status."""

from __future__ import annotations

from sqlalchemy import ColumnElement, and_
from sqlmodel import col

from app.models import Asset
from app.services.lifecycle import GATED_STATUSES


def public_assets() -> ColumnElement[bool]:
    """Assets anyone in the world may see: `lifecycle.is_public` on `Asset` rows."""
    return and_(col(Asset.status).in_(GATED_STATUSES), col(Asset.ipo_at).is_not(None))
