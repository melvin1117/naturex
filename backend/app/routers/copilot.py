"""Investor Copilot (T39): grounded, cited answers streamed over SSE.

`POST /copilot` authorizes like before (`use_own_account` in the caller's world; an `asset_id`
outside it or hidden from the caller is 404), then `prepared_question` indexes and retrieves
before the response starts (429 `copilot_rate_limited`, 503 `copilot_unavailable`). The stream
is `sources` (what was retrieved), `delta` pieces of the checked answer, then `done` with the
full answer and its citations; see `app.rag.answer` for the checks.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.sse import EventSourceResponse

from app.authz import (
    Action,
    DenyReason,
    OptionalActor,
    WorldRef,
    acting_world,
    asset_ref_in,
    can_see,
    denied,
    require,
)
from app.deps import SessionDep, SettingsDep
from app.llm import LLMError
from app.rag.answer import Source, answer_question, stream_pieces
from app.rag.service import (
    CopilotModels,
    CopilotRateLimited,
    CopilotUnavailable,
    PreparedQuestion,
    copilot_models,
    prepare,
)
from app.schemas import (
    CopilotDeltaEvent,
    CopilotDoneEvent,
    CopilotErrorEvent,
    CopilotRequest,
    CopilotSource,
    CopilotSourcesEvent,
    CopilotStreamEvent,
)

router = APIRouter(tags=["copilot"])
log = logging.getLogger(__name__)

RATE_LIMITED = "copilot_rate_limited"
UNAVAILABLE = "copilot_unavailable"


def copilot_world(
    body: CopilotRequest, actor: OptionalActor, session: SessionDep
) -> WorldRef | None:
    """The caller's world, if the asset asked about (if any) is in it by `(world_id, id)` and
    visible to the caller (T58); None (a 404) otherwise. `body` is the route's own, parsed once."""
    world_id = acting_world(actor)
    if body.asset_id is not None:
        asset = asset_ref_in(session, world_id, body.asset_id)
        if asset is None or not can_see(actor, asset):
            return None
    return WorldRef(world_id)


def copilot_models_dep(settings: SettingsDep) -> CopilotModels:
    try:
        return copilot_models(settings)
    except LLMError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, UNAVAILABLE) from exc


def prepared_question(
    body: CopilotRequest,
    actor: OptionalActor,
    session: SessionDep,
    settings: SettingsDep,
    models: Annotated[CopilotModels, Depends(copilot_models_dep)],
) -> PreparedQuestion:
    try:
        return prepare(
            session, actor, acting_world(actor), body.question, body.asset_id, models, settings
        )
    except CopilotRateLimited as exc:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, RATE_LIMITED) from exc
    except (LLMError, CopilotUnavailable) as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, UNAVAILABLE) from exc


def source_out(source: Source) -> CopilotSource:
    return CopilotSource(
        ref=source.ref,
        kind=source.kind.value,
        asset_id=source.asset_id,
        asset_name=source.asset_name,
        title=source.title,
        snippet=source.snippet,
        report_id=source.report_id,
        event_id=source.event_id,
        version=source.version,
    )


@router.post(
    "/copilot",
    response_class=EventSourceResponse,
    dependencies=[require(Action.USE_OWN_ACCOUNT, copilot_world)],
    responses={
        **denied(DenyReason.TREASURY_CANNOT_ACT),
        429: {
            "description": f"`{RATE_LIMITED}`: the account's or the world's hourly Copilot "
            "questions, or the world's Copilot model calls, are used up"
        },
        503: {
            "description": f"`{UNAVAILABLE}`: the question can't be embedded (no key, provider "
            "down, LLM_BUDGET_USD reached) or only LLM_RESERVE_USD is left"
        },
    },
)
def ask_copilot(
    prepared: Annotated[PreparedQuestion, Depends(prepared_question)],
) -> Iterator[CopilotStreamEvent]:
    """Stream a grounded answer: `sources`, then `delta` pieces, then `done` (or `error`)."""
    yield CopilotSourcesEvent(sources=[source_out(s) for s in prepared.sources])
    try:
        answer = answer_question(
            prepared.question,
            prepared.sources,
            prepared.llm,
            world_id=prepared.world_id,
            asset_id=prepared.asset_id,
        )
    except Exception:
        log.exception("copilot answer failed")
        yield CopilotErrorEvent(detail="copilot_failed")
        return
    for piece in stream_pieces(answer.text):
        yield CopilotDeltaEvent(text=piece)
    yield CopilotDoneEvent(
        answer=answer.text,
        citations=[source_out(s) for s in answer.cited],
        mode=answer.mode.value,
        model=answer.model,
    )
