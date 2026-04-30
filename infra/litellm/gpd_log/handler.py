"""POST /gpd/log — write session log events to GCS on the user's behalf.

Auth:  Authorization: Bearer <LiteLLM virtual key> (Depends handles)
Input: gzipped NDJSON body (client-produced session events)
Query: ?session=<current session id>
       &root_session=<root of parent chain>   (defaults to session)
       &seq=<26-char ULID>                    (one per flush, monotonic)
Out:   {"ok": true, "path": "user=.../parts/<seq>.jsonl.gz", "bytes": N}

Invariants enforced here:
  1. Virtual key is valid & not revoked/expired (Depends user_api_key_auth).
  2. Per-key daily byte quota via Redis, fail-closed on Redis outage.
  3. User path prefix is derived from user_api_key_dict, never from the
     request body/query — protects against one user writing under another
     user's prefix.
  4. Content-Length required and ≤ 64MB — rejected before GCS call.
     (Cannot be enforced in middleware because FastAPI freezes the
     middleware stack before our worker-startup hook fires. With
     credentialed clients only, the residual risk is a caller using a
     valid key to force a ~64MB in-memory buffer per request. Acceptable
     at our scale; will harden to true streaming via parsed_body pre-seed
     if that becomes load-bearing.)
  5. LiteLLM's existing RPM/TPM limiter fires via pre_call_hook.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request
from litellm.proxy._types import UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth

from .gcs_writer import stream_to_gcs
from .quota import check_daily_bytes

MAX_BYTES = 64 * 1024 * 1024

# HMAC pepper for user_hash. Required — we refuse to start without it so an
# unpeppered deploy can never silently ship.
# Bare SHA256 of user_id gives only 64 bits of hiding; anyone with bucket-read
# access plus the LiteLLM users table can enumerate the (user_id → hash)
# mapping in seconds. HMAC with a pepper held only by LiteLLM makes that
# lookup intractable.
# Rotation = orphan all existing objects (old paths unreachable without old
# pepper). DON'T rotate unless you're prepared for that.
_PEPPER_HEX = os.environ.get("GPD_USER_HASH_PEPPER")
if not _PEPPER_HEX:
    raise RuntimeError(
        "GPD_USER_HASH_PEPPER env var required; generate with "
        "`python -c 'import secrets; print(secrets.token_hex(32))'`"
    )
_PEPPER = bytes.fromhex(_PEPPER_HEX)

# Blocklist of user_ids reserved for CI / smoke testing. These values
# must NEVER write to the production log bucket. Caller is expected to
# either use a real virtual-key user_id or hit a dedicated smoke-test
# endpoint that writes elsewhere. See `gpd-desktop-logs/user=236baedff028ad77/`
# for the historical pollution we're guarding against (LAUNCH-READINESS.md
# P0-4).
_BLOCKED_TEST_USER_IDS = frozenset({
    "smoke",
    "smoke-test",
    "ci",
    "ses_smoke_ci",
    "test",
    "default_user_id",
})

# Crockford base32 alphabet, as used by ULIDs.
_ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
# OpenCode session IDs are `ses_<ulid>`-shape; accept alphanumeric + `_-`.
_SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{3,128}$")


async def gpd_log(
    request: Request,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
) -> dict:
    # Content-Length gate. Required + ≤64 MB.
    cl_raw = request.headers.get("content-length")
    if cl_raw is None:
        raise HTTPException(411, detail="Content-Length header required")
    try:
        cl = int(cl_raw)
    except ValueError as e:
        raise HTTPException(400, detail="invalid Content-Length") from e
    if cl <= 0 or cl > MAX_BYTES:
        raise HTTPException(413, detail=f"Content-Length must be 1..{MAX_BYTES}")

    # Rate limit (reuses LiteLLM's existing RPM/TPM descriptors — keyed by
    # api_key/user/team/org, shared with /v1/chat/completions quotas).
    from litellm.proxy.proxy_server import proxy_logging_obj

    await proxy_logging_obj.pre_call_hook(
        user_api_key_dict=user_api_key_dict,
        data={"model": "gpd-log"},
        call_type="pass_through_endpoint",
    )

    await check_daily_bytes(user_api_key_dict.api_key, cl)

    # Validate query params.
    session_id = (request.query_params.get("session") or "").strip()
    root_session_id = (request.query_params.get("root_session") or session_id).strip()
    seq = (request.query_params.get("seq") or "").strip()

    if not _SESSION_RE.match(session_id):
        raise HTTPException(400, detail="invalid or missing 'session' query param")
    if not _SESSION_RE.match(root_session_id):
        raise HTTPException(400, detail="invalid 'root_session' query param")
    if not _ULID_RE.match(seq):
        raise HTTPException(400, detail="'seq' must be a 26-char ULID")

    # User prefix is derived server-side, NEVER from the request body/query.
    # Reject keys that carry no user_id — admin/master keys, misconfigured
    # keys. Without this check, every such caller would collide into a
    # single sha256("") bucket. Operators who really want to log from such
    # keys should assign the key a user_id first.
    user_id = user_api_key_dict.user_id
    if not user_id:
        raise HTTPException(
            401,
            detail="virtual key must carry a user_id (admin keys cannot write logs)",
        )

    # Reject reserved test/CI user_ids. We mistakenly shipped a smoke-CI
    # workflow that hit `/gpd/log` with `user_id=smoke` in the early
    # 2026-04-21 / 22 testing wave; the resulting rows are in the prod
    # bucket as gs://gpd-desktop-logs/user=236baedff028ad77/. Block the
    # known testing values at the source so the bucket only ever
    # contains real-user telemetry going forward. Smoke tests should hit
    # a dedicated test endpoint (or write to a quarantine bucket via a
    # separate route).
    if user_id in _BLOCKED_TEST_USER_IDS:
        raise HTTPException(
            403,
            detail=(
                "user_id is reserved for testing; mint a real virtual key "
                "or use the dedicated smoke-test endpoint."
            ),
        )

    user_hash = hmac.new(_PEPPER, user_id.encode("utf-8"), hashlib.sha256).hexdigest()[:16]

    # Build object path.
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if session_id == root_session_id:
        object_path = (
            f"user={user_hash}/date={date}/session={root_session_id}/"
            f"parts/{seq}.jsonl.gz"
        )
    else:
        object_path = (
            f"user={user_hash}/date={date}/session={root_session_id}/"
            f"subagents/agent-{session_id}/parts/{seq}.jsonl.gz"
        )

    # Read body (middleware already capped at 64MB). user_api_key_auth has
    # already drained the ASGI stream, so request.body() returns cached bytes.
    body = await request.body()

    try:
        written = await stream_to_gcs(object_path, body)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, detail=f"gcs write failed: {e}") from e

    return {"ok": True, "path": object_path, "bytes": written}
