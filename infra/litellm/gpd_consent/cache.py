"""In-process TTL cache for per-user consent state.

Per-worker dict. On a 4-worker deploy, a revocation OR an accept of a
new TOS version propagates to all workers within at most the TTL window
(default 300s). That matches the Privacy Policy claim "processing halts
after withdrawal" with a <=5-minute operational lag per worker. If legal
requires immediate global invalidation, swap this for Redis pub/sub
(see module-level NOTE in hook.py).

Thread model: LiteLLM workers run under uvicorn with one event loop per
worker process. asyncio.Lock is correct; no threading.Lock needed. On worker
restart / redeploy, the dict resets — consent state is re-queried on next
call.

Pre-2026-04-30 the cache stored bare `is_revoked: bool`. We added the
`accepted_version` dimension to support server-side TOS-version-floor
enforcement (LAUNCH-READINESS.md P0-2): a revoke check alone is not
enough to gate LLM calls when a TOS bump is pending. The cache value is
now the full ConsentState object; helpers `get`/`set` keep the
single-call signature stable for the gate.
"""
from __future__ import annotations

import asyncio
import time
from typing import Dict, Optional, Tuple

from .db import ConsentState

_DEFAULT_TTL_SECONDS = 300.0

# Maps user_id → (state, expires_at_monotonic). Absence of an entry means
# "cache miss, must query DB".
_cache: Dict[str, Tuple[ConsentState, float]] = {}
_lock = asyncio.Lock()


async def get(user_id: str) -> Optional[ConsentState]:
    """Return cached consent state, or None on cache miss / expired entry.

    Expired entries are evicted eagerly so the dict doesn't grow without
    bound for users who churn through the system once and never return."""
    async with _lock:
        entry = _cache.get(user_id)
        if entry is None:
            return None
        state, expires_at = entry
        if time.monotonic() >= expires_at:
            _cache.pop(user_id, None)
            return None
        return state


async def set(user_id: str, state: ConsentState, ttl: float = _DEFAULT_TTL_SECONDS) -> None:
    async with _lock:
        _cache[user_id] = (state, time.monotonic() + ttl)


async def invalidate(user_id: str) -> None:
    """Force-evict one user. Called from /gpd/tos-revoke handler so the user's
    OWN worker drops the cached state immediately on revoke. Other workers
    still lag by up to one TTL window. Also called from /gpd/tos-accept after
    a successful insert, so a re-accept under a fresh tos_version is reflected
    on the local worker right away."""
    async with _lock:
        _cache.pop(user_id, None)


async def clear() -> None:
    """Test helper. Never call from request path — hot-path clear would
    thunder on the DB for the next N requests."""
    async with _lock:
        _cache.clear()
