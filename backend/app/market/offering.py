"""IPO offering rules (T59): what an owner may choose at launch. Pure; no app imports beyond
the standard library, so the API schemas and the IPO service share one set of bounds."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

MIN_RETAINED_PCT = Decimal("10")
MAX_RETAINED_PCT = Decimal("90")
DEFAULT_RETAINED_PCT = Decimal("51.00")
MIN_TOTAL_SHARES = 10_000
"""Below this the order cap (1% of the shares) would be under 100 shares."""
MAX_TOTAL_SHARES = 10_000_000
DEFAULT_TOTAL_SHARES = 1_000_000
"""Also the reference share count of every rating before the IPO (`assets.total_shares`'s
default), so a listing's reports quote a fair value per share before any share exists."""


class InvalidOffering(ValueError):
    """Shares issued or retained % out of range (HTTP 422)."""


@dataclass(frozen=True, slots=True)
class Offering:
    """What the owner chooses: the shares issued and the % the community keeps."""

    total_shares: int = DEFAULT_TOTAL_SHARES
    retained_pct: Decimal = DEFAULT_RETAINED_PCT

    def __post_init__(self) -> None:
        if not MIN_TOTAL_SHARES <= self.total_shares <= MAX_TOTAL_SHARES:
            raise InvalidOffering(
                f"total_shares must be between {MIN_TOTAL_SHARES} and {MAX_TOTAL_SHARES}"
            )
        if not MIN_RETAINED_PCT <= self.retained_pct <= MAX_RETAINED_PCT:
            raise InvalidOffering(
                f"retained_pct must be between {MIN_RETAINED_PCT} and {MAX_RETAINED_PCT}"
            )
        if self.retained_pct != self.retained_pct.quantize(Decimal("0.01")):
            raise InvalidOffering("retained_pct has at most 2 decimal places")
