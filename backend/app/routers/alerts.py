"""The signed-in account's alerts (T75): list with read/unread state, mark one or all read.

Every route is `use_own_account` on the world (a signed-in person; treasuries can't act) and
reads only the caller's own `alert_recipients` rows in the session's world, so another account's
or another world's alert is 404 `not_found`. `community_id` (the Steward home) narrows to the
alerts about that community's assets and is accepted only from its members (else 404
`not_found`, so it reveals nothing). The alerts themselves are raised by re-rates and the news
sweep (`app.services.alerts`).
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from sqlmodel import Session

from app.auth import Principal
from app.authz import Action, DenyReason, denied, require
from app.deps import CurrentPrincipal, CurrentWorld, SessionDep
from app.schemas import AlertListOut, AlertOut, AlertsMarkedOut
from app.services import alerts as alert_service

router = APIRouter(prefix="/alerts", tags=["alerts"])
OWN_ACCOUNT = require(Action.USE_OWN_ACCOUNT)
RESPONSES = denied(DenyReason.TREASURY_CANNOT_ACT)
CommunityFilter = Annotated[
    UUID | None, Query(description="Only alerts about this community's assets (members only)")
]


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, DenyReason.NOT_FOUND.value)


def _check_community(
    session: Session, world_id: UUID, principal: Principal, community_id: UUID | None
) -> None:
    if community_id is not None and not alert_service.is_member(
        session, world_id, principal.user_id, community_id
    ):
        raise _not_found()


@router.get("", response_model=AlertListOut, dependencies=[OWN_ACCOUNT], responses=RESPONSES)
def list_alerts(
    principal: CurrentPrincipal,
    world: CurrentWorld,
    session: SessionDep,
    community_id: CommunityFilter = None,
    unread_only: Annotated[bool, Query()] = False,
    before: Annotated[
        UUID | None, Query(description="The previous page's `next_before` cursor")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=alert_service.ALERT_PAGE_MAX)] = (
        alert_service.ALERT_PAGE
    ),
) -> AlertListOut:
    """My alerts in this world, newest first, a page at a time, with the unread count."""
    _check_community(session, world.id, principal, community_id)
    try:
        page, next_before = alert_service.list_alerts(
            session,
            world.id,
            principal.user_id,
            limit=limit,
            unread_only=unread_only,
            community_id=community_id,
            before=before,
        )
    except alert_service.CursorNotFound as exc:
        raise _not_found() from exc
    return AlertListOut(
        alerts=page,
        unread_count=alert_service.unread_count(
            session, world.id, principal.user_id, community_id=community_id
        ),
        next_before=next_before,
    )


@router.post(
    "/read-all", response_model=AlertsMarkedOut, dependencies=[OWN_ACCOUNT], responses=RESPONSES
)
def read_all_alerts(
    principal: CurrentPrincipal,
    world: CurrentWorld,
    session: SessionDep,
    community_id: CommunityFilter = None,
) -> AlertsMarkedOut:
    """Mark every unread alert of mine read (only those about `community_id`'s assets, if set)."""
    _check_community(session, world.id, principal, community_id)
    marked = alert_service.mark_all_read(
        session, world.id, principal.user_id, community_id=community_id
    )
    session.commit()
    return AlertsMarkedOut(marked=marked)


@router.post(
    "/{alert_id}/read", response_model=AlertOut, dependencies=[OWN_ACCOUNT], responses=RESPONSES
)
def read_alert(
    alert_id: UUID, principal: CurrentPrincipal, world: CurrentWorld, session: SessionDep
) -> AlertOut:
    """Mark one of my alerts read (idempotent). 404 if it wasn't delivered to me here."""
    out = alert_service.mark_read(session, world.id, principal.user_id, alert_id)
    if out is None:
        raise _not_found()
    session.commit()
    return out
