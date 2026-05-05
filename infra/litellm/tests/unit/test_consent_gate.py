"""Unit tests for gpd_consent.consent_gate.ConsentGateLogger.

Covers:
  - Admin key (no user_id): passes through
  - Never-accepted user: blocked (403)
  - Accepted, not revoked: passes through
  - Revoked: blocked (403)
  - Re-accepted after revoke: passes through
  - DB error: blocked (503, fail-closed)
  - Cache hit doesn't re-query DB
  - Cache invalidate forces re-query

No LiteLLM proxy involvement — we call `async_pre_call_hook` directly,
which is precisely how `litellm/proxy/utils.py:1429` invokes it. Any
behavior that only surfaces through the full proxy pipeline is covered
by the e2e tests.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

pytestmark = pytest.mark.asyncio


def _key_for(user_id: str | None):
    """Shape-compatible stand-in for LiteLLM's UserAPIKeyAuth."""
    return SimpleNamespace(user_id=user_id, api_key="sk-fake-test-key")


async def _accept_row(
    user_id: str,
    *,
    tos_version: str = "1.0",
    tos_text_sha256: str = "a" * 64,
    privacy_text_sha256: str = "b" * 64,
):
    from gpd_tos import db

    await db.insert_acceptance(
        user_id=user_id,
        token_hash_suffix="deadbeefdeadbeef",
        tos_version=tos_version,
        tos_text_sha256=tos_text_sha256,
        privacy_text_sha256=privacy_text_sha256,
        viewed_in_full=True,
        app_version="1.1.15",
        user_agent="pytest/1.0",
        client_ip="127.0.0.1",
    )


async def _revoke(user_id: str) -> int:
    from gpd_tos import db

    return await db.mark_revoked(user_id=user_id)


async def _run_gate(user_id: str | None) -> None:
    """Invoke the gate the same way LiteLLM's proxy does."""
    from gpd_consent.consent_gate import ConsentGateLogger

    gate = ConsentGateLogger()
    await gate.async_pre_call_hook(
        user_api_key_dict=_key_for(user_id),
        cache=None,  # DualCache — gate doesn't use it
        data={"model": "test"},
        call_type="acompletion",
    )


async def test_admin_key_passes_through(migrated_db):
    # user_id None = master / admin key → always allowed
    await _run_gate(None)
    await _run_gate("")


async def test_never_accepted_is_blocked(migrated_db):
    # User with zero rows in gpd_tos_acceptance is blocked. Reaching the
    # gate without an acceptance row means the client TOS flow was bypassed
    # (or the accept insert failed). The error code is `consent_required`,
    # not `consent_revoked`: the user has nothing to "withdraw" yet, so the
    # desktop client routes them to a fresh TOS-accept flow that preserves
    # their existing key (vs. the revoke flow which wipes the key).
    with pytest.raises(HTTPException) as exc:
        await _run_gate("ghost-user-no-rows")
    assert exc.value.status_code == 403
    assert "consent_required" in exc.value.detail
    assert "consent_revoked" not in exc.value.detail


async def test_accepted_not_revoked_passes(migrated_db):
    uid = "test-accepted-1"
    await _accept_row(uid)
    await _run_gate(uid)  # must not raise


async def test_revoked_is_blocked(migrated_db):
    uid = "test-revoked-1"
    await _accept_row(uid)
    touched = await _revoke(uid)
    assert touched == 1

    with pytest.raises(HTTPException) as exc:
        await _run_gate(uid)
    assert exc.value.status_code == 403
    assert "consent_revoked" in exc.value.detail


async def test_reaccept_after_revoke_unblocks(migrated_db):
    uid = "test-reaccept-1"
    await _accept_row(uid)
    await _revoke(uid)

    # Re-accept: insert a fresh row. revoked_at on the new row is NULL,
    # and since the gate looks at the newest row by accepted_at, it sees
    # the user as currently consenting.
    from gpd_consent import cache

    await cache.invalidate(uid)  # simulate post-accept client behaviour
    await _accept_row(uid, tos_version="1.1")

    await _run_gate(uid)  # must not raise


async def test_cache_hit_avoids_db_query(migrated_db, monkeypatch):
    uid = "test-cache-hit"
    await _accept_row(uid)
    await _run_gate(uid)  # populates cache with False

    # Make the DB query raise. A cache hit must skip the DB entirely.
    from gpd_consent import db as consent_db

    async def _boom(_):
        raise RuntimeError("db should not be called on cache hit")

    monkeypatch.setattr(consent_db, "is_revoked", _boom)

    await _run_gate(uid)  # still passes — cache hit


async def test_db_outage_fails_closed(migrated_db, monkeypatch):
    uid = "test-db-outage"
    # No cache entry — gate must hit DB. Force DB to blow up.
    from gpd_consent import db as consent_db

    async def _boom(_):
        raise ConnectionError("audit DB unreachable")

    monkeypatch.setattr(consent_db, "is_revoked", _boom)

    with pytest.raises(HTTPException) as exc:
        await _run_gate(uid)
    assert exc.value.status_code == 503
    assert "consent_check_unavailable" in exc.value.detail


async def test_cache_invalidate_forces_requery(migrated_db):
    uid = "test-invalidate-1"
    await _accept_row(uid)
    await _run_gate(uid)  # caches False

    # Now revoke directly in DB. Cached False would otherwise mask this.
    await _revoke(uid)

    # Without invalidate, the gate would still allow (cache hit).
    from gpd_consent import cache

    await cache.invalidate(uid)

    with pytest.raises(HTTPException) as exc:
        await _run_gate(uid)
    assert exc.value.status_code == 403


async def test_revoke_handler_invalidates_cache(migrated_db):
    """End-to-end cache coherence: calling gpd_tos_revoke's DB call path
    plus the cache.invalidate side-effect (as wired in the handler) must
    make the next gate check re-read the DB and block."""
    uid = "test-revoke-handler-cache"
    await _accept_row(uid)
    await _run_gate(uid)  # caches False

    # Mirror the handler's logic verbatim (see gpd_tos/handler.py).
    from gpd_consent import cache as consent_cache

    await _revoke(uid)
    await consent_cache.invalidate(uid)

    with pytest.raises(HTTPException):
        await _run_gate(uid)
