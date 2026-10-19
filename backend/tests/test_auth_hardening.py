"""Auth hardening (ADR-0005 §1, T66): CSRF origin checks, rate limits and pruning."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from collections.abc import Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, func, text, update
from sqlmodel import Session, col, select

from app import auth, deps
from app.config import Settings, get_settings
from app.db import get_session
from app.deps import current_principal
from app.main import app, validate_auth_settings
from app.middleware import (
    canonical_origin,
    media_type_ok,
    origin_allowed,
    parse_allowed_origins,
)
from app.models import AuthAttempt, AuthAttemptKind, AuthBucket, UserSession
from app.seed import seed
from tests.conftest import alembic_cfg, requires_db
from tests.worlds import stub_principal

ALLOWED = ["https://app.example.com", "http://localhost:3000"]


# --- CSRF: origin matching (pure) ------------------------------------------------------------


@pytest.mark.parametrize(
    ("origins", "referers"),
    [
        (["https://app.example.com"], []),
        (["http://localhost:3000"], []),
        (["https://app.example.com:443"], []),  # default port written out
        (["HTTPS://APP.EXAMPLE.COM"], []),  # scheme and host are case-insensitive
        (["https://app.example.com/"], []),
        ([], ["https://app.example.com/some/page?x=1"]),  # Referer, only when Origin is absent
        ([], ["http://localhost:3000/login"]),
    ],
)
def test_allowed_origins_and_referers_pass(origins: list[str], referers: list[str]) -> None:
    assert origin_allowed(origins, referers, ALLOWED) is True


@pytest.mark.parametrize(
    "origin",
    [
        "https://app.example.com.evil.com",  # forged suffix
        "https://evilapp.example.com",
        "https://app.example.com@evil.com",  # userinfo trick
        "https://evil.com/https://app.example.com",
        "https://evil.com#https://app.example.com",
        "http://app.example.com",  # wrong scheme
        "https://app.example.com:8443",  # wrong port
        "http://localhost:3001",
        "https://app.example.com/path",  # an Origin never has a path
        "https://app.example.com?x=1",
        "null",
        "",
        "https://",
        "https://app.example.com:99999",
        "https://app.example.com:abc",
        "javascript:alert(1)",
        "ftp://app.example.com",
        " https://app.example.com",
        "https://app.example.com ",
        "https://app.example.com\\@evil.com",
        "https://app.example.com\r\nX: y",
        "*",
    ],
)
def test_forged_malformed_and_null_origins_are_rejected(origin: str) -> None:
    assert origin_allowed([origin], [], ALLOWED) is False


def test_a_request_with_neither_header_is_rejected() -> None:
    assert origin_allowed([], [], ALLOWED) is False


def test_a_bad_origin_is_not_rescued_by_a_good_referer() -> None:
    assert origin_allowed(["null"], ["https://app.example.com/"], ALLOWED) is False
    assert origin_allowed(["https://evil.com"], ["https://app.example.com/"], ALLOWED) is False


@pytest.mark.parametrize(
    "referer",
    ["null", "", "not a url", "https://app.example.com.evil.com/x", "https://x@app.example.com/"],
)
def test_a_bad_referer_is_rejected_when_origin_is_absent(referer: str) -> None:
    assert origin_allowed([], [referer], ALLOWED) is False


def test_duplicate_headers_are_ambiguous_and_rejected() -> None:
    twice = ["https://app.example.com", "https://app.example.com"]
    assert origin_allowed(twice, [], ALLOWED) is False
    assert origin_allowed([], twice, ALLOWED) is False


def test_canonical_origin_fills_default_ports_and_brackets_ipv6() -> None:
    assert canonical_origin("http://Example.com", allow_path=False) == "http://example.com:80"
    assert canonical_origin("https://example.com", allow_path=False) == "https://example.com:443"
    assert canonical_origin("http://[::1]:3000", allow_path=False) == "http://[::1]:3000"


def test_allowed_origins_setting_is_parsed_strictly() -> None:
    parsed = parse_allowed_origins(" https://app.example.com/ , http://localhost:3000,, ")
    assert parsed == {"https://app.example.com:443", "http://localhost:3000"}
    assert parse_allowed_origins("") == frozenset()
    for bad in ("*", "app.example.com", "https://app.example.com/path", "ftp://x.org"):
        with pytest.raises(ValueError, match="ALLOWED_ORIGINS"):
            parse_allowed_origins(bad)


@pytest.mark.parametrize(
    ("content_type", "ok"),
    [
        ("application/json", True),
        ("application/json; charset=utf-8", True),
        ("APPLICATION/JSON", True),
        ("application/problem+json", True),
        ("multipart/form-data; boundary=abc", True),
        ("text/plain", False),
        ("application/x-www-form-urlencoded", False),
        ("application/jsonx", False),
        ("", False),
        (None, False),
    ],
)
def test_media_types(content_type: str | None, ok: bool) -> None:
    assert media_type_ok(content_type) is ok


# --- CSRF: the middleware on the real app ----------------------------------------------------

BODY = {"question": "Why did it drop?"}  # the mock Copilot needs no database


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def signed_in() -> Iterator[None]:
    """The CSRF tests post to stub routes, which need a session since T73."""
    app.dependency_overrides[current_principal] = stub_principal
    yield
    app.dependency_overrides.pop(current_principal, None)


def bare_client() -> TestClient:
    """A client with no default Origin header, so a test controls both headers itself."""
    client = TestClient(app)
    del client.headers["Origin"]
    return client


@pytest.mark.usefixtures("signed_in")
def test_unsafe_request_with_an_allowed_origin_goes_through(client: TestClient) -> None:
    assert client.post("/copilot", json=BODY).status_code == 200


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_every_unsafe_method_without_origin_is_rejected(method: str) -> None:
    res = bare_client().request(method, "/copilot", json=BODY)

    assert res.status_code == 403
    assert res.json() == {"detail": "csrf_origin"}
    assert res.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_every_unsafe_method_with_a_forged_origin_is_rejected(method: str) -> None:
    res = bare_client().request(
        method, "/copilot", json=BODY, headers={"Origin": "http://testserver.evil.com"}
    )

    assert res.status_code == 403


@pytest.mark.parametrize("origin", ["null", "http://testserver:8000", "https://testserver", ""])
def test_wrong_null_and_empty_origins_are_rejected(origin: str) -> None:
    res = bare_client().post("/copilot", json=BODY, headers={"Origin": origin})

    assert res.status_code == 403


@pytest.mark.usefixtures("signed_in")
def test_referer_is_used_only_when_origin_is_absent() -> None:
    good = bare_client().post("/copilot", json=BODY, headers={"Referer": "http://testserver/x"})
    both = bare_client().post(
        "/copilot",
        json=BODY,
        headers={"Origin": "null", "Referer": "http://testserver/x"},
    )
    bad = bare_client().post("/copilot", json=BODY, headers={"Referer": "http://evil.com/x"})

    assert good.status_code == 200
    assert both.status_code == 403
    assert bad.status_code == 403


def test_safe_methods_need_no_origin() -> None:
    assert bare_client().get("/healthz").status_code == 200


def test_the_check_runs_before_routing_so_unknown_paths_also_get_403() -> None:
    assert bare_client().delete("/no/such/route").status_code == 403


@pytest.mark.parametrize(
    ("content_type", "content"),
    [("text/plain", b"hello"), ("application/x-www-form-urlencoded", b"question=hi")],
)
def test_a_body_that_is_not_json_is_rejected(
    client: TestClient, content_type: str, content: bytes
) -> None:
    res = client.post("/copilot", content=content, headers={"Content-Type": content_type})

    assert res.status_code == 415
    assert res.json() == {"detail": "unsupported_media_type"}


@pytest.mark.usefixtures("signed_in")
def test_multipart_bodies_pass_the_media_check_but_are_still_origin_checked(
    client: TestClient,
) -> None:
    upload = {"file": ("evidence.txt", b"abc", "text/plain")}

    assert client.post("/copilot", files=upload).status_code == 422  # reached the route
    assert bare_client().post("/copilot", files=upload).status_code == 403


@pytest.mark.usefixtures("signed_in")
def test_a_post_without_a_body_needs_no_media_type(client: TestClient) -> None:
    assert client.post("/admin/simulate/quarter").status_code == 200


# --- Startup validation ----------------------------------------------------------------------


def test_startup_fails_closed_without_a_rate_limit_secret_outside_dev_and_test(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(RuntimeError, match="AUTH_RATE_LIMIT_SECRET"):
        validate_auth_settings(Settings(_env_file=None, environment="production"))  # type: ignore[call-arg]
    monkeypatch.delenv("ENVIRONMENT")  # unset: not explicitly development or test
    with pytest.raises(RuntimeError, match="AUTH_RATE_LIMIT_SECRET"):
        validate_auth_settings(Settings(_env_file=None))  # type: ignore[call-arg]


def test_startup_accepts_production_with_a_secret_and_origins() -> None:
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        environment="production",
        auth_rate_limit_secret="x" * 32,
        allowed_origins="https://app.example.com",
    )

    assert validate_auth_settings(settings) == {"https://app.example.com:443"}


def test_startup_rejects_a_wildcard_origin() -> None:
    settings = Settings(_env_file=None, environment="test", allowed_origins="*")  # type: ignore[call-arg]

    with pytest.raises(ValueError, match="ALLOWED_ORIGINS"):
        validate_auth_settings(settings)


# --- Rate limits: client IP and bucket keys (pure) -------------------------------------------


@pytest.mark.parametrize(
    ("forwarded", "peer", "hops", "expected"),
    [
        (["1.2.3.4"], "9.9.9.9", 0, "9.9.9.9"),  # no trusted proxy: the header is ignored
        (["5.6.7.8"], "10.0.0.1", 1, "5.6.7.8"),
        (["evil, 5.6.7.8"], "10.0.0.1", 1, "5.6.7.8"),  # entries left of ours are client-written
        (["9.9.9.9, 5.6.7.8"], "10.0.0.1", 1, "5.6.7.8"),
        (["1.1.1.1, 2.2.2.2, 3.3.3.3"], "10.0.0.1", 2, "2.2.2.2"),
        (["1.1.1.1", "2.2.2.2"], "10.0.0.1", 2, "1.1.1.1"),  # header lines are one chain
        (["5.6.7.8"], "10.0.0.1", 3, "10.0.0.1"),  # chain shorter than the trusted hops
        ([], "10.0.0.1", 1, "10.0.0.1"),
        (["not-an-ip"], "10.0.0.1", 1, "10.0.0.1"),
        (["5.6.7.8"], None, 0, "unknown"),
        ([], "testclient", 0, "testclient"),
    ],
)
def test_client_ip_is_taken_only_through_the_trusted_hops(
    forwarded: list[str], peer: str | None, hops: int, expected: str
) -> None:
    assert auth.client_ip(forwarded, peer, hops) == expected


def test_ipv6_clients_share_a_bucket_per_64_prefix() -> None:
    first = auth.client_ip([], "2001:db8:1:2::1", 0)
    same_prefix = auth.client_ip([], "2001:db8:1:2:ffff::9", 0)
    other_prefix = auth.client_ip([], "2001:db8:1:3::1", 0)

    assert first == same_prefix == "2001:db8:1:2::"
    assert other_prefix != first


def test_bucket_keys_are_keyed_hashes_that_hide_their_subject() -> None:
    key = auth.bucket_key("secret", AuthBucket.ACCOUNT, "ro@example.org")

    assert len(key) == 64 and int(key, 16) >= 0
    assert "ro@example.org" not in key
    assert key == auth.bucket_key("secret", AuthBucket.ACCOUNT, "ro@example.org")
    assert key != auth.bucket_key("other", AuthBucket.ACCOUNT, "ro@example.org")
    assert key != auth.bucket_key("secret", AuthBucket.IP, "ro@example.org")  # buckets don't mix


# --- Rate limits: counting in Postgres -------------------------------------------------------

LOGIN, REGISTER = AuthAttemptKind.LOGIN, AuthAttemptKind.REGISTER
SECRET = "test-secret"
T0 = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
PASSWORD = "correct horse battery"


@pytest.fixture
def conn() -> Iterator[Connection]:
    """A connection inside a transaction that is rolled back, so nothing persists."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as connection:
        outer = connection.begin()
        yield connection
        outer.rollback()
    engine.dispose()


