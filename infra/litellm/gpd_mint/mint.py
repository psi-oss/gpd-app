"""Call LiteLLM /key/generate with the master key.

Uses LITELLM_MASTER_KEY from the environment — same secret the existing
operator script (`scripts/mint_key.sh`) and the bulk-CSV recipe in
docs/GPD_DISTRIBUTION.md use. The Slack handler enforces who can trigger
this; this module is the dumb minting transport.
"""
from __future__ import annotations

import os
import re

import httpx

# 2026-05-18: gpd-chat is the proxy-side access group sync'd with the
# 11-model picker set (GPD_MODEL_METADATA in packages/opencode/src/
# provider/gpd-models.ts). Pro variants gpt-5.5-pro / gpt-5.4-pro are
# explicitly NOT in gpd-chat.
_DEFAULT_ACCESS_GROUP = "gpd-chat"
_LITELLM_BASE = os.environ.get(
    "GPD_MINT_LITELLM_BASE", "https://litellm-production-46bb.up.railway.app"
)

# user_id is used in GCS paths (hashed with GPD_USER_HASH_PEPPER) and
# BigQuery rows. Keep it conservative — lowercase, hyphen-separated, no
# leading hyphen. Matches the regex enforced by scripts/mint_key.sh.
_USER_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_USER_ID_MAX_LEN = 80


class MintError(Exception):
    """LiteLLM rejected the mint request, or transport failed."""


def slugify_user_id(display_name: str) -> str:
    s = display_name.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")[:_USER_ID_MAX_LEN]
    if not s or not _USER_ID_RE.match(s):
        raise MintError(f"name does not slugify into a valid user_id: {display_name!r}")
    return s


async def mint(
    *,
    display_name: str,
    email: str,
    budget_usd: float,
    note: str | None,
    minted_by_slack_user: str,
    minted_by_slack_username: str | None,
) -> dict:
    """Returns the parsed LiteLLM response. Caller pulls out `key`."""
    master_key = os.environ.get("LITELLM_MASTER_KEY")
    if not master_key:
        raise MintError("LITELLM_MASTER_KEY not set in env")

    user_id = slugify_user_id(display_name)

    metadata: dict = {
        "minted_via": "slack",
        "minted_by_slack_user_id": minted_by_slack_user,
        "recipient_email": email,
    }
    if minted_by_slack_username:
        metadata["minted_by_slack_username"] = minted_by_slack_username
    if note:
        metadata["note"] = note

    payload = {
        "user_id": user_id,
        "key_alias": display_name.strip()[:80],
        "models": [_DEFAULT_ACCESS_GROUP],
        "max_budget": float(budget_usd),
        "metadata": metadata,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f"{_LITELLM_BASE}/key/generate",
            headers={"Authorization": f"Bearer {master_key}"},
            json=payload,
        )

    if r.status_code != 200:
        raise MintError(f"LiteLLM /key/generate returned {r.status_code}: {r.text[:500]}")

    body = r.json()
    if not body.get("key"):
        raise MintError(f"LiteLLM response missing `key` field: {body!r}")

    body["_user_id"] = user_id
    return body
