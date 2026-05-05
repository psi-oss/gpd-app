"""CustomLogger subclass enforcing TOS consent on every LLM call.

Hooks into LiteLLM's proxy pre-call chain (`litellm.callbacks`). The proxy
invokes `async_pre_call_hook` once per request at
`litellm/proxy/common_request_processing.py:823` for every LLM API route
(completions, embeddings, moderation, speech, transcription, pass-through).
Raising HTTPException here rejects the request before it reaches the
provider — no tokens billed, no provider request made.

Admin keys (master key, no `user_id`) are skipped: they don't represent
end-users, so revocation doesn't apply. This matches how `/gpd/tos-accept`
rejects admin keys at handler level.

Two enforcement axes:

  1. Revocation. Any user with a `revoked_at IS NOT NULL` newest row is
     blocked with `consent_revoked` (403).

  2. Version floor. If `GPD_MIN_TOS_VERSION` env is set, the user's
     newest accept must be at or above that version per
     `packaging.version.Version` semantics. Default: unset → no floor,
     behaviour identical to pre-2026-04-30. When operators bump TOS,
     they set this env to the new required version; existing users at
     older versions get `tos_version_outdated` (403) and the desktop
     app's TosUpgradeGate re-prompts.

All 403/503 detail strings are stable, machine-parseable codes (prefix
before colon: `consent_required`, `consent_revoked`,
`tos_version_outdated`, `consent_check_unavailable`) so the desktop app
can switch on the code to pick a UX flow without parsing free-form
English. `consent_required` and `consent_revoked` are kept distinct
deliberately: the first means a brand-new user reached the gate without
a TOS row (re-show TOS, keep their key); the second means an existing
user revoked (wipe key + bounce to welcome).
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional, Union

from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger
from packaging.version import InvalidVersion, Version

from . import cache, db
from .db import ConsentState

logger = logging.getLogger("gpd_consent")


def _resolve_min_version() -> Optional[Version]:
    """Parse `GPD_MIN_TOS_VERSION` once at module load.

    Unset / empty → None → no floor enforced. Malformed → fail-CLOSED at
    the gate (treat every accept as outdated) by raising ImportError so
    the worker refuses to start. Better to surface the misconfiguration
    loudly than silently disable the floor.
    """
    raw = os.environ.get("GPD_MIN_TOS_VERSION", "").strip()
    if not raw:
        return None
    try:
        return Version(raw)
    except InvalidVersion as e:
        raise RuntimeError(
            f"GPD_MIN_TOS_VERSION={raw!r} is not a valid PEP 440 version. "
            "Refusing to start; either fix the value or unset the var."
        ) from e


_MIN_VERSION: Optional[Version] = _resolve_min_version()


def _accepted_meets_floor(state: ConsentState) -> bool:
    """True iff the user's newest accept is at-or-above the configured floor.

    Returns True when no floor is configured (default deployment).
    Returns False when the user has no accept row, when the version is
    un-parseable, or when it's strictly below the floor."""
    if _MIN_VERSION is None:
        return True
    if state.accepted_version is None:
        return False
    try:
        return Version(state.accepted_version) >= _MIN_VERSION
    except InvalidVersion:
        # accepted_version came out of the audit DB and was validated by
        # the handler regex `[A-Za-z0-9._-]{1,64}`, which is laxer than
        # PEP 440. Treat unparseable as outdated rather than crashing.
        return False


class ConsentGateLogger(CustomLogger):
    """Blocks requests that fail revocation OR version-floor checks."""

    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,  # DualCache — LiteLLM's own, unrelated to our TTL cache
        data: dict,
        call_type: str,
    ) -> Optional[Union[Exception, str, dict]]:
        user_id = getattr(user_api_key_dict, "user_id", None)
        if not user_id:
            # Master key / admin operations. No consent record applies.
            return None

        # Cache lookup first. 300s TTL per worker. On a revoke, the
        # /gpd/tos-revoke handler calls `cache.invalidate(user_id)` on
        # ITS worker; other workers lag by up to the TTL window.
        cached = await _cache_get(user_id)
        state = cached
        if state is None:
            # Cache miss — query the audit DB. Fail-closed on any error.
            try:
                state = await db.compute_consent_state(user_id)
            except Exception:
                # Do not log user_id at WARNING; it's a stable pseudonym
                # but still pseudonymous PII in proxy logs. Class only.
                logger.exception(
                    "gpd_consent: audit DB query failed; failing closed"
                )
                raise HTTPException(
                    status_code=503,
                    detail="consent_check_unavailable: audit system is unreachable.",
                )
            await _cache_set(user_id, state)

        if not state.has_accept_row:
            # First-time user reached the gate without an acceptance row.
            # Either the client TOS modal was bypassed or the accept
            # POST failed. Block, but tell the client which UX to show:
            # `consent_required` → keep the key, re-show TOS modal.
            raise HTTPException(
                status_code=403,
                detail="consent_required: please accept the Terms of "
                "Service in the desktop app to begin.",
            )

        if state.revoked:
            raise HTTPException(
                status_code=403,
                detail="consent_revoked: TOS consent withdrawn — "
                "re-accept via the desktop app to resume.",
            )

        if not _accepted_meets_floor(state):
            raise HTTPException(
                status_code=403,
                detail=(
                    "tos_version_outdated: please re-accept the latest "
                    "Terms of Service in the GPD desktop app to resume."
                ),
            )

        return None


# Thin wrappers to keep the `cache` parameter-shadowing in
# `async_pre_call_hook` from fighting `import cache`. LiteLLM's signature
# passes its own `DualCache` positional-or-keyword named `cache`; renaming
# it would break future upstream compat.
async def _cache_get(user_id: str) -> Optional[ConsentState]:
    return await cache.get(user_id)


async def _cache_set(user_id: str, state: ConsentState) -> None:
    await cache.set(user_id, state)
