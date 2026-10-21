"""OSMF's public Nominatim policy, shared by every caller in the process (News Scout's reverse
geocoding and the listing map's place search, #215): at most one request per second.

Policy: https://operations.osmfoundation.org/policies/nominatim/
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

NOMINATIM_MIN_INTERVAL_S = 1.0


class NominatimRateLimiter:
    """Per-process limiter for OSMF's public Nominatim 1 req/s policy."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._clock = clock
        self._sleep = sleep
        self._last_slot_at: float | None = None
        self._lock = threading.Lock()

    def wait(self, max_wait_s: float | None = None) -> bool:
        """Wait for this process's next request slot. With `max_wait_s`, give up (False, no slot
        taken) instead of waiting longer than that, so a busy request can answer 429."""
        with self._lock:
            now = self._clock()
            previous = self._last_slot_at
            slot = now if previous is None else max(now, previous + NOMINATIM_MIN_INTERVAL_S)
            delay = slot - now
            if max_wait_s is not None and delay > max_wait_s:
                return False
            self._last_slot_at = slot
        if delay > 0:
            self._sleep(delay)
        return True


DEFAULT_NOMINATIM_RATE_LIMITER = NominatimRateLimiter()
