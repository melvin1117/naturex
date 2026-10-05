"""API request and response models (the OpenAPI contract; the frontend client is generated)."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models import LedgerKind


class LedgerEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    seq: int
    kind: LedgerKind
    ref_id: UUID | None
    payload: dict[str, Any]
    prev_hash: str
    hash: str
    created_at: datetime


class LedgerVerifyOut(BaseModel):
    valid: bool
    entries: int
    head: str | None = Field(description="Hash of the last entry; null when the chain is broken")
    broken_at: int | None = Field(description="First failing entry; null when the chain is valid")


class TamperDemoIn(BaseModel):
    asset_id: UUID
    seq: int | None = Field(default=None, ge=0, description="Entry to edit; defaults to the latest")


class TamperDemoOut(BaseModel):
    seq: int
    field: str
    before: Any
    after: Any
    verify: LedgerVerifyOut
