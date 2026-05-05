"""Postgres writer for in-app feedback submissions.

Reuses the asyncpg pool opened by `gpd_tos.db` so we don't double the
per-worker connection count. Both packages target
`GPD_AUDIT_DATABASE_URL`; the pool is shared transparently.
"""
from __future__ import annotations

import logging
from typing import Optional

from gpd_tos import db as tos_db

logger = logging.getLogger("gpd_feedback.db")


async def insert_feedback(
    *,
    user_id: str,
    token_hash_suffix: str,
    category: str,
    message: str,
    app_version: Optional[str],
    user_agent: Optional[str],
    client_ip: Optional[str],
) -> str:
    """INSERT one row into gpd_feedback. Returns the freshly-assigned UUID
    so the handler can echo it back to the caller (lets us correlate a
    submission with a support thread without exposing user_id).

    `client_ip` is cast `::inet` server-side. Handler validates the address
    via Python `ipaddress` and passes None for unparseable values, so the
    INET cast should never raise here.
    """
    pool = await tos_db._get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO gpd_feedback (
              user_id, token_hash_suffix, category, message,
              app_version, user_agent, client_ip
            ) VALUES (
              $1, $2, $3, $4,
              $5, $6, $7::inet
            )
            RETURNING id
            """,
            user_id,
            token_hash_suffix,
            category,
            message,
            app_version,
            user_agent,
            client_ip,
        )
    return str(row["id"])
