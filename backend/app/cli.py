"""Operator commands (ADR-0005 §1). Run from backend/: `uv run python -m app.cli --help`.

`create-admin` is the only way to create a live-world admin: never through the API, and never
by promoting an existing account whose email matches. The password is read with `getpass`, or
from the first line of stdin with `--password-stdin` for scripts (T74's E2E setup), never from
argv or the environment, and is never printed or logged.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from collections.abc import Sequence

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from app.auth import (
    NAME_MAX_LENGTH,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    hash_password,
    is_valid_email,
    normalize_email,
)
from app.db import engine
from app.models import User, UserKind, UserRole
from app.sandbox import ensure_live_world


class CliError(Exception):
    """A user-facing error; printed without a stack trace."""


def _check_length(password: str) -> str:
    if not PASSWORD_MIN_LENGTH <= len(password) <= PASSWORD_MAX_LENGTH:
        raise CliError(
            f"The password must be {PASSWORD_MIN_LENGTH}–{PASSWORD_MAX_LENGTH} characters."
        )
    return password


def _read_password() -> str:
    password = _check_length(getpass.getpass("Admin password: "))
    if getpass.getpass("Repeat the password: ") != password:
        raise CliError("The passwords don't match.")
    return password


def _read_password_stdin() -> str:
    """The first line of stdin, without its line ending: no prompt and no confirmation."""
    line = sys.stdin.readline(PASSWORD_MAX_LENGTH + 3)
    return _check_length(line.removesuffix("\n").removesuffix("\r"))


def create_admin(session: Session, email: str, name: str, *, password_stdin: bool = False) -> User:
    """Create a new admin person in the live world. Refuses an email that is already taken."""
    email = normalize_email(email)
    name = name.strip()
    if not is_valid_email(email):
        raise CliError("Enter a valid email address.")
    if not 1 <= len(name) <= NAME_MAX_LENGTH or not name.isprintable():
        raise CliError(f"The name must be 1–{NAME_MAX_LENGTH} printable characters.")
    password = _read_password_stdin() if password_stdin else _read_password()
    live = ensure_live_world(session)
    user = User(
        world_id=live.id,
        name=name,
        role=UserRole.ADMIN,  # label only; authorization uses is_admin (ADR-0005 §3)
        kind=UserKind.PERSON,
        email=email,
        password_hash=hash_password(password),
        is_admin=True,
    )
    session.add(user)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        if "users_world_email" in str(exc.orig):
            raise CliError(
                "An account with this email already exists; admins are never created by "
                "promoting an existing account. Use another email."
            ) from None
        raise
    session.refresh(user)
    return user


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    admin = commands.add_parser(
        "create-admin", help="Create a live-world admin; the password is prompted for."
    )
    admin.add_argument("--email", required=True)
    admin.add_argument("--name", required=True)
    admin.add_argument(
        "--password-stdin",
        action="store_true",
        help="Read the password from the first line of stdin (for scripts) instead of prompting.",
    )
    return parser


def main(argv: Sequence[str] | None = None, session: Session | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "create-admin":
            if session is not None:
                user = create_admin(
                    session, args.email, args.name, password_stdin=args.password_stdin
                )
            else:
                with Session(engine) as own:
                    user = create_admin(
                        own, args.email, args.name, password_stdin=args.password_stdin
                    )
            print(f"Created live-world admin {user.id}.")
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
