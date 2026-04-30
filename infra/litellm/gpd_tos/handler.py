"""POST /gpd/tos-accept — record a Terms-of-Service acceptance event.
POST /gpd/tos-revoke — user revokes consent; triggers pseudonymization.

Auth:   Authorization: Bearer <LiteLLM virtual key> (Depends handles)
Query (accept):
        ?tos_version=<version string>
        &tos_text_sha256=<64 hex chars, SHA-256 of the exact text rendered>
        &app_version=<desktop build, optional>
        &viewed_in_full=0|1 (default 0)
Headers captured server-side:
        User-Agent        → truncated to 512 chars
        X-Forwarded-For   → LAST hop taken as client IP (Railway appends
                            the real client IP to the end of any client-
                            supplied chain, so the first hop is attacker-
                            controlled and MUST NOT be trusted)
Out:    {"ok": true}

Writes one append-only row to `gpd_tos_acceptance` with:
  user_id             — from user_api_key_dict (server-derived, never
                        client-settable)
  token_hash_suffix   — first 16 chars of LiteLLM's SHA256 token hash
                        (not the raw sk-... the user typed; LiteLLM never
                        exposes that to us). 64 bits of cross-reference
                        entropy — collision-safe up to the billion-user
                        regime.
  tos_version         — client-submitted, length-checked
  tos_text_sha256     — SHA-256 hex of the exact text the user saw. CI
                        build guard (`.github/workflows/gpd-release.yml`
                        `tos-guard` job) ensures the client ships a
                        constant matching its rendered TOS_TEXT.
  viewed_in_full      — client-reported "did you scroll the TOS region
                        to its bottom?". Defence against Specht-v.-
                        Netscape "never saw it" arguments.
  app_version         — desktop build at acceptance time
  user_agent          — from the request, truncated
  client_ip           — X-Forwarded-For LAST hop, validated via Python
                        `ipaddress`; NULL if unparseable (rather than
                        503'ing the user over a weird XFF chain)
  accepted_at         — server UTC timestamp (clock skew-proof)
  revoked_at          — NULL at write; set by /gpd/tos-revoke

Invariants:
  1. Virtual key is valid & not revoked/expired (Depends user_api_key_auth).
  2. Admin / master keys (user_id empty) are rejected — they cannot collide
     into a single anonymous bucket.
  3. Table exists before the first request (startup hook awaits migrate).
"""
from __future__ import annotations

import ipaddress
import logging
import re

from fastapi import Depends, HTTPException, Request
from litellm.proxy._types import UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth

from . import db

_MAX_VERSION_LEN = 64
_MAX_APP_VERSION_LEN = 64
_MAX_USER_AGENT_LEN = 512
_HASH_HEX_RE = re.compile(r"^[0-9a-f]{64}$")
# Versions are source-code constants — restrict to a conservative alphabet
# so an attacker with a valid key can't inject control bytes into logs or
# downstream ops UIs.
_VERSION_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

logger = logging.getLogger("gpd_tos.handler")


def _extract_client_ip(request: Request) -> str | None:
    """Extract the real client IP.

    Railway's edge appends the real remote address to the END of any
    client-supplied X-Forwarded-For chain. Taking the FIRST hop was
    attacker-controlled; we take the LAST. If the entire chain is
    attacker-supplied (no Railway hop — shouldn't happen on prod), the
    last still lands on something the attacker chose, but with the caveat
    that the attack requires a valid LiteLLM virtual key to reach this
    code path in the first place.

    Validate via `ipaddress.ip_address()` so weird networks (IPv6 with
    zone IDs, port-suffixed IPs, malformed entries) don't 503 the user on
    accept — return None and log instead.
    """
    xff = request.headers.get("x-forwarded-for", "")
    candidate: str | None
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        candidate = parts[-1] if parts else None
    else:
        candidate = request.client.host if request.client else None

    if candidate is None:
        return None

    # Strip IPv6 zone id (e.g. "fe80::1%eth0" → "fe80::1"); Postgres INET
    # stores that fine without the zone, and the zone is meaningless off
    # the original host anyway.
    zone_ix = candidate.find("%")
    if zone_ix != -1:
        candidate = candidate[:zone_ix]

    # Trim port suffix on IPv4 literals: "1.2.3.4:5678" → "1.2.3.4".
    # Naive on IPv6 (which uses [::1]:port) but we handle that separately.
    if candidate.startswith("[") and "]" in candidate:
        candidate = candidate[1 : candidate.index("]")]
    elif candidate.count(":") == 1:
        # IPv4:port shape
        candidate = candidate.split(":", 1)[0]

    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        logger.warning("gpd_tos: unparseable client_ip candidate: %r", candidate)
        return None
    return candidate