@pytest.fixture
def session(conn: Connection) -> Iterator[Session]:
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    seed(db)
    yield db
    db.close()


@pytest.fixture
def db_client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


def ip_key(value: str) -> tuple[AuthBucket, str]:
    return AuthBucket.IP, auth.bucket_key(SECRET, AuthBucket.IP, value)


def account_key(email: str) -> tuple[AuthBucket, str]:
    subject = auth.normalize_email(email)
    return AuthBucket.ACCOUNT, auth.bucket_key(SECRET, AuthBucket.ACCOUNT, subject)


def attempt(
    session: Session,
    ip: str,
    email: str,
    kind: AuthAttemptKind = LOGIN,
    now: datetime = T0,
) -> int | None:
    return auth.consume_attempt(session, kind, [ip_key(ip), account_key(email)], now)


def stored(session: Session) -> int:
    session.expire_all()
    return session.exec(select(func.count()).select_from(AuthAttempt)).one()


@requires_db
def test_login_is_allowed_ten_times_then_refused(session: Session) -> None:
    for _ in range(10):
        assert attempt(session, "1.1.1.1", "ro@example.org") is None

    assert attempt(session, "1.1.1.1", "ro@example.org") == 900
    assert stored(session) == 20, "two buckets per allowed attempt; the refused one stores nothing"


