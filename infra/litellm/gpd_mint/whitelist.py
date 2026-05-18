"""Env-driven allowlist of Slack user IDs permitted to mint keys.

GPD_MINT_AUTHORIZED_USERS is a comma-separated list of Slack member IDs
(starts with `U` for users, `W` for Enterprise Grid users). IDs are
opaque and unforgeable by the workspace member — Slack guarantees them
on every verified request.
"""
from __future__ import annotations

import os


def authorized_user_ids() -> frozenset[str]:
    raw = os.environ.get("GPD_MINT_AUTHORIZED_USERS", "")
    return frozenset(uid.strip() for uid in raw.split(",") if uid.strip())


def is_authorized(slack_user_id: str) -> bool:
    return slack_user_id in authorized_user_ids()
