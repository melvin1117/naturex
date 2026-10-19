"""IPO launch routes (T59; rules and the transaction in `app.services.ipo`).

- `GET /assets/{id}/ipo/preview?total_shares=&retained_pct=`: the IPO price with every term of
  dev-spec §8's formula, from the latest sealed report.
- `POST /assets/{id}/ipo`: launch, once, on a `listed` asset.

Both are the community owner's (`LAUNCH_IPO`, ADR-0005 matrix row 6). Stewards get 403
`owner_only` on the preview too: it is the first step of the launch, which the matrix keeps
from them, and every input it shows is already public in the asset's report. Admins, other
users and treasuries get 403, anonymous callers 401, and assets outside the session's world 404.
A refused launch is 409 with a code; nothing is written.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Response, status

from app.authz import Action, AssetRef, Granted, asset_ref, require
from app.deps import SessionDep
from app.schemas import IpoLaunch, IpoOut, IpoPreviewOut
from app.services.ipo import (
    ALREADY_LAUNCHED,
    DEFAULT_RETAINED_PCT,
    DEFAULT_TOTAL_SHARES,
    MAX_RETAINED_PCT,
    MAX_TOTAL_SHARES,
    MIN_RETAINED_PCT,
    MIN_TOTAL_SHARES,
    NO_RATING,
    NOT_LISTED,
    PRICE_CHANGED,
    PRICE_TOO_LOW,
    IpoQuote,
    IpoRefused,
    Offering,
    launch,
    preview,
)

router = APIRouter(tags=["ipo"])

NO_STORE = "no-store"
PRIVATE_NO_STORE = "private, no-store"
Responses = dict[int | str, dict[str, Any]]
LaunchIpo = Annotated[Granted, require(Action.LAUNCH_IPO, asset_ref)]

_COMMON: Responses = {
    401: {"description": "auth_required"},
    403: {"description": "owner_only (stewards too), treasury_cannot_act"},
    404: {"description": "Not found in the session's world"},
}
_REFUSED = (
    f"`{ALREADY_LAUNCHED}`, `{NOT_LISTED}` (draft, under review, suspended…), `{NO_RATING}` "
    f"(no usable report) or `{PRICE_TOO_LOW}` (the price per share rounds to zero: issue "
    "fewer shares)"
)


def _ref(granted: Granted) -> AssetRef:
    ref = granted.resource
    if not isinstance(ref, AssetRef):  # pragma: no cover - the loader guarantees it
        raise TypeError(ref)
    return ref


def _refused(exc: IpoRefused) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, exc.code, headers={"Cache-Control": NO_STORE})


def _preview_out(q: IpoQuote) -> dict[str, Any]:
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
    fair_value_per_share`, computed by the market engine from the latest report. Writes
    nothing; a later report can change it (confirm with `expected_price`)."""
    ref = _ref(granted)
    try:
        q = preview(session, ref.world_id, ref.asset_id, Offering(total_shares, retained_pct))
    except IpoRefused as exc:
        raise _refused(exc) from None
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return IpoPreviewOut(**_preview_out(q))


@router.post(
    "/assets/{asset_id}/ipo",
    response_model=IpoOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        **_COMMON,
        409: {"description": f"{_REFUSED}, or `{PRICE_CHANGED}` (`expected_price` is stale)"},
        422: {
            "description": "total_shares outside 10,000–10,000,000 or retained_pct outside 10–90"
        },
    },
)
def launch_ipo(
    body: IpoLaunch, granted: LaunchIpo, session: SessionDep, response: Response
) -> IpoOut:
    """Launch the IPO of a `listed` asset, once: in one transaction the first `prices` row
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
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    response.headers["Location"] = f"/assets/{ref.asset_id}"
    return IpoOut(**_preview_out(done.quote), launched_at=done.launched_at)
