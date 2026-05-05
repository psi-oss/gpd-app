"""POST /gpd/feedback — record an in-app feedback submission.

Auth:   Authorization: Bearer <LiteLLM virtual key> (Depends handles).
Body:   JSON
        {
          "category":    "bug" | "feature" | "feedback",
          "message":     "<free text, 1..8000 chars>",
          "app_version": "<optional desktop build>"
        }
Out:    {"ok": true, "id": "<uuid>"}

Server-derived (never client-settable):
  user_id           — from user_api_key_dict
  token_hash_suffix — first 16 chars of LiteLLM's SHA256 token hash
  client_ip         — X-Forwarded-For LAST hop, validated via ipaddress
  user_agent        — request header, truncated to 512 chars

Admin / master keys (no user_id) are rejected with 401 — same policy as
`/gpd/tos-accept` so feedback is always tied to a real user.
"""
from __future__ import annotations

import ipaddress
import logging

from fastapi import Depends, HTTPException, Request
from litellm.proxy._types import UserAPIKeyAuth
from litellm.proxy.auth.user_api_key_auth import user_api_key_auth

from . import db

_VALID_CATEGORIES = {"bug", "feature", "feedback"}
_MAX_MESSAGE_LEN = 8000
_MAX_APP_VERSION_LEN = 64
_MAX_USER_AGENT_LEN = 512

logger = logging.getLogger("gpd_feedback.handler")


def _extract_client_ip(request: Request) -> str | None:
    """Take the LAST X-Forwarded-For hop (Railway's edge appends the real
    client). First hop is attacker-supplied. Return None for unparseable.
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

    zone_ix = candidate.find("%")
    if zone_ix != -1:
        candidate = candidate[:zone_ix]

    if candidate.startswith("[") and "]" in candidate:
        candidate = candidate[1 : candidate.index("]")]
    elif candidate.count(":") == 1:
        candidate = candidate.split(":", 1)[0]

    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return None
    return candidate


async def gpd_feedback(
    request: Request,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
) -> dict:
    user_id = user_api_key_dict.user_id
    if not user_id:
        raise HTTPException(
            401,
            detail="virtual key must carry a user_id (admin keys cannot submit feedback)",
        )

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, detail="body must be JSON")

    if not isinstance(body, dict):
        raise HTTPException(400, detail="body must be a JSON object")

    category = (body.get("category") or "").strip().lower()
    if category not in _VALID_CATEGORIES:
        raise HTTPException(
            400,
            detail=f"category must be one of {sorted(_VALID_CATEGORIES)}",
        )

    message = body.get("message")
    if not isinstance(message, str):
        raise HTTPException(400, detail="message must be a string")
    message = message.strip()
    if not message:
        raise HTTPException(400, detail="message must be non-empty")
    if len(message) > _MAX_MESSAGE_LEN:
        raise HTTPException(
            400,
            detail=f"message must be <= {_MAX_MESSAGE_LEN} chars",
        )

    app_version_raw = body.get("app_version")
    app_version: str | None = None
    if isinstance(app_version_raw, str):
        app_version = app_version_raw.strip()[:_MAX_APP_VERSION_LEN] or None

    user_agent = (request.headers.get("user-agent") or "")[:_MAX_USER_AGENT_LEN] or None
    client_ip = _extract_client_ip(request)

    api_key_hash = user_api_key_dict.api_key or ""
    token_hash_suffix = api_key_hash[:16] if api_key_hash else ""

    try:
        feedback_id = await db.insert_feedback(
            user_id=user_id,
            token_hash_suffix=token_hash_suffix,
            category=category,
            message=message,
            app_version=app_version,
            user_agent=user_agent,
            client_ip=client_ip,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("gpd_feedback.insert_feedback failed: %s", e)
        raise HTTPException(503, detail="feedback write failed") from None

    return {"ok": True, "id": feedback_id}
