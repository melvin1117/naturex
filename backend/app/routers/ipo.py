"""IPO launch routes (T59; rules and the transaction in `app.services.ipo`).

- `GET /assets/{id}/ipo/preview?total_shares=&retained_pct=`: the IPO price with every term of
  dev-spec §8's formula, from the latest sealed report.
- `POST /assets/{id}/ipo`: launch, once, on a `listed` asset.

Opening offers sent for review (ADR-0008 §5; rules in `app.services.offers`):

- `POST /assets/{id}/offer`: the owner sends the terms; the listing waits for the Reviewer.
- `GET /admin/offers`: the offers waiting in the caller's world, oldest first.
- `POST /admin/assets/{id}/offer/approve`: launch it, with its terms, at today's price.
- `POST /admin/assets/{id}/offer/send-back`: return it to the community with a note.

The preview, the launch and sending an offer are the community owner's (`LAUNCH_IPO`, ADR-0005
matrix row 6); deciding on an offer is the Reviewer's (`REVIEW_LISTING`: an impartial admin).
Stewards get 403 `owner_only` on the preview too: it is the first step of the launch, which the
matrix keeps from them, and every input it shows is already public in the asset's report.
Anonymous callers get 401. An asset the caller can't see is 404, as for every action on every
asset route (the policy's `authz.can_see`, T58's rule): one outside the session's world, or a
listing that isn't public and isn't the caller's community's, so a draft's existence never
leaks. Other users who can see it (any public asset) and same-world admins get 403. A refused
launch is 409 with a code; nothing is written. An asset deleted meanwhile (a "Reset my demo") is
404.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlmodel import col, select

from app.authz import (
    Action,
    AssetRef,
    Granted,
    asset_ref,
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
from app.models import Asset, Community
from app.schemas import (
    IpoLaunch,
    IpoOut,
    IpoPreviewOut,
    ListingOfferOut,
    OfferOut,
    OfferSendBack,
    PendingOfferOut,
)
from app.services import offers
from app.services.ipo import (
    ALREADY_LAUNCHED,
    NO_RATING,
    NOT_LISTED,
    NOT_VERIFIED,
    PRICE_CHANGED,
    PRICE_TOO_HIGH,
    PRICE_TOO_LOW,
    IpoQuote,
    IpoRefused,
    launch,
    preview,
)
from app.services.listings import RUN_IN_PROGRESS
from app.services.rating import latest_report
from app.services.verification import listing_standing, verification_out

router = APIRouter(tags=["ipo"])

NO_STORE = "no-store"
PRIVATE_NO_STORE = "private, no-store"
Responses = dict[int | str, dict[str, Any]]


LaunchIpo = Annotated[Granted, require(Action.LAUNCH_IPO, asset_ref)]
ReviewOffer = Annotated[Granted, require(Action.REVIEW_LISTING, asset_ref)]
ReviewQueue = Annotated[Granted, require(Action.REVIEW_LISTING)]

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
    f"more shares), `{RUN_IN_PROGRESS}` (a rating run is active) or `{NOT_VERIFIED}` (the "
    "live world needs a verified listing; a revoked verification blocks everywhere; T69)"
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
    the launch would go ahead (`launchable`, else `blocked_reason`), with where the listing's
    verification stands (#216). Writes nothing; a later
    report can change it, so the launch confirms it with `expected_price`."""
    ref = _ref(granted)
    try:
        q = preview(session, ref.world_id, ref.asset_id, Offering(total_shares, retained_pct))
    except IpoRefused as exc:
        raise _refused(exc) from None
    except LookupError:
        raise _missing() from None
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    assert q.verification is not None  # a preview always reads it
    return IpoPreviewOut(
        **_terms_out(q),
        launchable=q.launchable,
        blocked_reason=q.blocked_reason,
        verification=verification_out(q.verification),
    )


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


# ----- offers sent for review (ADR-0008 §5) -----------------------------------------------------

_DECIDE: Responses = {
    401: {"description": "auth_required"},
    403: {"description": "admin_only, conflict_of_interest (the Reviewer is in its community)"},
    404: {"description": "Not found in the session's world"},
}


