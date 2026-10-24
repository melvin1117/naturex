"""`python -m app.jobs.seed_live --api URL --origin URL [--accounts-out PATH] [--phase NAME]`

Fills the live world with activity from `data/live_seed.json`. Ratings, reports, alerts,
trades and Record entries are all made by the product with live models and Earth Engine
(nothing is mocked); a few operator steps run in-process with the product's own functions:

1. **people**: each account is registered and signed in with the register and login
   endpoints' own functions (`register_person`, `authenticate`, `start_session`), which skips
   their per-IP throttles; everything after that goes through the running API;
2. **communities**: the curated communities are handed from their seeded owner persona (who
   can't sign in) to a person (`transfer_ownership`), renamed where the data says so and given
   stewards; new communities are created by their owners;
3. **listings**: new listings drawn on real land and rated live (Earth Engine, Tavily,
   Nemotron). The ones the gate lists are opened to supporters at the engine's opening price
   without the verification gate (`launch(require_verification=False)`), like the curated
   sites: the Exchange shows them as "Self-attested by the community". No documents are made
   up and no review is faked;
4. **trade1**: supporters back sites; **news**: the news sweep (`app.jobs.news_sweep`);
5. **rerate**: the quarter's re-rate (`app.jobs.rerate_all`) and owner re-rates of some listings;
6. **trade2**, **trade3**: supporters react: some sell, some buy more.

Run it with `USE_MOCKS=false EARTH_ENGINE_LIVE=true`, against an API started with the same
settings on the same `DATABASE_URL`. Re-running skips what's done (trades are recorded in a
state file next to the accounts file). Passwords are generated once and kept in
`--accounts-out` (git-ignored by `.env.*`, mode 0600), never printed or logged. Exits 1 when a
phase stops early (e.g. a job at its hourly rating cap): re-run that phase later.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import secrets
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from sqlmodel import Session, select

from app.auth import (
    SESSION_COOKIE,
    EmailTaken,
    authenticate,
    end_session,
    register_person,
    start_session,
)
from app.communities import MembershipConflict, transfer_ownership
from app.config import Settings, get_settings
from app.db import engine
from app.market.offering import Offering
from app.models import Community
from app.services import ipo
from app.worlds import LIVE_WORLD_ID

DATA = Path(__file__).resolve().parents[2] / "data" / "live_seed.json"
DEFAULT_ACCOUNTS = Path(__file__).resolve().parents[3] / ".env.seed-accounts.json"
PHASES = ("people", "communities", "listings", "trade1", "news", "rerate", "trade2", "trade3")
TRADE_ROUNDS = {"trade1": "trades_round_1", "trade2": "trades_round_2", "trade3": "trades_round_3"}
SETTLED = {"listed", "needs_evidence", "ineligible", "draft", "withdrawn"}
RETRIED = {429, 503}
TRADE_PAUSE_S = 4
WAIT_S = 1800


def log(message: str) -> None:
    print(f"[{datetime.now(UTC):%H:%M:%S}] {message}", flush=True)


class SeedError(RuntimeError):
    pass


def live_settings_problem(settings: Settings) -> str | None:
    """Why this process can't seed real data, or None. Jobs it starts inherit its env."""
    if settings.use_mocks:
        return "USE_MOCKS is on: run with USE_MOCKS=false (and the API too)"
    if not settings.earth_engine_live:
        return "EARTH_ENGINE_LIVE is off: run with EARTH_ENGINE_LIVE=true (and the API too)"
    return None


def retry_after_s(value: str | None, *, default: float = 10, now: datetime | None = None) -> float:
    """Seconds to wait from a `Retry-After` header: delta-seconds or an HTTP date."""
    if not value:
        return default
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, (when - (now or datetime.now(UTC))).total_seconds())


