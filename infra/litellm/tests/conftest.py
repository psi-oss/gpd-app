"""Shared pytest fixtures for infra/litellm server-side tests.

Strategy: boot a local Postgres via `testcontainers-python` per session,
point both `GPD_AUDIT_DATABASE_URL` and `DATABASE_URL` at it, apply the
gpd_tos migrations, and tear the container down at end. Per-test isolation
is by user_id, not schema — the migration apply is session-scoped because
reapplying DDL on every test would quadruple suite wall-time.

If testcontainers is unavailable (local machine without Docker), tests
skip rather than fail. CI provides Docker; nightly + PR.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Make the infra/litellm packages importable as top-level modules
# (gpd_tos, gpd_consent, gpd_log). Mirrors what Dockerfile does via
# PYTHONPATH=/app.
_LITELLM_ROOT = Path(__file__).resolve().parent.parent
if str(_LITELLM_ROOT) not in sys.path:
    sys.path.insert(0, str(_LITELLM_ROOT))


@pytest.fixture(scope="session")
def postgres_url() -> str:
    """Returns a `postgresql://...` URL pointing at a live Postgres.

    Prefers an env-provided URL (CI with a services: postgres block) over
    spinning up testcontainers. Skips the suite if neither is available.
    """
    env_url = os.environ.get("GPD_TEST_AUDIT_DATABASE_URL")
    if env_url:
        yield env_url
        return

    try:
        from testcontainers.postgres import PostgresContainer
    except ImportError:
        pytest.skip(
            "testcontainers not installed and GPD_TEST_AUDIT_DATABASE_URL unset; "
            "server-side tests skipped"
        )

    container = PostgresContainer("postgres:15-alpine")
    try:
        container.start()
    except Exception as e:
        pytest.skip(f"testcontainers could not start Postgres (is Docker running?): {e}")

    url = container.get_connection_url()
    # testcontainers returns `postgresql+psycopg2://...`; asyncpg expects
    # plain `postgresql://...`.
    if url.startswith("postgresql+psycopg2://"):
        url = "postgresql://" + url[len("postgresql+psycopg2://") :]

    try:
        yield url
    finally:
        container.stop()


@pytest.fixture(scope="session", autouse=True)
def _env_audit_url(postgres_url):
    """Wire the audit-DB env var so gpd_tos.db._get_pool() connects here."""
    prior = os.environ.get("GPD_AUDIT_DATABASE_URL")
    os.environ["GPD_AUDIT_DATABASE_URL"] = postgres_url
    yield
    if prior is None:
        os.environ.pop("GPD_AUDIT_DATABASE_URL", None)
    else:
        os.environ["GPD_AUDIT_DATABASE_URL"] = prior


@pytest.fixture(scope="session")
async def migrated_db(postgres_url):
    """Apply gpd_tos migrations against the session Postgres.

    Session-scoped so we pay the DDL cost once. Tests must isolate on
    user_id to avoid cross-test pollution of gpd_tos_acceptance rows.
    """
    from gpd_tos import migrate

    await migrate.apply_migrations()
    yield
    # No teardown — the session-scoped container is destroyed in
    # postgres_url fixture's finalizer.


@pytest.fixture(autouse=True)
async def _clear_consent_cache():
    """Each test gets a cold consent-gate cache so TTL state from the
    previous test can't leak."""
    from gpd_consent import cache

    await cache.clear()
    yield
    await cache.clear()
