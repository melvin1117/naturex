"""The fixed worlds (ADR-0005 §2). No app imports, so the pure policy (`app.authz`) can use it."""

from __future__ import annotations

from uuid import UUID

# The template every sandbox is copied from; never served, reset or pruned. Stable so re-running
# the seed is a no-op.
WORLD_ID = UUID("11111111-1111-1111-1111-111111111111")
# The one persistent world for real accounts; built by app.sandbox.ensure_live_world.
LIVE_WORLD_ID = UUID("44444444-4444-4444-4444-444444444444")
LIVE_LABEL = "live"

PROTECTED_WORLDS: frozenset[UUID] = frozenset({WORLD_ID, LIVE_WORLD_ID})


def is_sandbox_world(world_id: UUID) -> bool:
    """A demo sandbox: any world but the template and the live world."""
    return world_id not in PROTECTED_WORLDS
