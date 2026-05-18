"""Audit-trail post to the GPD mint channel.

Posts a sanitized row (NO full key) so operators can see who minted
what for whom without the audit channel itself becoming a credential
store. Only last 4 chars of the key are included.
"""
from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger("gpd_mint.audit")


async def post(
    *,
    minted_by_slack_user_id: str,
    minted_by_slack_username: str | None,
    recipient_user_id: str,
    recipient_display_name: str,
    recipient_email: str,
    budget_usd: float,
    key_last4: str,
    note: str | None,
) -> None:
    """Best-effort. Audit-post failure does not block the mint reply."""
    channel = os.environ.get("GPD_MINT_AUDIT_CHANNEL")
    bot_token = os.environ.get("GPD_MINT_SLACK_BOT_TOKEN")
    if not channel or not bot_token:
        logger.warning("audit not configured (channel=%r); skipping", channel)
        return

    minted_by = (
        f"<@{minted_by_slack_user_id}>"
        if not minted_by_slack_username
        else f"<@{minted_by_slack_user_id}> ({minted_by_slack_username})"
    )

    lines = [
        f":key: *Key minted* by {minted_by}",
        f"• recipient: `{recipient_user_id}` ({recipient_display_name}, {recipient_email})",
        f"• budget:    ${budget_usd:,.0f} (lifetime, gpd-chat group)",
        f"• key:       `sk-...{key_last4}`",
    ]
    if note:
        lines.append(f"• note:      {note}")

    payload = {
        "channel": channel,
        "text": "\n".join(lines),
        "unfurl_links": False,
        "unfurl_media": False,
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                "https://slack.com/api/chat.postMessage",
                headers={
                    "Authorization": f"Bearer {bot_token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json=payload,
            )
        body = r.json()
        if not body.get("ok"):
            logger.error("audit post returned ok=false: %s", body.get("error"))
    except Exception as e:  # noqa: BLE001 — best-effort, never raise
        logger.exception("audit post failed: %s", e)