async def gpd_tos_accept(
    request: Request,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
) -> dict:
    # Admin keys (no user_id) cannot record audit rows — they'd collide
    # into a single anonymous bucket. Operators who really want to
    # TOS-accept from a scripted context should mint a user-scoped key
    # first.
    user_id = user_api_key_dict.user_id
    if not user_id:
        raise HTTPException(
            401,
            detail="virtual key must carry a user_id (admin keys cannot record TOS acceptance)",
        )

    tos_version = (request.query_params.get("tos_version") or "").strip()
    if not tos_version:
        raise HTTPException(400, detail="tos_version query param required")
    if not _VERSION_RE.match(tos_version):
        raise HTTPException(400, detail="tos_version: invalid characters or length")

    tos_text_sha256 = (request.query_params.get("tos_text_sha256") or "").strip().lower()
    if not tos_text_sha256:
        raise HTTPException(400, detail="tos_text_sha256 query param required")
    if not _HASH_HEX_RE.match(tos_text_sha256):
        raise HTTPException(400, detail="tos_text_sha256 must be 64 lowercase hex chars")

    privacy_text_sha256 = (
        request.query_params.get("privacy_text_sha256") or ""
    ).strip().lower()
    if not privacy_text_sha256:
        raise HTTPException(400, detail="privacy_text_sha256 query param required")
    if not _HASH_HEX_RE.match(privacy_text_sha256):
        raise HTTPException(
            400, detail="privacy_text_sha256 must be 64 lowercase hex chars"
        )

    app_version = (request.query_params.get("app_version") or "").strip() or None
    if app_version and not _VERSION_RE.match(app_version):
        raise HTTPException(400, detail="app_version: invalid characters or length")

    viewed_in_full_raw = (request.query_params.get("viewed_in_full") or "").strip()
    viewed_in_full = viewed_in_full_raw in ("1", "true", "True")

    client_ip = _extract_client_ip(request)
    user_agent = (request.headers.get("user-agent") or "")[:_MAX_USER_AGENT_LEN] or None

    api_key_hash = user_api_key_dict.api_key or ""
    # First 16 chars of the hash. More than enough entropy to disambiguate
    # keys for cross-reference; far more than the 4 chars we shipped first.
    token_hash_suffix = api_key_hash[:16] if api_key_hash else ""

    try:
        await db.insert_acceptance(
            user_id=user_id,
            token_hash_suffix=token_hash_suffix,
            tos_version=tos_version,
            tos_text_sha256=tos_text_sha256,
            privacy_text_sha256=privacy_text_sha256,
            viewed_in_full=viewed_in_full,
            app_version=app_version,
            user_agent=user_agent,
            client_ip=client_ip,
        )
    except HTTPException:
        raise
    except Exception as e:
        # Log internally; return an opaque message externally to avoid
        # leaking DB / schema details to the client.
        logger.exception("gpd_tos.insert_acceptance failed: %s", e)
        raise HTTPException(503, detail="tos write failed") from None

    # Evict the consent-gate cache entry on THIS worker so a re-accept
    # under a fresher tos_version is reflected immediately instead of
    # waiting up to 300s for the TTL to expire. Without this, a TOS
    # bump → user re-accepts → next LLM call still sees the cached old
    # ConsentState and gets `tos_version_outdated` (or, conversely,
    # `consent_revoked` after revoke→accept until TTL expires). Other
    # workers still lag by ≤ TTL; swap the cache for Redis pub/sub if
    # legal needs cross-worker-immediate propagation. Local import to
    # keep gpd_tos independent of the consent package at module load.
    try:
        from gpd_consent import cache as consent_cache

        await consent_cache.invalidate(user_id)
    except Exception:
        logger.exception("gpd_consent cache invalidate failed (non-fatal)")

    return {"ok": True}


async def gpd_tos_revoke(
    request: Request,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
) -> dict:
    """Mark revoked_at on all existing acceptance rows for this user.

    Explicit withdrawal of consent (GDPR Art. 7(3) "as easy as given").
    Does NOT delete the row — legal audit value (Art. 17(3)(e)) requires
    retention of "I once agreed" even post-withdrawal. Full GDPR erasure
    (removing identifying fields) is a separate admin action via
    `scripts/delete-user.ts` → `/gpd/tos-erase` (or direct DB call);
    this endpoint is the user-facing "revoke" that stops further logging
    downstream by the caller.
    """
    user_id = user_api_key_dict.user_id
    if not user_id:
        raise HTTPException(401, detail="virtual key must carry a user_id")

    try:
        count = await db.mark_revoked(user_id=user_id)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("gpd_tos.mark_revoked failed: %s", e)
        raise HTTPException(503, detail="tos revoke failed") from None

    # Evict the consent-gate cache entry on THIS worker so the next LLM
    # request sees the revocation immediately instead of waiting up to
    # 300s for the TTL to expire. Other workers still lag by ≤ TTL; swap
    # the cache for Redis pub/sub if legal requires cross-worker-immediate
    # propagation. Local import to keep gpd_tos independent of the
    # consent package at module load.
    try:
        from gpd_consent import cache as consent_cache

        await consent_cache.invalidate(user_id)
    except Exception:
        logger.exception("gpd_consent cache invalidate failed (non-fatal)")

    return {"ok": True, "rows_revoked": count}