def write_private(path: Path, data: Any) -> None:
    """Write JSON readable by the owner only, created 0600 (never briefly world-readable)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write(json.dumps(data, indent=2) + "\n")
    os.chmod(path, 0o600)


def buy_qty(budget: float, price: float) -> int:
    return math.floor(budget / price) if price > 0 else 0


def sell_qty(held: float, fraction: float) -> int:
    return math.floor(held * fraction)


@dataclass
class Account:
    key: str
    name: str
    email: str
    password: str
    client: httpx.Client
    id: UUID | None = None
    token: str | None = None


@dataclass
class Seeder:
    api: str
    origin: str
    accounts_out: Path
    data: dict[str, Any]
    transport: httpx.BaseTransport | None = None
    passwords: dict[str, str] = field(default_factory=dict)
    done_trades: set[str] = field(default_factory=set)
    people: dict[str, Account] = field(default_factory=dict)
    communities: dict[str, str] = field(default_factory=dict)
    unfinished: list[str] = field(default_factory=list)

    @property
    def state_path(self) -> Path:
        return self.accounts_out.with_name(".env.seed-state.json")

    def load(self) -> None:
        if self.accounts_out.exists():
            self.passwords = json.loads(self.accounts_out.read_text())
        if self.state_path.exists():
            self.done_trades = set(json.loads(self.state_path.read_text()).get("trades", []))

    # ----- plumbing ------------------------------------------------------------------------------

    def client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self.api,
            headers={"Origin": self.origin},
            timeout=120,
            follow_redirects=True,
            transport=self.transport,
        )

    def call(
        self,
        account: Account,
        method: str,
        path: str,
        ok: tuple[int, ...] = (200, 201, 202, 204),
        **kw: Any,
    ) -> httpx.Response:
        for _ in range(8):
            response = account.client.request(method, path, **kw)
            if response.status_code in RETRIED:
                wait = min(retry_after_s(response.headers.get("Retry-After")), 120)
                log(f"  {response.status_code} on {path}; waiting {wait:.0f}s")
                time.sleep(wait + 1)
                continue
            if response.status_code not in ok:
                raise SeedError(f"{method} {path} → {response.status_code}: {response.text[:300]}")
            return response
        raise SeedError(f"{method} {path}: still refused after retries")

    def password_for(self, email: str) -> str:
        if email not in self.passwords:
            self.passwords[email] = secrets.token_urlsafe(18)
            write_private(self.accounts_out, self.passwords)
        return self.passwords[email]

    def sign_in(self, key: str, name: str, email: str) -> Account:
        account = Account(key, name, email, self.password_for(email), self.client())
        self.register(name, email, account.password)
        self.start_session(account)
        me = self.call(account, "GET", "/world").json().get("me")
        if not me:
            raise SeedError(f"{email} isn't signed in after login")
        account.id = UUID(me["id"])
        return account

    def register(self, name: str, email: str, password: str) -> None:
        """Create a password account with the register endpoint's own function
        (`register_person`): the same hashing and checks, without the per-IP sign-up throttle
        (5 an hour) that would stretch a seed run over hours."""
        with Session(engine) as session:
            try:
                register_person(session, LIVE_WORLD_ID, email, password, name)
            except EmailTaken:
                session.rollback()

    def start_session(self, account: Account) -> None:
        """Sign in with the login endpoint's own functions (`authenticate`, `start_session`):
        the same password check and session, without the per-IP login throttle (10 every
        15 minutes). The token is the session cookie."""
        with Session(engine) as session:
            user = authenticate(session, LIVE_WORLD_ID, account.email, account.password)
            if user is None:
                raise SeedError(f"{account.email}: wrong password in the accounts file")
            account.token = start_session(session, user)
        # A header, not the cookie jar: the jar won't match a bare "localhost" host.
        account.client.headers["Cookie"] = f"{SESSION_COOKIE}={account.token}"

    def close(self) -> None:
        """Sign every account out and close its client."""
        with Session(engine) as session:
            for account in self.people.values():
                end_session(session, account.token)
                account.client.close()
        self.people.clear()

    def accounts(self) -> None:
        if self.people:
            return
        for person in self.data["people"]:
            self.people[person["key"]] = self.sign_in(
                person["key"], person["name"], person["email"]
            )

    def asset_by_name(self, name: str) -> dict[str, Any] | None:
        account = next(iter(self.people.values()))
        for asset in self.call(account, "GET", "/assets").json():
            if asset["name"] == name:
                return dict(asset)
        return None

    def my_communities(self, account: Account) -> list[dict[str, Any]]:
        return list(self.call(account, "GET", "/me/communities").json())

    # ----- phases --------------------------------------------------------------------------------

    def phase_people(self) -> None:
        self.accounts()
        log(f"{len(self.people)} accounts ready")

    def hand_over(self, match_name: str, owner: Account) -> UUID:
        """Hand a curated community from its owner persona to `owner` (`transfer_ownership`)."""
        assert owner.id is not None
        with Session(engine) as session:
            community = session.exec(
                select(Community).where(
                    Community.world_id == LIVE_WORLD_ID, Community.name == match_name
                )
            ).first()
            if community is None:
                raise SeedError(f"no live community named {match_name!r}")
            try:
                moved = transfer_ownership(session, community, owner.id)
            except MembershipConflict as exc:
                raise SeedError(f"{match_name} can't go to {owner.name}: {exc.reason}") from None
            session.commit()
            if moved:
                log(f"  {match_name}: handed to {owner.name}")
            return community.id

    def phase_communities(self) -> None:
        self.accounts()
        for spec in self.data["communities"]:
            owner = self.people[spec["owner"]]
            name = spec.get("name") or spec["match_name"]
            existing = {c["name"]: c for c in self.my_communities(owner)}
            if name in existing:
                community_id = existing[name]["id"]
            elif "match_name" in spec:
                community_id = str(self.hand_over(spec["match_name"], owner))
                patch = {k: spec[k] for k in ("name", "description") if k in spec}
                if patch:
                    self.call(owner, "PATCH", f"/communities/{community_id}", json=patch)
            else:
                body = {k: spec[k] for k in ("name", "country", "description") if k in spec}
                community_id = self.call(owner, "POST", "/communities", json=body).json()["id"]
                log(f"  {name}: created by {owner.name}")
            for steward_key in spec.get("stewards", []):
                self.add_steward(owner, community_id, self.people[steward_key])
            self.communities[name] = community_id
            log(f"community {name}: owner {owner.name}, stewards {spec.get('stewards', [])}")

    def add_steward(self, owner: Account, community_id: str, steward: Account) -> None:
        response = self.call(
            owner,
            "POST",
            f"/communities/{community_id}/members",
            json={"user_id": str(steward.id)},
            ok=(200, 201, 409),
        )
        if response.status_code == 409 and response.json().get("detail") != "already_member":
            raise SeedError(f"{steward.name} can't be a steward: {response.text[:200]}")

    def owner_of(self, community_name: str) -> Account:
        spec = next(
            c
            for c in self.data["communities"]
            if (c.get("name") or c["match_name"]) == community_name
        )
        return self.people[spec["owner"]]

    def find_listing(self, owner: Account, name: str) -> dict[str, Any] | None:
        for community in self.my_communities(owner):
            listings = self.call(owner, "GET", f"/communities/{community['id']}/assets").json()
            for asset in listings:
                if asset["name"] == name:
                    return dict(asset)
        return None

    def wait_settled(self, owner: Account, asset_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + WAIT_S
        while True:
            asset = self.call(owner, "GET", f"/assets/{asset_id}").json()
            if asset["status"] in SETTLED:
                if asset.get("mock"):
                    raise SeedError(
                        f"{asset['name']} was rated from mock metrics: start the API with "
                        "USE_MOCKS=false EARTH_ENGINE_LIVE=true"
                    )
                return dict(asset)
            if time.monotonic() > deadline:
                raise SeedError(f"{asset['name']} still {asset['status']} after {WAIT_S}s")
            time.sleep(15)

    def phase_listings(self) -> None:
        self.accounts()
        if not self.communities:
            self.phase_communities()
        for spec in self.data["listings"]:
            owner = self.owner_of(spec["community"])
            community_id = self.communities[spec["community"]]
            asset = self.find_listing(owner, spec["name"])
            if asset is None:
                geometry = spec.get("geometry") or box_polygon(spec["box"])
                body = {
                    "community_id": community_id,
                    "name": spec["name"],
                    "country": spec.get("country"),
                    "description": spec.get("description"),
                    "geojson": {"type": "Feature", "properties": {}, "geometry": geometry},
                    "attestation": True,
                }
                asset = self.call(owner, "POST", "/assets", json=body).json()
                log(f"listing {spec['name']}: drafted by {owner.name}")
            if asset["status"] == "draft":
                self.call(owner, "POST", f"/assets/{asset['id']}/submit")
                log(f"  {spec['name']}: submitted; rating live…")
            asset = self.wait_settled(owner, asset["id"])
            report = asset.get("latest_report") or {}
            log(
                f"  {spec['name']}: {asset['status']}, grade {report.get('grade')}, "
                f"health {report.get('health_score')}"
            )
            if asset["status"] != "listed":
                log(f"  {spec['name']}: not listed ({asset.get('status_reason')}); no offer")
                continue
            self.launch(owner, asset)

    def launch(self, owner: Account, asset: dict[str, Any]) -> None:
        """Open a listed site to supporters at the engine's previewed price, self-attested
        (`require_verification=False`); every other launch check still applies."""
        fresh = self.call(owner, "GET", f"/assets/{asset['id']}").json()
        if fresh.get("ipo_at"):
            return
        preview = self.call(owner, "GET", f"/assets/{asset['id']}/ipo/preview").json()
        if preview.get("blocked_reason") not in (None, "not_verified"):
            raise SeedError(f"{asset['name']} can't open: {preview['blocked_reason']}")
        price = Decimal(str(preview["ipo_price"]))
        with Session(engine) as session:
            try:
                ipo.launch(
                    session,
                    LIVE_WORLD_ID,
                    UUID(asset["id"]),
                    Offering(),
                    expected_price=price,
                    require_verification=False,
                )
            except ipo.IpoRefused as exc:
                raise SeedError(f"{asset['name']} can't open: {exc.code}") from None
            session.commit()
        log(f"  {asset['name']}: opened to supporters at ${price} (self-attested)")

    def trade(self, round_key: str) -> None:
        self.accounts()
        for index, (who, site, side, amount) in enumerate(self.data.get(round_key, [])):
            done_key = f"{round_key}:{index}"
            if done_key in self.done_trades:
                continue
            account = self.people[who]
            asset = self.asset_by_name(site)
            if asset is None or not asset.get("price"):
                log(f"  {site} isn't open to supporters; skipping {account.name}'s {side}")
                continue
            price = float(asset["price"])
            if side == "buy":
                qty = buy_qty(float(amount), price)
            else:
                held = {
                    h["asset_id"]: h["shares"]
                    for h in self.call(account, "GET", "/portfolio").json().get("holdings", [])
                }
                qty = sell_qty(float(held.get(asset["id"], 0)), float(amount))
            if qty > 0:
                self.call(
                    account,
                    "POST",
                    "/orders",
                    json={"asset_id": asset["id"], "side": side, "qty": qty},
                )
                log(f"  {account.name} {side}s {qty} units of {site} (~${price:.2f})")
            else:
                log(f"  {account.name}: nothing to {side} on {site}")
            self.done_trades.add(done_key)
            write_private(self.state_path, {"trades": sorted(self.done_trades)})
            time.sleep(TRADE_PAUSE_S)

    def job(self, phase: str, module: str, *args: str) -> None:
        log(f"running {module} {' '.join(args)}")
        result = subprocess.run([sys.executable, "-m", module, *args], check=False)
        if result.returncode:
            # A job stops at its own caps (e.g. the hourly rating cap) and resumes on a re-run.
            log(f"  {module} stopped early (exit {result.returncode})")
            self.unfinished.append(phase)

    def phase_rerate(self) -> None:
        self.accounts()
        self.job("rerate", "app.jobs.rerate_all", "--max-usd", "3")
        for spec in self.data["listings"]:
            if not spec.get("rerate"):
                continue
            owner = self.owner_of(spec["community"])
            asset = self.find_listing(owner, spec["name"])
            if asset is None or asset["status"] != "listed":
                continue
            before = (asset.get("latest_report") or {}).get("version") or 0
            if before >= 2:
                continue
            started = self.call(owner, "POST", f"/assets/{asset['id']}/rate", ok=(202, 409))
            if started.status_code == 409:
                log(f"  {spec['name']}: not re-rated now ({started.text[:120]})")
                self.unfinished.append("rerate")
                continue
            log(f"  {spec['name']}: re-rated by {owner.name}…")
            if not self.wait_version(owner, asset["id"], before):
                log(f"  {spec['name']}: no new Proof of Life after {WAIT_S}s")
                self.unfinished.append("rerate")

    def wait_version(self, owner: Account, asset_id: str, before: int) -> bool:
        deadline = time.monotonic() + WAIT_S
        while time.monotonic() < deadline:
            time.sleep(15)
            now = self.call(owner, "GET", f"/assets/{asset_id}").json()
            report = now.get("latest_report") or {}
            if (report.get("version") or 0) > before:
                log(f"  {now['name']}: Proof of Life v{report['version']}, grade {report['grade']}")
                return True
        return False

    def run(self, phase: str) -> None:
        log(f"== {phase}")
        if phase == "people":
            self.phase_people()
        elif phase == "communities":
            self.phase_communities()
        elif phase == "listings":
            self.phase_listings()
        elif phase == "news":
            self.job("news", "app.jobs.news_sweep", "--max-usd", "1")
        elif phase == "rerate":
            self.phase_rerate()
        else:
            self.trade(TRADE_ROUNDS[phase])


def box_polygon(box: list[float]) -> dict[str, Any]:
    lat0, lon0, lat1, lon1 = box
    ring = [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]
    return {"type": "Polygon", "coordinates": [ring]}


@contextmanager
def seeding(seeder: Seeder) -> Iterator[Seeder]:
    try:
        yield seeder
    finally:
        seeder.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--api", required=True, help="the running API, e.g. http://localhost:8123")
    parser.add_argument("--origin", required=True, help="an allowed web origin (ALLOWED_ORIGINS)")
    parser.add_argument(
        "--accounts-out",
        type=Path,
        default=DEFAULT_ACCOUNTS,
        help="where the generated passwords live (git-ignored; default: the repo root)",
    )
    parser.add_argument("--phase", choices=("all", *PHASES), default="all")
    args = parser.parse_args(argv)

    problem = live_settings_problem(get_settings())
    if problem:
        log(f"refusing to seed: {problem}")
        return 2
    seeder = Seeder(
        api=args.api,
        origin=args.origin,
        accounts_out=args.accounts_out,
        data=json.loads(DATA.read_text()),
    )
    seeder.load()
    phases = PHASES if args.phase == "all" else (args.phase,)
    with seeding(seeder):
        try:
            for phase in phases:
                seeder.run(phase)
        except SeedError as exc:
            log(f"stopped: {exc}")
            return 1
    if seeder.unfinished:
        pending = ", ".join(dict.fromkeys(seeder.unfinished))
        log(f"unfinished: {pending}; re-run with --phase <name> later")
        return 1
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
