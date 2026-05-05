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

    Three mutually-exclusive logical states are encoded by the pair
    `(has_accept_row, revoked)`:

      * `has_accept_row=False, revoked=False` — user has never accepted.
        Gate must block but with a "first-time required" code, not
        "withdrawn".
      * `has_accept_row=True,  revoked=False` — user is currently
        consenting. Gate passes through.
      * `has_accept_row=True,  revoked=True`  — user previously accepted
        and then revoked. Gate blocks with the "withdrawn" code.

    Attributes:
        revoked: True iff the newest row has `revoked_at` set. False
            when the user has never accepted (use `has_accept_row` to
            distinguish that case) or when consent is currently active.
        has_accept_row: True iff at least one row exists in
            `gpd_tos_acceptance` for this user. Lets the gate emit
            `consent_required` for never-accepted users vs.
            `consent_revoked` for users who actually withdrew.
        accepted_version: The `tos_version` string from the newest row,
            or None if no row exists. Free-form string per migration
            0001 — handler validates regex `^[A-Za-z0-9._-]{1,64}$` at
            insert time. Compared as a `packaging.version.Version` in
            the gate; un-parseable strings are treated as outdated.
    """

    revoked: bool
    has_accept_row: bool
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
        # No acceptance row at all — user has never accepted. Block at
        # the gate, but report as `consent_required` (first-time accept
        # needed) rather than `consent_revoked` (which implies the user
        # previously consented and then withdrew). The desktop client
        # branches on the code: required → re-show TOS modal with the
        # existing key intact; revoked → wipe both key + acceptedVersion
        # and bounce to the welcome screen.
        return ConsentState(revoked=False, has_accept_row=False, accepted_version=None)
    return ConsentState(
        revoked=bool(row["is_revoked"]),
        has_accept_row=True,
        accepted_version=row["tos_version"],
    )


# Backward-compat shim. Older callers may still call `is_revoked()` —
# keep it routing through the new ConsentState computation so behaviour
# stays consistent. Returns True for both never-accepted and
# revoked-after-accept (i.e. "must-block" states). Remove once all call
# sites are migrated.
async def is_revoked(user_id: str) -> bool:
    state = await compute_consent_state(user_id)
    return state.revoked or not state.has_accept_row
