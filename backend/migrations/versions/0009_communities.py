"""Communities, members and treasuries with DB-enforced world isolation (ADR-0005 §3; T56).

Schema:
- `communities` (one `treasury` user each, `treasury_user_id` unique) and `community_members`
  (`owner | steward`), both with `world_id NOT NULL` and composite `(world_id, …_id)` foreign
  keys onto unique `(world_id, id)` keys, so no row can link across worlds.
- `assets.community_id`; `assets.community_user_id` (the treasury) moves from a plain foreign key
  to composite ones, and when both are set the asset's treasury must be its community's
  (`fk_assets_community_treasury`).
- A partial unique index on `users (world_id, persona_key)`, so a sandbox reset can keep persona
  user IDs by key and existing sessions survive.
- Triggers: a treasury can't place orders, hold a session or be a community member, and a
  community's `treasury_user_id` must name a `treasury` user.

Data:
- **Existing demo sandboxes are reset on upgrade:** every world except the template and the live
  world is deleted, in the sandbox cleanup order (`app.sandbox._DELETE_ORDER`), with the ledger
  delete opt-in (`naturex.allow_ledger_delete`, migration 0003) switched on only around those
  deletes. LLM call logs are kept, detached, for the spend cap. Visitors get a fresh sandbox on
  their next visit.
- The template and the live world get one community per curated site whose `community_user_id`
  was a persona (Rosa): a new treasury user (no credentials, 0 cash) takes over that persona's
  retained-stake holding, so shares stay conserved, and becomes `assets.community_user_id`; the
  persona becomes the community's owner. Template rows use the same fixed IDs as `app.seed`, so a
  later `make seed` is a no-op. Payout lines already paid to the persona stay as they are, so
  their commitments still verify.

Downgrading moves each treasury's holdings and cash back to its community's first owner, erases
the treasury's payout lines to tombstones (the leaf hashes stay, so commitments verify with
erasures), points `community_user_id` back at the owner and deletes the treasury. A treasury
whose community has no owner is kept as a plain user (`kind = 'treasury'` is valid at 0008).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-15
"""

from collections.abc import Sequence
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | Sequence[str] | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TEMPLATE_WORLD_ID = UUID("11111111-1111-1111-1111-111111111111")
LIVE_WORLD_ID = UUID("44444444-4444-4444-4444-444444444444")
# Frozen copy of `app.seed.SEED_COMMUNITIES`: template asset ID → (community ID, treasury ID).
TEMPLATE_COMMUNITY_IDS: dict[UUID, tuple[UUID, UUID]] = {
    UUID("33333333-3333-3333-3333-333333333301"): (
        UUID("55555555-5555-5555-5555-555555555501"),
        UUID("66666666-6666-6666-6666-666666666601"),
    ),
    UUID("33333333-3333-3333-3333-333333333302"): (
        UUID("55555555-5555-5555-5555-555555555502"),
        UUID("66666666-6666-6666-6666-666666666602"),
    ),
    UUID("33333333-3333-3333-3333-333333333303"): (
        UUID("55555555-5555-5555-5555-555555555503"),
        UUID("66666666-6666-6666-6666-666666666603"),
    ),
}
# Children before parents, as in `app.sandbox._DELETE_ORDER` at 0008.
_SANDBOX_TABLES = (
    "ledger_entries",
    "payout_lines",
    "doc_chunks",
    "alerts",
    "world_events",
    "orders",
    "holdings",
    "prices",
    "events",
    "reports",
    "metrics",
    "assets",
    "sessions",
    "users",
)


def _discard_visitor_worlds(bind: sa.Connection) -> None:
    kept = {"template": TEMPLATE_WORLD_ID, "live": LIVE_WORLD_ID}
    visitor = "world_id NOT IN (:template, :live)"
    bind.execute(
        sa.text(
            "UPDATE llm_calls SET asset_id = NULL "
            f"WHERE asset_id IN (SELECT id FROM assets WHERE {visitor})"
        ),
        kept,
    )
    bind.execute(sa.text(f"UPDATE llm_calls SET world_id = NULL WHERE {visitor}"), kept)
    bind.execute(sa.text("SET LOCAL naturex.allow_ledger_delete = 'on'"))
    for table in _SANDBOX_TABLES:
        bind.execute(sa.text(f"DELETE FROM {table} WHERE {visitor}"), kept)
    bind.execute(sa.text("SET LOCAL naturex.allow_ledger_delete = 'off'"))
    bind.execute(sa.text("DELETE FROM worlds WHERE id NOT IN (:template, :live)"), kept)