@router.post(
    "/assets/{asset_id}/offer",
    response_model=OfferOut,
    responses={
        **_COMMON,
        409: {
            "description": f"`{ALREADY_LAUNCHED}`, `{NOT_LISTED}`, `{NO_RATING}`, "
            f"`{PRICE_TOO_LOW}`, `{PRICE_TOO_HIGH}` or `{PRICE_CHANGED}` (`expected_price` is "
            "stale)"
        },
        422: {
            "description": "total_shares outside 10,000–10,000,000 or retained_pct outside 10–90"
        },
    },
)
def send_offer(
    body: IpoLaunch, granted: LaunchIpo, session: SessionDep, response: Response
) -> OfferOut:
    """Send the opening offer for review: the shares to issue and the share the community keeps,
    at the price the owner saw (`expected_price`). Sending again replaces the terms. Nothing
    trades until the Reviewer approves it, which launches it (`/admin/assets/{id}/offer/approve`).
    """
    ref = _ref(granted)
    try:
        q = offers.send(
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
    asset = session.get_one(Asset, ref.asset_id)
    response.headers["Cache-Control"] = NO_STORE
    assert asset.offer_sent_at is not None  # just sent
    return OfferOut(**_terms_out(q), sent_at=asset.offer_sent_at)


@router.get(
    "/admin/offers",
    response_model=list[PendingOfferOut],
    tags=["admin"],
    responses={401: {"description": "auth_required"}, 403: {"description": "admin_only"}},
)
def offer_queue(
    granted: ReviewQueue, session: SessionDep, response: Response
) -> list[PendingOfferOut]:
    """The offers waiting for a decision in the caller's world, oldest first, each priced as an
    approval would launch it now, with where its verification stands."""
    world_id = granted.resource.world_id
    waiting = offers.pending(session, world_id)
    names = dict(
        session.exec(
            select(Community.id, Community.name).where(
                Community.world_id == world_id,
                col(Community.id).in_([p.asset.community_id for p in waiting]),
            )
        ).all()
    )
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    out: list[PendingOfferOut] = []
    for p in waiting:
        report = latest_report(session, world_id, p.asset.id)
        assert p.asset.offer_sent_at is not None  # pending offers are sent
        out.append(
            PendingOfferOut(
                **_terms_out(p.quote),
                sent_at=p.asset.offer_sent_at,
                asset_name=p.asset.name,
                community_name=names.get(p.asset.community_id) if p.asset.community_id else None,
                area_ha=p.asset.area_ha,
                grade=report.grade if report else None,
                verification=verification_out(listing_standing(session, p.asset)),
            )
        )
    return out


@router.post(
    "/admin/assets/{asset_id}/offer/approve",
    response_model=IpoOut,
    tags=["admin"],
    responses={
        **_DECIDE,
        409: {
            "description": f"`{offers.NOT_SENT}` (nothing waits for review), {_REFUSED}, or "
            f"{_BLOCKED}"
        },
    },
)
def approve_offer(granted: ReviewOffer, session: SessionDep, response: Response) -> IpoOut:
    """Approve the community's offer: it launches with its terms at the price the latest report
    sets now (the launch's own transaction, ledger entry and price tick), and the site opens on
    the Marketplace."""
    ref = _ref(granted)
    try:
        done = offers.approve(session, ref.world_id, ref.asset_id)
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


@router.post(
    "/admin/assets/{asset_id}/offer/send-back",
    response_model=ListingOfferOut,
    tags=["admin"],
    responses={
        **_DECIDE,
        409: {"description": f"`{offers.NOT_SENT}`, `{ALREADY_LAUNCHED}` or `{NOT_LISTED}`"},
    },
)
def send_back_offer(
    body: OfferSendBack, granted: ReviewOffer, session: SessionDep, response: Response
) -> ListingOfferOut:
    """Return the offer to its community with a note; they can change it and send it again."""
    ref = _ref(granted)
    try:
        asset = offers.send_back(session, ref.world_id, ref.asset_id, note=body.note)
    except IpoRefused as exc:
        session.rollback()
        raise _refused(exc) from None
    except LookupError:
        session.rollback()
        raise _missing() from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return ListingOfferOut(
        total_shares=asset.total_shares,
        retained_pct=asset.retained_pct,
        sent_at=None,
        review_note=asset.offer_review_note,
    )