@requires_db
def test_register_is_allowed_five_times_an_hour(session: Session) -> None:
    for _ in range(5):
        assert attempt(session, "1.1.1.1", "ro@example.org", REGISTER) is None

    assert attempt(session, "1.1.1.1", "ro@example.org", REGISTER) == 3600


@requires_db
def test_login_and_register_are_counted_separately(session: Session) -> None:
    for _ in range(10):
        attempt(session, "1.1.1.1", "ro@example.org", LOGIN)

    assert attempt(session, "1.1.1.1", "ro@example.org", REGISTER) is None


@requires_db
def test_the_window_slides_and_retry_after_shrinks(session: Session) -> None:
    for _ in range(10):
        attempt(session, "1.1.1.1", "ro@example.org")

    assert attempt(session, "1.1.1.1", "ro@example.org", now=T0 + timedelta(seconds=100)) == 800
    almost = T0 + timedelta(minutes=14, seconds=59)
    assert attempt(session, "1.1.1.1", "ro@example.org", now=almost) == 1
    assert (
        attempt(session, "1.1.1.1", "ro@example.org", now=T0 + timedelta(minutes=15, seconds=1))
        is None
    )


WINDOW = auth.RATE_LIMITS[LOGIN].window
TICK = timedelta(microseconds=1)