def _backfill_communities(bind: sa.Connection) -> None:
    """One community, treasury and owner per asset whose `community_user_id` isn't one yet."""
    rows = bind.execute(
        sa.text(
            """
            SELECT a.id, a.world_id, a.name, a.country, a.community_user_id, u.kind
            FROM assets a
            JOIN users u ON u.world_id = a.world_id AND u.id = a.community_user_id
            WHERE a.community_id IS NULL
            ORDER BY a.world_id, a.id
            """
        )
    ).all()
    for asset_id, world_id, name, country, holder_id, holder_kind in rows:
        fixed = TEMPLATE_COMMUNITY_IDS.get(asset_id) if world_id == TEMPLATE_WORLD_ID else None
        community_id, treasury_id = fixed or (uuid4(), uuid4())
        owner_id: UUID | None = holder_id
        if holder_kind == "treasury":  # kept by a downgrade because it had no owner
            treasury_id, owner_id = holder_id, None
        else:
            bind.execute(
                sa.text(
                    "INSERT INTO users (id, world_id, name, role, cash_balance, kind) "
                    "VALUES (:id, :world, :name, 'community', 0, 'treasury')"
                ),
                {"id": treasury_id, "world": world_id, "name": f"{name} Community Treasury"},
            )
        bind.execute(
            sa.text(
                "INSERT INTO communities (id, world_id, name, country, treasury_user_id) "
                "VALUES (:id, :world, :name, :country, :treasury)"
            ),
            {
                "id": community_id,
                "world": world_id,
                "name": f"{name} Community",
                "country": country,
                "treasury": treasury_id,
            },
        )
        if owner_id is not None:
            params = {
                "community": community_id,
                "world": world_id,
                "owner": owner_id,
                "treasury": treasury_id,
                "asset": asset_id,
            }
            bind.execute(
                sa.text(
                    "INSERT INTO community_members (community_id, user_id, world_id, role) "
                    "VALUES (:community, :owner, :world, 'owner')"
                ),
                params,
            )
            bind.execute(
                sa.text(
                    "UPDATE holdings SET user_id = :treasury "
                    "WHERE world_id = :world AND asset_id = :asset AND user_id = :owner"
                ),
                params,
            )
        bind.execute(
            sa.text(
                "UPDATE assets SET community_id = :community, community_user_id = :treasury "
                "WHERE id = :asset"
            ),
            {"community": community_id, "treasury": treasury_id, "asset": asset_id},
        )


def upgrade() -> None:
    bind = op.get_bind()
    _discard_visitor_worlds(bind)

    op.create_index(
        "uq_users_world_persona_key",
        "users",
        ["world_id", "persona_key"],
        unique=True,
        postgresql_where=sa.text("persona_key IS NOT NULL"),
    )
    op.create_table(
        "communities",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("country", sa.String(), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("treasury_user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(
            ["world_id", "treasury_user_id"],
            ["users.world_id", "users.id"],
            name="fk_communities_treasury_user",
        ),
        sa.UniqueConstraint("world_id", "id", name="uq_communities_world_id_id"),
        sa.UniqueConstraint(
            "world_id", "id", "treasury_user_id", name="uq_communities_world_id_id_treasury"
        ),
        sa.UniqueConstraint("treasury_user_id", name="uq_communities_treasury_user_id"),
    )
    op.create_table(
        "community_members",
        sa.Column("community_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("community_id", "user_id"),
        sa.ForeignKeyConstraint(
            ["world_id", "community_id"],
            ["communities.world_id", "communities.id"],
            name="fk_community_members_community",
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "user_id"],
            ["users.world_id", "users.id"],
            name="fk_community_members_user",
        ),
        sa.CheckConstraint("role IN ('owner','steward')", name="ck_community_members_role"),
    )
    op.create_index(
        "ix_community_members_world_id_user_id", "community_members", ["world_id", "user_id"]
    )

    op.add_column("assets", sa.Column("community_id", sa.Uuid(), nullable=True))
    op.drop_constraint("assets_community_user_id_fkey", "assets", type_="foreignkey")
    op.create_foreign_key(
        "fk_assets_community",
        "assets",
        "communities",
        ["world_id", "community_id"],
        ["world_id", "id"],
    )
    op.create_foreign_key(
        "fk_assets_community_user",
        "assets",
        "users",
        ["world_id", "community_user_id"],
        ["world_id", "id"],
    )
    op.create_foreign_key(
        "fk_assets_community_treasury",
        "assets",
        "communities",
        ["world_id", "community_id", "community_user_id"],
        ["world_id", "id", "treasury_user_id"],
    )
    op.create_index("ix_assets_world_id_community_id", "assets", ["world_id", "community_id"])
    op.create_index(
        "ix_assets_world_id_community_user_id", "assets", ["world_id", "community_user_id"]
    )

    # ADR-0005 §3: a treasury never signs in or trades, and isn't a member of anything.
    op.execute(
        """
        CREATE FUNCTION reject_treasury_actor() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'treasury') THEN
                RAISE EXCEPTION 'treasury accounts can''t %', TG_ARGV[0]
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    for table, trigger, action in (
        ("orders", "orders_no_treasury", "trade"),
        ("sessions", "sessions_no_treasury", "sign in"),
        ("community_members", "community_members_no_treasury", "be community members"),
    ):
        op.execute(
            f"CREATE TRIGGER {trigger} BEFORE INSERT OR UPDATE OF user_id ON {table} "
            f"FOR EACH ROW EXECUTE FUNCTION reject_treasury_actor('{action}')"
        )
    op.execute(
        """
        CREATE FUNCTION require_treasury_user() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM users WHERE id = NEW.treasury_user_id AND kind = 'treasury'
            ) THEN
                RAISE EXCEPTION 'a community''s treasury_user_id must name a treasury account'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER communities_treasury_kind "
        "BEFORE INSERT OR UPDATE OF treasury_user_id ON communities "
        "FOR EACH ROW EXECUTE FUNCTION require_treasury_user()"
    )

    _backfill_communities(bind)


