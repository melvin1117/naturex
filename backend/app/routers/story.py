"""The judge story's data (`GET /story`): public, free and the same for every visitor.

The numbers come from `app.services.story`, which runs the product's own rating, market and
ledger functions over committed demo data; no database, no model.
"""

from __future__ import annotations

from fastapi import APIRouter, Response

from app.schemas import StoryOut
from app.services.story import build_story

router = APIRouter(tags=["story"])

STORY_CACHE = "public, max-age=3600"


@router.get("/story", response_model=StoryOut)
def get_story(response: Response) -> StoryOut:
    """Everything the `/judge` story shows about the hero wetland: its land, its ratings as it
    is, damaged and restored (simulated), one supporter's backing and a tamper-evident record."""
    response.headers["Cache-Control"] = STORY_CACHE
    return build_story()
