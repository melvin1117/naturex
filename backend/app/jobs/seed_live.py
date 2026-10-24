"""`python -m app.jobs.seed_live --api URL --origin URL [--accounts-out PATH] [--phase NAME]`

Fills the live world with real activity from `data/live_seed.json`, through the real API, so
every rating, report, verification, offer, trade, alert and Record entry is made by the product
itself (no inserted rows, no mock model):

1. **people**: the admin (`app.cli create-admin`) and every account (`POST /auth/register`);
2. **communities**: the curated communities are handed from the template's owner persona (who
   can't sign in) to a real owner, renamed where the data says so, and given a steward; new
   communities are created by their owners;
3. **listings**: new listings drawn on real land, rated live (Earth Engine, Tavily, Nemotron),
   verified with sample documents (labelled as samples: nothing here is a legal title) that the
   admin approves, then opened to supporters at their opening offer;
4. **trade1**: supporters back sites; **news**: the news sweep (`app.jobs.news_sweep`);
5. **rerate**: the quarter's re-rate (`app.jobs.rerate_all`) and owner re-rates of some listings;
6. **trade2**, **trade3**: supporters react: some sell, some buy more.

Run it against an API started with `USE_MOCKS=false` and `EARTH_ENGINE_LIVE=true` on the same
`DATABASE_URL` as this process. Re-running skips what's done. Passwords are generated once and
kept in `--accounts-out` (git-ignored by `.env.*`), never printed or logged.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import secrets
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import update
from sqlmodel import Session, col, select

from app.auth import (
    SESSION_COOKIE,
    EmailTaken,
    authenticate,
    register_person,
    start_session,
)
from app.db import engine
from app.models import Community, CommunityMember, CommunityRole, User, UserKind
from app.worlds import LIVE_WORLD_ID

DATA = Path(__file__).resolve().parents[2] / "data" / "live_seed.json"
PHASES = ("people", "communities", "listings", "trade1", "news", "rerate", "trade2", "trade3")
SETTLED = {"listed", "needs_evidence", "ineligible", "draft", "withdrawn"}
TRADE_PAUSE_S = 4


def log(message: str) -> None:
    print(f"[{datetime.now(UTC):%H:%M:%S}] {message}", flush=True)


class SeedError(RuntimeError):
    pass


@dataclass
class Account:
    key: str
    name: str
    email: str
    password: str
    client: httpx.Client
    id: UUID | None = None


@dataclass
class Seeder:
    api: str
    origin: str
    accounts_out: Path
    data: dict[str, Any]
    passwords: dict[str, str] = field(default_factory=dict)
    people: dict[str, Account] = field(default_factory=dict)
    admin: Account | None = None
    communities: dict[str, str] = field(default_factory=dict)

    # ----- plumbing ------------------------------------------------------------------------------

    def client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self.api, headers={"Origin": self.origin}, timeout=120, follow_redirects=True
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
            if response.status_code == 429:
                wait = int(response.headers.get("Retry-After", "10"))
                log(f"  rate limited on {path}; waiting {wait}s")
                time.sleep(min(wait, 120) + 1)
                continue
            if response.status_code not in ok:
                raise SeedError(f"{method} {path} → {response.status_code}: {response.text[:300]}")
            return response
        raise SeedError(f"{method} {path}: still rate limited")

    def password_for(self, email: str) -> str:
        if email not in self.passwords:
            self.passwords[email] = secrets.token_urlsafe(18)
            self.accounts_out.write_text(json.dumps(self.passwords, indent=2) + "\n")
            os.chmod(self.accounts_out, 0o600)
        return self.passwords[email]

    def sign_in(self, key: str, name: str, email: str, *, register: bool = True) -> Account:
        account = Account(key, name, email, self.password_for(email), self.client())
        if register:
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
        15 minutes) that would idle a seed run of 14 accounts. The token is the session cookie."""
        with Session(engine) as session:
            user = authenticate(session, LIVE_WORLD_ID, account.email, account.password)
            if user is None:
                raise SeedError(f"{account.email}: wrong password in the accounts file")
            token = start_session(session, user)
        # A header, not the cookie jar: the jar won't match a bare "localhost" host.
        account.client.headers["Cookie"] = f"{SESSION_COOKIE}={token}"

    def accounts(self) -> None:
        if self.people:
            return
        for person in self.data["people"]:
            self.people[person["key"]] = self.sign_in(
                person["key"], person["name"], person["email"]
            )
        admin = self.data["admin"]
        self.admin = self.sign_in("admin", admin["name"], admin["email"], register=False)

    def asset_by_name(self, name: str) -> dict[str, Any]:
        account = next(iter(self.people.values()))
        for asset in self.call(account, "GET", "/assets").json():
            if asset["name"] == name:
                return dict(asset)
        raise SeedError(f"no public asset named {name!r}")

    def my_communities(self, account: Account) -> list[dict[str, Any]]:
        return list(self.call(account, "GET", "/me/communities").json())

    # ----- phases --------------------------------------------------------------------------------

    def phase_people(self) -> None:
        admin = self.data["admin"]
        password = self.password_for(admin["email"])
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "app.cli",
                "create-admin",
                "--email",
                admin["email"],
                "--name",
                admin["name"],
                "--password-stdin",
            ],
            input=password + "\n",
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode == 0:
            log(f"admin {admin['email']} created")
        elif "already" in (result.stdout + result.stderr).lower():
            log(f"admin {admin['email']} exists")
        else:
            raise SeedError(f"create-admin failed: {(result.stdout + result.stderr)[-300:]}")
        self.accounts()
        log(f"{len(self.people)} accounts ready")

    def hand_over(self, match_name: str, owner: Account) -> UUID:
        """Move a curated community's ownership from the template persona to a real owner."""
        with Session(engine) as session:
            community = session.exec(
                select(Community).where(
                    Community.world_id == LIVE_WORLD_ID, Community.name == match_name
                )
            ).first()
            if community is None:
                raise SeedError(f"no live community named {match_name!r}")
            owner_row = session.exec(
                select(CommunityMember).where(
                    CommunityMember.community_id == community.id,
                    CommunityMember.role == CommunityRole.OWNER,
                )
            ).one()
            if owner_row.user_id != owner.id:
                current = session.get_one(User, owner_row.user_id)
                if current.kind != UserKind.PERSONA:
                    raise SeedError(f"{match_name} already has a real owner")
                session.execute(
                    update(CommunityMember)
                    .where(
                        col(CommunityMember.community_id) == community.id,
                        col(CommunityMember.user_id) == current.id,
                    )
                    .values(user_id=owner.id)
                )
                session.commit()
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
                steward = self.people[steward_key]
                self.call(
                    owner,
                    "POST",
                    f"/communities/{community_id}/members",
                    json={"user_id": str(steward.id)},
                    ok=(200, 201, 409),
                )
            self.communities[name] = community_id
            log(f"community {name}: owner {owner.name}, stewards {spec.get('stewards', [])}")

    def owner_of(self, community_name: str) -> Account:
        spec = next(
            c
            for c in self.data["communities"]
            if (c.get("name") or c["match_name"]) == community_name
        )
        return self.people[spec["owner"]]

    def wait_settled(
        self, owner: Account, asset_id: str, *, timeout_s: int = 1800
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while True:
            asset = self.call(owner, "GET", f"/assets/{asset_id}").json()
            if asset["status"] in SETTLED:
                return dict(asset)
            if time.monotonic() > deadline:
                raise SeedError(f"{asset['name']} still {asset['status']} after {timeout_s}s")
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
                log(f"  {spec['name']}: not listed ({asset.get('status_reason')}); skipping offer")
                continue
            self.verify(owner, asset, spec)
            self.launch(owner, asset)

    def find_listing(self, owner: Account, name: str) -> dict[str, Any] | None:
        for community in self.my_communities(owner):
            for listing in self.call(owner, "GET", f"/communities/{community['id']}/assets").json():
                if listing["name"] == name:
                    return dict(self.call(owner, "GET", f"/assets/{listing['id']}").json())
        return None

    def verify(self, owner: Account, asset: dict[str, Any], spec: dict[str, Any]) -> None:
        assert self.admin is not None
        state = self.call(owner, "GET", f"/assets/{asset['id']}/verification").json()
        if (state.get("level") or "") == "verified":
            return
        ids = []
        for doc_type in spec["documents"]:
            png = sample_document(doc_type, spec["name"], spec["community"], asset)
            uploaded = self.call(
                owner,
                "POST",
                f"/assets/{asset['id']}/documents",
                params={"doc_type": doc_type},
                content=png,
                headers={"Content-Type": "image/png"},
            ).json()
            ids.append(uploaded["id"])
        run = self.call(
            owner, "POST", f"/assets/{asset['id']}/verification/runs", json={"document_ids": ids}
        ).json()
        self.call(
            self.admin,
            "POST",
            f"/admin/assets/{asset['id']}/verification/{run['id']}/approve",
            json={"reason": "Sample documents reviewed for the sandbox: play money only."},
        )
        log(f"  {asset['name']}: verified (sample documents, admin approved)")

    def launch(self, owner: Account, asset: dict[str, Any]) -> None:
        fresh = self.call(owner, "GET", f"/assets/{asset['id']}").json()
        if fresh.get("ipo_at"):
            return
        preview = self.call(owner, "GET", f"/assets/{asset['id']}/ipo/preview").json()
        if not preview.get("launchable"):
            raise SeedError(f"{asset['name']} can't open: {preview.get('blocked_reason')}")
        self.call(
            owner,
            "POST",
            f"/assets/{asset['id']}/ipo",
            json={"expected_price": str(preview["ipo_price"])},
        )
        log(f"  {asset['name']}: opened to supporters at ${preview['ipo_price']}")

    def trade(self, rows: list[list[Any]]) -> None:
        self.accounts()
        for who, site, side, amount in rows:
            account = self.people[who]
            try:
                asset = self.asset_by_name(site)
            except SeedError:
                log(f"  {site} isn't open to supporters; skipping {account.name}'s {side}")
                continue
            price = float(asset.get("price") or 0)
            if side == "buy":
                qty = math.floor(float(amount) / price) if price else 0
            else:
                held = {
                    h["asset_id"]: h["shares"]
                    for h in self.call(account, "GET", "/portfolio").json().get("holdings", [])
                }
                qty = math.floor(float(held.get(asset["id"], 0)) * float(amount))
            if qty <= 0:
                log(f"  {account.name}: nothing to {side} on {site}")
                continue
            self.call(
                account, "POST", "/orders", json={"asset_id": asset["id"], "side": side, "qty": qty}
            )
            log(f"  {account.name} {side}s {qty} units of {site} (~${price:.2f})")
            time.sleep(TRADE_PAUSE_S)

    def job(self, module: str, *args: str) -> None:
        log(f"running {module} {' '.join(args)}")
        result = subprocess.run([sys.executable, "-m", module, *args], check=False)
        if result.returncode:
            # A job stops at its own caps (e.g. the hourly rating cap) and resumes on a re-run.
            log(f"  {module} stopped early (exit {result.returncode}); re-run this phase later")

    def phase_rerate(self) -> None:
        self.accounts()
        quarter = f"{datetime.now(UTC).year}Q{(datetime.now(UTC).month - 1) // 3 + 1}"
        self.job("app.jobs.rerate_all", "--period", quarter, "--max-usd", "3")
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
            self.call(owner, "POST", f"/assets/{asset['id']}/rate", ok=(200, 201, 202, 409))
            log(f"  {spec['name']}: re-rated by {owner.name}…")
            deadline = time.monotonic() + 1800
            while time.monotonic() < deadline:
                time.sleep(15)
                now = self.call(owner, "GET", f"/assets/{asset['id']}").json()
                version = (now.get("latest_report") or {}).get("version") or 0
                if version > before:
                    log(
                        f"  {spec['name']}: Proof of Life v{version}, grade "
                        f"{now['latest_report'].get('grade')}"
                    )
                    break


def box_polygon(box: list[float]) -> dict[str, Any]:
    lat0, lon0, lat1, lon1 = box
    ring = [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]
    return {"type": "Polygon", "coordinates": [ring]}


DOC_TITLES = {
    "title": "Land title (sample)",
    "agrarian_certificate": "Agrarian certificate (sample)",
    "assembly_minutes": "Community assembly minutes: consent to list (sample)",
}


def sample_document(doc_type: str, site: str, community: str, asset: dict[str, Any]) -> bytes:
    """A plainly labelled sample document: the sandbox has no real titles, and says so."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(image)
    big = ImageFont.load_default(size=44)
    body = ImageFont.load_default(size=30)
    lines = [
        ("SAMPLE DOCUMENT · WildWorth sandbox · play money only", body),
        ("", body),
        (DOC_TITLES[doc_type], big),
        ("", body),
        (f"Site: {site}", body),
        (f"Community: {community}", body),
        (f"Area: {asset.get('area_ha')} ha", body),
        (f"Centroid: {asset.get('centroid_lat'):.4f}, {asset.get('centroid_lon'):.4f}", body),
        (f"Prepared: {datetime.now(UTC):%Y-%m-%d}", body),
        ("", body),
        ("This is not a legal document. It stands in for the community's", body),
        ("papers so the verification flow can be shown end to end.", body),
    ]
    y = 120
    for text, font in lines:
        draw.text((100, y), text, fill="black", font=font)
        y += 70 if font is big else 48
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--api", required=True, help="the running API, e.g. http://localhost:8123")
    parser.add_argument("--origin", required=True, help="an allowed web origin (ALLOWED_ORIGINS)")
    parser.add_argument(
        "--accounts-out",
        type=Path,
        default=Path("../.env.seed-accounts.json"),
        help="where the generated passwords live (git-ignored)",
    )
    parser.add_argument("--phase", choices=("all", *PHASES), default="all")
    args = parser.parse_args(argv)

    seeder = Seeder(
        api=args.api,
        origin=args.origin,
        accounts_out=args.accounts_out,
        data=json.loads(DATA.read_text()),
    )
    if args.accounts_out.exists():
        seeder.passwords = json.loads(args.accounts_out.read_text())
    phases = PHASES if args.phase == "all" else (args.phase,)
    try:
        for phase in phases:
            log(f"== {phase}")
            if phase == "people":
                seeder.phase_people()
            elif phase == "communities":
                seeder.phase_communities()
            elif phase == "listings":
                seeder.phase_listings()
            elif phase == "trade1":
                seeder.trade(seeder.data["trades_round_1"])
            elif phase == "news":
                seeder.job("app.jobs.news_sweep", "--max-usd", "1")
            elif phase == "rerate":
                seeder.phase_rerate()
            elif phase == "trade2":
                seeder.trade(seeder.data["trades_round_2"])
            elif phase == "trade3":
                seeder.trade(seeder.data.get("trades_round_3", []))
    except SeedError as exc:
        log(f"stopped: {exc}")
        return 1
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