def _return_stakes_to_owners(bind: sa.Connection) -> list[UUID]:
    """Undo the treasury split where a community has an owner; returns the treasuries to drop."""
    rows = bind.execute(
        sa.text(
            """
            SELECT c.id, c.world_id, c.treasury_user_id,
                   (SELECT m.user_id FROM community_members m
                    WHERE m.community_id = c.id AND m.role = 'owner'
                    ORDER BY m.created_at, m.user_id LIMIT 1)
            FROM communities c
            ORDER BY c.world_id, c.id
            """
        )
    ).all()
    dropped: list[UUID] = []
    for community_id, world_id, treasury_id, owner_id in rows:
        if owner_id is None:
            continue
        params = {
            "community": community_id,
            "world": world_id,
            "treasury": treasury_id,
            "owner": owner_id,
        }
        # Merge into an existing owner holding, else hand the treasury's row over.
        bind.execute(
            sa.text(
                """
                UPDATE holdings o SET shares = o.shares + t.shares
                FROM holdings t
                WHERE t.world_id = :world AND t.user_id = :treasury
                  AND o.world_id = :world AND o.user_id = :owner AND o.asset_id = t.asset_id
                """
            ),
            params,
        )
        bind.execute(
            sa.text(
                """
                DELETE FROM holdings t
                WHERE t.world_id = :world AND t.user_id = :treasury AND EXISTS (
                    SELECT 1 FROM holdings o
                    WHERE o.world_id = :world AND o.user_id = :owner AND o.asset_id = t.asset_id
                )
                """
            ),
            params,
        )
        bind.execute(
            sa.text(
                "UPDATE holdings SET user_id = :owner "
                "WHERE world_id = :world AND user_id = :treasury"
            ),
            params,
        )
        bind.execute(
            sa.text(
                "UPDATE users SET cash_balance = cash_balance "
                "+ (SELECT cash_balance FROM users WHERE id = :treasury) WHERE id = :owner"
            ),
            params,
        )
        bind.execute(
            sa.text(
                "UPDATE payout_lines "
                "SET user_id = NULL, shares = NULL, amount = NULL, nonce = NULL "
                "WHERE world_id = :world AND user_id = :treasury"
            ),
            params,
        )
        bind.execute(
            sa.text(
                "UPDATE assets SET community_user_id = :owner "
                "WHERE world_id = :world AND community_id = :community"
            ),
            params,
        )
        dropped.append(treasury_id)
    return dropped


def downgrade() -> None:
    bind = op.get_bind()
    op.execute("DROP TRIGGER IF EXISTS communities_treasury_kind ON communities")
    op.execute("DROP FUNCTION IF EXISTS require_treasury_user()")
    for table, trigger in (
        ("orders", "orders_no_treasury"),
        ("sessions", "sessions_no_treasury"),
        ("community_members", "community_members_no_treasury"),
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {trigger} ON {table}")
    op.execute("DROP FUNCTION IF EXISTS reject_treasury_actor()")

    op.drop_constraint("fk_assets_community_treasury", "assets", type_="foreignkey")
    op.drop_constraint("fk_assets_community_user", "assets", type_="foreignkey")
    op.drop_constraint("fk_assets_community", "assets", type_="foreignkey")
    dropped = _return_stakes_to_owners(bind)

    op.drop_index("ix_assets_world_id_community_user_id", table_name="assets")
    op.drop_index("ix_assets_world_id_community_id", table_name="assets")
    op.drop_column("assets", "community_id")
    op.drop_index("ix_community_members_world_id_user_id", table_name="community_members")
    op.drop_table("community_members")
    op.drop_table("communities")
    for treasury_id in dropped:
        bind.execute(sa.text("DELETE FROM sessions WHERE user_id = :id"), {"id": treasury_id})
        bind.execute(sa.text("DELETE FROM users WHERE id = :id"), {"id": treasury_id})
    op.create_foreign_key(
        "assets_community_user_id_fkey", "assets", "users", ["community_user_id"], ["id"]
    )
    op.drop_index("uq_users_world_persona_key", table_name="users")
