"""The signed-in account's alerts (T75): list with read/unread state, mark one or all read.

Every route is `use_own_account` on the world (a signed-in person; treasuries can't act) and
reads only the caller's own `alert_recipients` rows in the session's world, so another account's
or another world's alert is 404 `not_found`. The alerts themselves are raised by re-rates and the
news sweep (`app.services.alerts`).
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from app.authz import Action, DenyReason, denied, require
from app.deps import CurrentPrincipal, CurrentWorld, SessionDep
from app.schemas import AlertListOut, AlertOut, AlertsMarkedOut
from app.services import alerts as alert_service

router = APIRouter(prefix="/alerts", tags=["alerts"])
OWN_ACCOUNT = require(Action.USE_OWN_ACCOUNT)
RESPONSES = denied(DenyReason.TREASURY_CANNOT_ACT)


@router.get("", response_model=AlertListOut, dependencies=[OWN_ACCOUNT], responses=RESPONSES)
def list_alerts(
    principal: CurrentPrincipal,
    world: CurrentWorld,
    session: SessionDep,
    unread_only: Annotated[bool, Query()] = False,
    limit: Annotated[int, Query(ge=1, le=alert_service.ALERT_LIST_LIMIT)] = (
        alert_service.ALERT_LIST_LIMIT
    ),
) -> AlertListOut:
    """My alerts in this world, newest first, with the total unread count."""
    return AlertListOut(
        alerts=alert_service.list_alerts(
            session, world.id, principal.user_id, limit=limit, unread_only=unread_only
        ),
        unread_count=alert_service.unread_count(session, world.id, principal.user_id),
    )


@router.post(
    "/read-all", response_model=AlertsMarkedOut, dependencies=[OWN_ACCOUNT], responses=RESPONSES
)
def read_all_alerts(
    principal: CurrentPrincipal, world: CurrentWorld, session: SessionDep
) -> AlertsMarkedOut:
    """Mark every unread alert of mine read."""
    marked = alert_service.mark_all_read(session, world.id, principal.user_id)
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
        raise HTTPException(status.HTTP_404_NOT_FOUND, DenyReason.NOT_FOUND.value)
    session.commit()
    return out
