"""IPO launch routes (T59; rules and the transaction in `app.services.ipo`).

- `GET /assets/{id}/ipo/preview?total_shares=&retained_pct=`: the IPO price with every term of
  dev-spec §8's formula, from the latest sealed report.
- `POST /assets/{id}/ipo`: launch, once, on a `listed` asset.

Both are the community owner's (`LAUNCH_IPO`, ADR-0005 matrix row 6). Stewards get 403
`owner_only` on the preview too: it is the first step of the launch, which the matrix keeps
from them, and every input it shows is already public in the asset's report. Anonymous callers
get 401. An asset the caller can't see is 404, as on every other asset route (T58's
`visible_to`): one outside the session's world, or a listing that isn't public and isn't the
caller's community's, so a draft's existence never leaks. Other users who can see it (any
public asset) and same-world admins get 403. A refused launch is 409 with a code; nothing is
written. An asset deleted meanwhile (a "Reset my demo") is 404.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Path, Query, Response, status

from app.authz import (
    Action,
    AssetRef,
    Granted,
    OptionalActor,
    acting_world,
    asset_ref_in,
    can_see,
    require,
)
from app.deps import SessionDep
from app.market.offering import (
    DEFAULT_RETAINED_PCT,
    DEFAULT_TOTAL_SHARES,
    MAX_RETAINED_PCT,
    MAX_TOTAL_SHARES,
    MIN_RETAINED_PCT,
    MIN_TOTAL_SHARES,
    Offering,
)
from app.schemas import IpoLaunch, IpoOut, IpoPreviewOut
from app.services.ipo import (
    ALREADY_LAUNCHED,
    NO_RATING,
    NOT_LISTED,
    PRICE_CHANGED,
    PRICE_TOO_HIGH,
    PRICE_TOO_LOW,
    IpoQuote,
    IpoRefused,
    launch,
    preview,
)
from app.services.listings import RUN_IN_PROGRESS

router = APIRouter(tags=["ipo"])

NO_STORE = "no-store"
PRIVATE_NO_STORE = "private, no-store"
Responses = dict[int | str, dict[str, Any]]


def visible_asset_ref(
    asset_id: Annotated[UUID, Path()], actor: OptionalActor, session: SessionDep
) -> AssetRef | None:
    """The asset in the actor's world if the actor may see it (T58's rule, `authz.can_see`), else
    None (a 404), so a non-member can't tell a draft exists from a 403."""
    asset = asset_ref_in(session, acting_world(actor), asset_id)
    return asset if asset is not None and can_see(actor, asset) else None


LaunchIpo = Annotated[Granted, require(Action.LAUNCH_IPO, visible_asset_ref)]

_COMMON: Responses = {
    401: {"description": "auth_required"},
    403: {"description": "owner_only (stewards too), treasury_cannot_act"},
    404: {"description": "Not found in the session's world, or not visible to the caller"},
}
_REFUSED = (
    f"`{ALREADY_LAUNCHED}`, `{NOT_LISTED}` (draft, under review, suspended…), `{NO_RATING}` "
    f"(no usable report) or `{PRICE_TOO_LOW}` (the price per share rounds to zero: issue "
    "fewer shares)"
)
_BLOCKED = (
    f"`{PRICE_TOO_HIGH}` (a share would cost more than a new account's starting cash: issue "
    f"more shares), `{RUN_IN_PROGRESS}` (a rating run is active) or a verification code (T69)"
)


def _ref(granted: Granted) -> AssetRef:
    ref = granted.resource
    if not isinstance(ref, AssetRef):  # pragma: no cover - the loader guarantees it
        raise TypeError(ref)
    return ref


def _refused(exc: IpoRefused) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, exc.code, headers={"Cache-Control": NO_STORE})


def _missing() -> HTTPException:
    return HTTPException(
        status.HTTP_404_NOT_FOUND, "not_found", headers={"Cache-Control": NO_STORE}
    )


def _terms_out(q: IpoQuote) -> dict[str, Any]:
    terms = q.terms
    return {
        "asset_id": q.asset_id,
        "report_id": q.report_id,
        "report_version": q.report_version,
        "value_mid": terms.value_mid,
        "health": terms.health,
        "confidence": terms.confidence,
        "health_factor": terms.health_factor,
        "confidence_factor": terms.confidence_factor,
        "fair_value_total": terms.fair_value_total,
        "total_shares": terms.total_shares,
        "fair_value_per_share": terms.fair_value_per_share,
        "ipo_price": terms.price,
        "retained_pct": terms.retained_pct,
        "shares_offered": terms.primary_float,
        "retained_shares": terms.retained_shares,
    }


@router.get(
    "/assets/{asset_id}/ipo/preview",
    response_model=IpoPreviewOut,
    responses={**_COMMON, 409: {"description": _REFUSED}},
)
def preview_ipo(
    granted: LaunchIpo,
    session: SessionDep,
    response: Response,
    total_shares: Annotated[
        int, Query(ge=MIN_TOTAL_SHARES, le=MAX_TOTAL_SHARES)
    ] = DEFAULT_TOTAL_SHARES,
    retained_pct: Annotated[
        Decimal, Query(ge=MIN_RETAINED_PCT, le=MAX_RETAINED_PCT, decimal_places=2)
    ] = DEFAULT_RETAINED_PCT,
) -> IpoPreviewOut:
    """The price the owner would launch at now: every term of `ipo_price =
    fair_value_per_share`, computed by the market engine from the latest report, and whether
    the launch would go ahead (`launchable`, else `blocked_reason`). Writes nothing; a later
    report can change it, so the launch confirms it with `expected_price`."""
    ref = _ref(granted)
    try:
        q = preview(session, ref.world_id, ref.asset_id, Offering(total_shares, retained_pct))
    except IpoRefused as exc:
        raise _refused(exc) from None
    except LookupError:
        raise _missing() from None
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return IpoPreviewOut(**_terms_out(q), launchable=q.launchable, blocked_reason=q.blocked_reason)


@router.post(
    "/assets/{asset_id}/ipo",
    response_model=IpoOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        **_COMMON,
        409: {
            "description": f"{_REFUSED}, {_BLOCKED}, or `{PRICE_CHANGED}` (`expected_price` "
            "is stale)"
        },
        422: {
            "description": "total_shares outside 10,000–10,000,000 or retained_pct outside 10–90"
        },
    },
)
def launch_ipo(
    body: IpoLaunch, granted: LaunchIpo, session: SessionDep, response: Response
) -> IpoOut:
    """Launch the IPO of a `listed` asset, once, at the previewed price (`expected_price`):
    in one transaction the first `prices` row
    (`reason: ipo`), the community treasury's retained holding, a `price_anchor` ledger entry
    with every term and the primary float open for sale; a public `price_tick` follows. Play
    money only: shares are sandbox units, not securities."""
    ref = _ref(granted)
    try:
        done = launch(
            session,
            ref.world_id,
            ref.asset_id,
            Offering(body.total_shares, body.retained_pct),
            expected_price=body.expected_price,
        )
    except IpoRefused as exc:
        session.rollback()
        raise _refused(exc) from None
    except LookupError:
        session.rollback()
        raise _missing() from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    response.headers["Location"] = f"/assets/{ref.asset_id}"
    return IpoOut(**_terms_out(done.quote), launched_at=done.launched_at)
