"""Audit-DB query for consent state (revocation + accepted version).

Reuses the asyncpg pool opened by `gpd_tos.db` so we don't multiply the
per-worker connection count. Both packages point at the same
`GPD_AUDIT_DATABASE_URL`; each worker holds 1-4 connections total regardless
of how many callers import from either module.

Fail-closed by design: any query error (DB unreachable, schema drift,
auth failure) propagates out of `compute_consent_state()` so the
consent_gate caller can map it to HTTP 503. Silently returning a
"consent ok" result here would let revoked or out-of-version users
continue making LLM calls during an audit-DB outage — legally worse
than a brief service interruption.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from gpd_tos import db as tos_db

logger = logging.getLogger("gpd_consent.db")


@dataclass(frozen=True)
class ConsentState:
    """Newest acceptance row's state, or "no acceptance" sentinel.

    Attributes:
        revoked: True if the newest row has `revoked_at` set, OR if the
            user has no acceptance row at all (users that bypassed the
            client TOS gate get fail-closed).
        accepted_version: The `tos_version` string from the newest row,
            or None if no row exists. Free-form string per migration
            0001 — handler validates regex `^[A-Za-z0-9._-]{1,64}$` at
            insert time. Compared as a `packaging.version.Version` in
            the gate; un-parseable strings are treated as outdated.
    """

    revoked: bool
    accepted_version: Optional[str]


async def compute_consent_state(user_id: str) -> ConsentState:
    """Return the consent state for `user_id` based on the newest
    acceptance row.

    `mark_revoked` (gpd_tos/db.py:111) stamps every non-revoked row for the
    user in a single UPDATE. Once a user revokes, *all* their historical
    rows carry `revoked_at`. A later re-acceptance INSERTs a fresh row with
    `revoked_at IS NULL`, so the newest row is the authoritative state:
    if its `revoked_at` is non-null → user is currently revoked; if null
    → most recent action was an accept (possibly after prior revokes).

    `tos_version` of the newest row is also returned so the gate can
    enforce a server-side version floor (`GPD_MIN_TOS_VERSION`). Without
    server enforcement, a TOS bump would be UI-only — a tampered client
    could keep using the LLM under an old version forever.
    """
    pool = await tos_db._get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT revoked_at IS NOT NULL AS is_revoked,
                   tos_version
              FROM gpd_tos_acceptance
             WHERE user_id = $1
             ORDER BY accepted_at DESC
             LIMIT 1
            """,
            user_id,
        )
    if row is None:
        # No acceptance row at all — user has never accepted. Block:
        # any LLM call from a user without an acceptance record is a
        # bug (either they bypassed the client TOS gate or the accept
        # insert failed). Prefer visible error over silent pass-through.
        return ConsentState(revoked=True, accepted_version=None)
    return ConsentState(
        revoked=bool(row["is_revoked"]),
        accepted_version=row["tos_version"],
    )


# Backward-compat shim. Older callers may still call `is_revoked()` —
# keep it routing through the new ConsentState computation so behaviour
# stays consistent. Remove once all call sites are migrated.
async def is_revoked(user_id: str) -> bool:
    state = await compute_consent_state(user_id)
    return state.revoked