@pytest.mark.parametrize(
    ("oldest", "expected"),
    [
        (T0, 900),  # stamped this instant: the full window
        (T0 - timedelta(seconds=100), 800),
        (T0 - timedelta(seconds=99, milliseconds=1), 801),  # a sub-second remainder rounds up
        (T0 - WINDOW + timedelta(milliseconds=500), 1),
        (T0 - WINDOW + TICK, 1),  # a microsecond from the edge
        (T0 - WINDOW, 1),  # exactly at the edge: never 0
        (T0 + TICK, 900),  # stamped after now (a later clock): never more than the window
        (T0 + timedelta(seconds=5), 900),
    ],
)
def test_retry_after_is_whole_seconds_within_the_window(oldest: datetime, expected: int) -> None:
    assert auth.retry_after_seconds(oldest, T0, WINDOW) == expected


REGISTER_WINDOW = auth.RATE_LIMITS[REGISTER].window


@pytest.mark.parametrize(
    ("oldest", "expected"),
    [
        (T0, 3600),
        (T0 - REGISTER_WINDOW + timedelta(milliseconds=500), 1),
        (T0 - REGISTER_WINDOW + TICK, 1),
        (T0 + TICK, 3600),
    ],
)
def test_register_retry_after_stays_within_its_hour(oldest: datetime, expected: int) -> None:
    assert auth.retry_after_seconds(oldest, T0, REGISTER_WINDOW) == expected


def test_a_clamped_retry_after_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="app.auth"):
        assert auth.retry_after_seconds(T0 + timedelta(seconds=2), T0, WINDOW) == 900
        assert auth.retry_after_seconds(T0, T0, WINDOW) == 900  # not clamped, not logged

    assert [r.getMessage().split(":")[0] for r in caplog.records] == ["retry_after_clamped"]


@requires_db
def test_attempts_stamped_after_now_still_ask_for_at_most_the_window(session: Session) -> None:
    for _ in range(10):
        attempt(session, "1.1.1.1", "ro@example.org", now=T0 + timedelta(milliseconds=500))

    assert attempt(session, "1.1.1.1", "ro@example.org", now=T0) == 900


@requires_db
def test_the_ip_bucket_limits_across_accounts(session: Session) -> None:
    for i in range(10):
        assert attempt(session, "1.1.1.1", f"user{i}@example.org") is None

    assert attempt(session, "1.1.1.1", "fresh@example.org") is not None
    assert attempt(session, "2.2.2.2", "fresh@example.org") is None


@requires_db
def test_the_account_bucket_limits_across_ips(session: Session) -> None:
    for i in range(10):
        assert attempt(session, f"10.0.0.{i}", "victim@example.org") is None

    assert attempt(session, "10.0.0.99", "victim@example.org") is not None
    assert attempt(session, "10.0.0.99", "other@example.org") is None


