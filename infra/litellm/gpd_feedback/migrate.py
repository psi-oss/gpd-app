"""Plain-SQL migrations runner for gpd_feedback.

Mirror of `gpd_tos.migrate` — same `schema_migrations` table in the same
audit DB, lexicographic ordering, single connection per file.

Filenames must be globally unique across packages because every runner
shares one `schema_migrations` table. gpd_feedback prefixes its files
with `feedback_` to avoid colliding with gpd_tos's `0001_init.sql`.
"""
from __future__ import annotations

import logging
import os
from importlib.resources import files
from pathlib import Path
from typing import List, Tuple

import asyncpg

logger = logging.getLogger("gpd_feedback.migrate")


def _clean_url(url: str) -> str:
    return url.split("?", 1)[0] if "?" in url else url


def _audit_url() -> str:
    url = os.environ.get("GPD_AUDIT_DATABASE_URL")
    if url:
        return _clean_url(url)
    fallback = os.environ.get("DATABASE_URL")
    if fallback:
        logger.warning(
            "gpd_feedback.migrate: GPD_AUDIT_DATABASE_URL unset; falling "
            "back to DATABASE_URL (LiteLLM's own DB). NOT production-safe."
        )
        return _clean_url(fallback)
    raise RuntimeError(
        "gpd_feedback.migrate: neither GPD_AUDIT_DATABASE_URL nor "
        "DATABASE_URL set"
    )


def _list_migrations() -> List[Tuple[str, str]]:
    root = files(__package__).joinpath("migrations")
    migs: List[Tuple[str, str]] = []
    for entry in sorted(Path(str(root)).iterdir()):
        if entry.suffix != ".sql":
            continue
        migs.append((entry.name, entry.read_text(encoding="utf-8")))
    if not migs:
        raise RuntimeError(
            "gpd_feedback.migrate: no .sql files found — image build "
            "missing a Dockerfile COPY?"
        )
    return migs


async def apply_migrations() -> None:
    """Apply any pending migrations. Called once per worker startup."""
    conn = await asyncpg.connect(_audit_url())
    try:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              name       TEXT PRIMARY KEY,
              applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        applied = {
            r["name"]
            for r in await conn.fetch("SELECT name FROM schema_migrations")
        }
        for name, sql in _list_migrations():
            if name in applied:
                continue
            logger.info("gpd_feedback.migrate: applying %s", name)
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO schema_migrations (name) VALUES ($1)", name
                )
            logger.info("gpd_feedback.migrate: ok %s", name)
    finally:
        await conn.close()
