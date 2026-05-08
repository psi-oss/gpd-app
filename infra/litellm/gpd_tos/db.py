"""Postgres writer for TOS acceptance rows (separate audit DB).

Uses asyncpg directly, pointed at `GPD_AUDIT_DATABASE_URL` — the dedicated
legal-audit database, isolated from LiteLLM's own Postgres so upstream
`prisma migrate` behavior can't drop acceptance rows. Schema is managed by
`gpd_tos.migrate.apply_migrations()` which runs from the startup hook.

Pool is lazily opened on first use, sized 1..4 since TOS traffic is one
row per user per version per device install. The pool only opens *after*
migrations have been applied (startup hook awaits migrate before serving
traffic), so `insert_acceptance` cannot race the first CREATE TABLE.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

import asyncpg

logger = logging.getLogger("gpd_tos.db")

_pool: Optional[asyncpg.Pool] = None
_lock = asyncio.Lock()


def _clean_url(url: str) -> str:
    """Strip Prisma `?schema=...` from the URL — asyncpg rejects unknown query
    params outright. Only known-inert params we'd want to preserve (e.g.,
    `sslmode`, `connect_timeout`) go through a libpq-style URL, not this
    Prisma-style URL; none are ever appended by Railway in practice."""
    return url.split("?", 1)[0] if "?" in url else url


def _audit_url() -> str:
    url = os.environ.get("GPD_AUDIT_DATABASE_URL")
    if url:
        return _clean_url(url)
    fallback = os.environ.get("DATABASE_URL")
    if fallback:
        logger.warning(
            "gpd_tos.db: GPD_AUDIT_DATABASE_URL unset; using DATABASE_URL "
            "(LiteLLM's own DB). NOT production-safe."
        )
        return _clean_url(fallback)
    raise RuntimeError("gpd_tos.db: no audit database URL configured")


async def _get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool
    async with _lock:
        if _pool is not None:
            return _pool
        _pool = await asyncpg.create_pool(_audit_url(), min_size=1, max_size=4)
        logger.info("gpd_tos.db: asyncpg pool connected")
        return _pool


async def close_pool() -> None:
    """Close and reset the module-global pool.

    Production keeps this pool for the worker lifetime. Tests create a fresh
    event loop per async test, so they must not reuse an asyncpg pool opened
    on a previous loop.
    """
    global _pool
    pool = _pool
    _pool = None
    if pool is not None:
        await pool.close()


async def insert_acceptance(
    *,
    user_id: str,
    token_hash_suffix: str,
    tos_version: str,
    tos_text_sha256: str,
    privacy_text_sha256: str,
    viewed_in_full: bool,
    app_version: Optional[str],
    user_agent: Optional[str],
    client_ip: Optional[str],
) -> None:
    """INSERT one row into gpd_tos_acceptance.

    client_ip is cast `::inet` on the server. The handler validates the
    address client-side (Python's `ipaddress` module) and passes None for
    unparseable values, so the INET cast should never raise here. If it
    does, the handler returns 503; prefer that to silent NULL.

    token_hash_suffix is expected to be the first 16 chars of the LiteLLM
    SHA256 token hash. 64 bits ≈ no collisions up to the billion-user
    regime.
    """
    pool = await _get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO gpd_tos_acceptance (
              user_id, token_hash_suffix, tos_version, tos_text_sha256,
              privacy_text_sha256, viewed_in_full, app_version,
              user_agent, client_ip
            ) VALUES (
              $1, $2, $3, $4,
              $5, $6, $7,
              $8, $9::inet
            )
            """,
            user_id,
            token_hash_suffix,
            tos_version,
            tos_text_sha256,
            privacy_text_sha256,
            viewed_in_full,
            app_version,
            user_agent,
            client_ip,
        )


async def mark_revoked(*, user_id: str) -> int:
    """Stamp revoked_at = now() on every non-revoked row for user_id.

    Returns the number of rows touched. Used by `/gpd/tos-revoke` so a user
    withdrawing consent leaves an explicit revocation mark, NOT a deletion
    (GDPR Art. 17(3)(e) allows retention for legal-claim defence)."""
    pool = await _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE gpd_tos_acceptance
               SET revoked_at = now()
             WHERE user_id = $1 AND revoked_at IS NULL
            """,
            user_id,
        )
        # asyncpg returns "UPDATE <n>"; split off the count.
        try:
            return int(result.rsplit(" ", 1)[-1])
        except ValueError:
            return 0


async def pseudonymize_user(*, user_id: str) -> int:
    """GDPR erasure: redact identifying fields but keep the audit trail.

    Drops client_ip + user_agent + token_hash_suffix; keeps user_id
    (already hashed by LiteLLM), tos_version, tos_text_sha256, viewed_in_full,
    accepted_at, revoked_at. Rationale: Art. 17(3)(e) explicitly permits
    retention of records needed for "establishment, exercise or defence
    of legal claims" — proof of consent falls squarely in that bucket.
    Stripping IP/UA/token_suffix leaves the minimal row that proves "a
    holder of user_id X consented to version Y at time Z" without
    retaining surveillance-grade fields."""
    pool = await _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE gpd_tos_acceptance
               SET client_ip = NULL,
                   user_agent = NULL,
                   token_hash_suffix = 'REDACTED'
             WHERE user_id = $1
            """,
            user_id,
        )
        try:
            return int(result.rsplit(" ", 1)[-1])
        except ValueError:
            return 0