@requires_db
def test_the_account_key_ignores_case_and_surrounding_spaces(session: Session) -> None:
    for i in range(10):
        attempt(session, f"10.0.0.{i}", " Victim@Example.ORG ")

    assert attempt(session, "10.0.0.99", "victim@example.org") is not None


@requires_db
def test_a_refused_attempt_charges_the_bucket_that_was_still_open(session: Session) -> None:
    for i in range(10):
        attempt(session, "1.1.1.1", f"user{i}@example.org")
    assert attempt(session, "1.1.1.1", "shared@example.org") is not None  # IP bucket is full

    # The shared account was not charged for it: it still has all ten attempts left.
    for i in range(10):
        assert attempt(session, f"10.1.0.{i}", "shared@example.org") is None
    assert attempt(session, "10.1.0.99", "shared@example.org") is not None


@requires_db
def test_the_table_holds_only_hashes(session: Session) -> None:
    attempt(session, "203.0.113.7", "ro@example.org")
    session.expire_all()

    for row in session.exec(select(AuthAttempt)).all():
        assert len(row.key_hmac) == 64
        assert "@" not in row.key_hmac and "203.0.113.7" not in row.key_hmac


@requires_db
def test_prune_removes_attempts_older_than_a_day(session: Session) -> None:
    now = datetime.now(UTC)
    for hours in (25, 23):
        auth.consume_attempt(session, LOGIN, [ip_key(f"a{hours}")], now - timedelta(hours=hours))

    assert auth.prune_auth_attempts(session, now) == 1
    session.commit()
    assert stored(session) == 1


# --- Rate limits: concurrency (real commits, one connection per thread) --------------------------


@pytest.fixture
def committed_engine() -> Iterator[Any]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url, pool_size=24)
    yield engine
    engine.dispose()


def run_concurrently(
    engine: Any, keys: list[tuple[AuthBucket, str]], workers: int
) -> list[int | None]:
    def one(index: int) -> int | None:
        ordered = keys if index % 2 == 0 else list(reversed(keys))  # opposite lock order
        with Session(engine) as db:
            return auth.consume_attempt(db, LOGIN, ordered)

    with ThreadPoolExecutor(max_workers=16) as pool:
        return list(pool.map(one, range(workers)))


def forget(engine: Any, keys: list[tuple[AuthBucket, str]]) -> None:
    with Session(engine) as db:
        for _, key in keys:
            db.execute(AuthAttempt.__table__.delete().where(col(AuthAttempt.key_hmac) == key))  # type: ignore[attr-defined]
        db.commit()


@requires_db
def test_concurrent_attempts_cannot_slip_past_the_limit(committed_engine: Any) -> None:
    keys = [ip_key(f"concurrent-{uuid4()}"), account_key(f"{uuid4()}@example.org")]
    try:
        results = run_concurrently(committed_engine, keys, workers=48)

        assert results.count(None) == auth.RATE_LIMITS[LOGIN].attempts
        refused = [wait for wait in results if wait is not None]
        assert len(refused) == 48 - 10, f"refused {len(refused)}: {results}"
        out_of_range = [wait for wait in refused if not 1 <= wait <= 900]
        assert not out_of_range, f"retry-after outside [1, 900]: {out_of_range} of {refused}"
        with Session(committed_engine) as db:
            per_bucket = db.exec(
                select(AuthAttempt.key_hmac, func.count())  # type: ignore[call-overload]
                .where(col(AuthAttempt.key_hmac).in_([key for _, key in keys]))
                .group_by(AuthAttempt.key_hmac)
            ).all()
        assert sorted(count for _, count in per_bucket) == [10, 10]
    finally:
        forget(committed_engine, keys)


@requires_db
def test_overlapping_buckets_taken_in_opposite_order_do_not_deadlock(
    committed_engine: Any,
) -> None:
    keys = [ip_key(f"overlap-{uuid4()}"), account_key(f"{uuid4()}@example.org")]
    try:
        results = run_concurrently(committed_engine, keys, workers=32)  # a deadlock would raise

        assert results.count(None) == 10
    finally:
        forget(committed_engine, keys)


@requires_db
def test_the_clock_is_read_after_waiting_for_the_lock(
    committed_engine: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A waiter's time can't predate attempts committed while it waited.

    Regression test for #143: the clock was read before the lock, so a waiter saw attempts
    stamped after its own time and answered a Retry-After of 901 for a 900-second window.
    """
    keys = [ip_key(f"clock-{uuid4()}")]
    bucket, key = keys[0]
    clock = [T0]
    monkeypatch.setattr(auth, "_now", lambda: clock[0])

    waiter_pid: Future[int] = Future()

    def waiter() -> int | None:
        with Session(committed_engine) as db:
            waiter_pid.set_result(db.execute(text("SELECT pg_backend_pid()")).scalar_one())
            return auth.consume_attempt(db, LOGIN, keys)

    later = T0 + timedelta(seconds=1)
    try:
        with Session(committed_engine) as holder, ThreadPoolExecutor(max_workers=1) as pool:
            holder.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:name, 0))"),
                {"name": auth.lock_name(LOGIN, bucket, key)},
            )
            result = pool.submit(waiter)
            waiting = text(
                "SELECT count(*) FROM pg_locks"
                " WHERE pid = :pid AND locktype = 'advisory' AND NOT granted"
            )
            pid = waiter_pid.result(timeout=5)
            deadline = time.monotonic() + 5
            while not holder.execute(waiting, {"pid": pid}).scalar_one():
                if time.monotonic() > deadline:
                    pytest.fail("the waiter never blocked on the bucket's lock")
                time.sleep(0.005)
            clock[0] = later  # time passes while the waiter is blocked
            holder.add_all(
                AuthAttempt(bucket=bucket, key_hmac=key, kind=LOGIN, created_at=later)
                for _ in range(9)
            )
            holder.commit()

            assert result.result(timeout=10) is None
        with Session(committed_engine) as db:
            stamps = db.exec(
                select(AuthAttempt.created_at).where(col(AuthAttempt.key_hmac) == key)
            ).all()
        assert sorted(stamps) == [later] * 10, "stamped when it got the lock, not when it asked"
    finally:
        forget(committed_engine, keys)


# --- Rate limits and pruning through the routes ----------------------------------------------


def credentials(email: str) -> dict[str, str]:
    return {"email": email, "password": PASSWORD}


def settings_override(**values: Any) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,  # type: ignore[call-arg]
        environment="test",
        **values,
    )


@requires_db
def test_login_is_throttled_per_account_even_when_the_ip_changes(db_client: TestClient) -> None:
    settings_override(trusted_proxy_hops=1)
    for i in range(10):
        res = db_client.post(
            "/auth/login",
            json=credentials("victim@example.org"),
            headers={"X-Forwarded-For": f"203.0.113.{i}"},
        )
        assert res.status_code == 401

    blocked = db_client.post(
        "/auth/login",
        json=credentials("victim@example.org"),
        headers={"X-Forwarded-For": "203.0.113.200"},
    )

    assert blocked.status_code == 429
    assert blocked.json() == {"detail": "too_many_attempts"}
    assert 1 <= int(blocked.headers["retry-after"]) <= 900
    assert blocked.headers["cache-control"] == "no-store"


@requires_db
def test_login_is_throttled_per_ip_even_when_the_account_changes(db_client: TestClient) -> None:
    for i in range(10):
        assert (
            db_client.post("/auth/login", json=credentials(f"user{i}@example.org")).status_code
            == 401
        )

    assert db_client.post("/auth/login", json=credentials("fresh@example.org")).status_code == 429


@requires_db
def test_a_forged_forwarded_for_header_does_not_buy_a_new_bucket(db_client: TestClient) -> None:
    for i in range(10):  # no trusted proxy configured: the header is ignored
        res = db_client.post(
            "/auth/login",
            json=credentials(f"user{i}@example.org"),
            headers={"X-Forwarded-For": f"198.51.100.{i}"},
        )
        assert res.status_code == 401

    blocked = db_client.post(
        "/auth/login",
        json=credentials("fresh@example.org"),
        headers={"X-Forwarded-For": "198.51.100.99"},
    )

    assert blocked.status_code == 429


@requires_db
def test_the_throttle_does_not_reveal_which_emails_exist(db_client: TestClient) -> None:
    settings_override(trusted_proxy_hops=1)
    assert (
        db_client.post(
            "/auth/register", json={**credentials("known@example.org"), "name": "Ro"}
        ).status_code
        == 201
    )
    db_client.cookies.clear()

    outcomes = []
    for email in ("known@example.org", "unknown@example.org"):
        for i in range(10):
            headers = {"X-Forwarded-For": f"203.0.113.{i}"}
            db_client.post("/auth/login", json=credentials(email), headers=headers)
        blocked = db_client.post(
            "/auth/login", json=credentials(email), headers={"X-Forwarded-For": "203.0.113.99"}
        )
        outcomes.append((blocked.status_code, blocked.json()))

    assert outcomes[0] == outcomes[1] == (429, {"detail": "too_many_attempts"})


@requires_db
def test_registration_is_limited_to_five_an_hour_per_ip(db_client: TestClient) -> None:
    for i in range(5):
        res = db_client.post(
            "/auth/register", json={**credentials(f"new{i}@example.org"), "name": "Ro"}
        )
        assert res.status_code == 201

    res = db_client.post("/auth/register", json={**credentials("new5@example.org"), "name": "Ro"})

    assert res.status_code == 429
    assert res.json() == {"detail": "too_many_attempts"}


@requires_db
def test_duplicate_registration_has_one_status_and_body_shape(db_client: TestClient) -> None:
    body = {**credentials("ro@example.org"), "name": "Ro"}
    assert db_client.post("/auth/register", json=body).status_code == 201

    same = db_client.post("/auth/register", json=body)
    other_case = db_client.post("/auth/register", json={**body, "email": "RO@Example.org"})

    assert (same.status_code, other_case.status_code) == (409, 409)
    assert same.json() == other_case.json() == {"detail": auth.EMAIL_UNAVAILABLE}


@requires_db
def test_auth_requests_prune_expired_sessions_and_old_attempts(
    db_client: TestClient, session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = {**credentials("ro@example.org"), "name": "Ro"}
    assert db_client.post("/auth/register", json=body).status_code == 201
    now = datetime.now(UTC)
    session.execute(update(UserSession).values(expires_at=now - timedelta(days=1)))
    old = AuthAttempt(
        bucket=AuthBucket.IP, key_hmac="a" * 64, kind=LOGIN, created_at=now - timedelta(hours=25)
    )
    session.add(old)
    session.commit()
    monkeypatch.setattr(deps, "_last_auth_prune", None)  # the next auth request may prune
    db_client.cookies.clear()

    db_client.post("/auth/login", json=credentials("nobody@example.org"))

    session.expire_all()
    assert session.exec(select(func.count()).select_from(UserSession)).one() == 0
    assert session.exec(select(AuthAttempt).where(AuthAttempt.key_hmac == "a" * 64)).first() is None


def test_the_app_validates_its_auth_settings_when_it_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.main.settings", Settings(_env_file=None, environment="production"))  # type: ignore[call-arg]

    with pytest.raises(RuntimeError, match="AUTH_RATE_LIMIT_SECRET"), TestClient(app):
        pass


def test_importing_the_app_needs_no_production_secrets() -> None:
    """The OpenAPI export for the API client imports the app with no ENVIRONMENT or secrets."""
    env = {
        k: v for k, v in os.environ.items() if k not in {"ENVIRONMENT", "AUTH_RATE_LIMIT_SECRET"}
    }
    env["ENVIRONMENT"] = "production"
    result = subprocess.run(
        [sys.executable, "-c", "from app.main import app; app.openapi()"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert result.returncode == 0, result.stderr


# --- Review fixes (R1, R2, C1, C4, C6, C8, N1, N2) ---------------------------------------------


@pytest.mark.parametrize(
    ("forwarded", "peer", "hops", "expected"),
    [
        ([], "::ffff:203.0.113.7", 0, "203.0.113.7"),  # IPv4 client on a dual-stack socket
        (["::ffff:198.51.100.9"], "10.0.0.1", 1, "198.51.100.9"),
        (["203.0.113.7:5000"], "10.0.0.1", 1, "203.0.113.7"),  # a proxy that appends the port
        (["[2001:db8:1:2::1]:443"], "10.0.0.1", 1, "2001:db8:1:2::"),
        (["[2001:db8:1:2::1]"], "10.0.0.1", 1, "2001:db8:1:2::"),
        (["1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4"], "10.0.0.1", 2, "3.3.3.3"),  # left entries ignored
    ],
)
def test_client_ip_handles_mapped_addresses_and_ports(
    forwarded: list[str], peer: str | None, hops: int, expected: str
) -> None:
    assert auth.client_ip(forwarded, peer, hops) == expected


def test_different_ipv4_clients_on_a_dual_stack_socket_get_different_buckets() -> None:
    first = auth.client_ip([], "::ffff:203.0.113.7", 0)
    second = auth.client_ip([], "::ffff:198.51.100.9", 0)

    assert first != second


def test_port_zero_is_not_the_default_port() -> None:
    assert origin_allowed(["https://app.example.com:0"], [], ALLOWED) is False
    assert canonical_origin("http://example.com:0", allow_path=False) == "http://example.com:0"


def test_a_vendor_json_type_must_be_an_application_type() -> None:
    assert media_type_ok("application/vnd.api+json") is True
    assert media_type_ok("text/foo+json") is False


def test_two_origin_header_lines_are_rejected_through_the_middleware() -> None:
    res = bare_client().post(
        "/copilot",
        json=BODY,
        headers=[("Origin", "http://testserver"), ("Origin", "http://testserver")],
    )

    assert res.status_code == 403


def test_an_unusual_method_is_checked_like_any_unsafe_one() -> None:
    assert bare_client().request("PROPFIND", "/copilot").status_code == 403


@pytest.mark.parametrize("method", ["HEAD", "OPTIONS"])
def test_head_and_options_need_no_origin(method: str) -> None:
    assert bare_client().request(method, "/healthz").status_code != 403


def test_a_chunked_body_with_no_content_length_still_needs_a_json_type(
    client: TestClient,
) -> None:
    res = client.post("/copilot", content=iter([b"hello"]), headers={"Content-Type": "text/plain"})

    assert res.status_code == 415


@pytest.mark.usefixtures("signed_in")
def test_an_empty_body_needs_no_media_type(client: TestClient) -> None:
    res = client.post("/copilot", content=b"", headers={"Content-Type": "text/plain"})

    assert res.status_code == 422  # reached the route, which wants a JSON body


def test_startup_warns_when_a_deployed_api_trusts_no_proxy(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def settings(hops: int) -> Settings:
        return Settings(
            _env_file=None,  # type: ignore[call-arg]
            environment="production",
            auth_rate_limit_secret="x" * 32,
            allowed_origins="https://app.example.com",
            trusted_proxy_hops=hops,
        )

    with caplog.at_level("WARNING", logger="app"):
        validate_auth_settings(settings(0))
    assert "TRUSTED_PROXY_HOPS=0" in caplog.text

    caplog.clear()
    with caplog.at_level("WARNING", logger="app"):
        validate_auth_settings(settings(1))
    assert "TRUSTED_PROXY_HOPS" not in caplog.text


def test_a_deployed_api_must_set_allowed_origins_explicitly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ALLOWED_ORIGINS")  # conftest forces it for the other tests
    deployed = Settings(
        _env_file=None,  # type: ignore[call-arg]
        environment="production",
        auth_rate_limit_secret="x" * 32,
    )

    with pytest.raises(RuntimeError, match="ALLOWED_ORIGINS"):
        validate_auth_settings(deployed)


def test_development_and_test_may_use_the_default_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ALLOWED_ORIGINS")
    settings = Settings(_env_file=None, environment="test")  # type: ignore[call-arg]

    assert validate_auth_settings(settings) == {"http://localhost:3000"}


@requires_db
def test_a_held_bucket_lock_makes_the_attempt_give_up_with_attempts_busy(
    committed_engine: Any,
) -> None:
    keys = [ip_key(f"busy-{uuid4()}")]
    name = f"auth_attempts|login|ip|{keys[0][1]}"
    with committed_engine.connect() as holder:
        holder.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:name, 0))"), {"name": name}
        )
        with Session(committed_engine) as db:
            with pytest.raises(auth.AttemptsBusy):
                auth.consume_attempt(db, LOGIN, keys, lock_timeout_ms=200)
            assert db.execute(text("SELECT 1")).scalar() == 1  # the session is still usable

    with Session(committed_engine) as db:  # once the holder is gone the attempt goes through
        assert auth.consume_attempt(db, LOGIN, keys) is None
    forget(committed_engine, keys)


@requires_db
def test_a_busy_bucket_is_a_503_that_says_to_retry(
    db_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def busy(*args: object, **kwargs: object) -> int | None:
        raise auth.AttemptsBusy

    monkeypatch.setattr("app.routers.auth.consume_attempt", busy)

    res = db_client.post("/auth/login", json=credentials("ro@example.org"))

    assert res.status_code == 503
    assert res.json() == {"detail": "auth_busy"}
    assert res.headers["retry-after"] == "1"


@requires_db
def test_a_failing_prune_does_not_fail_the_login(
    db_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(_session: Session) -> tuple[int, int]:
        raise RuntimeError("disk full")

    monkeypatch.setattr(deps, "prune_auth_data", boom)
    monkeypatch.setattr(deps, "_last_auth_prune", None)

    res = db_client.post("/auth/login", json=credentials("nobody@example.org"))

    assert res.status_code == 401  # an ordinary wrong-credentials answer, not a 500
