"""Slack Block-Kit modal definitions.

The mint modal collects:
  - display_name   (used as user_id + key_alias; lowercased + slugified
                    server-side before sending to LiteLLM)
  - email          (recipient — included in onboarding template only;
                    NOT stored on the LiteLLM key row)
  - budget_usd     (defaults to 2000; integer dollars)
  - note           (optional context, stored in key metadata)
"""
from __future__ import annotations

CALLBACK_ID = "gpd_mint_submit"


def mint_modal() -> dict:
    return {
        "type": "modal",
        "callback_id": CALLBACK_ID,
        "title": {"type": "plain_text", "text": "Mint GPD key"},
        "submit": {"type": "plain_text", "text": "Mint"},
        "close": {"type": "plain_text", "text": "Cancel"},
        "blocks": [
            {
                "type": "input",
                "block_id": "display_name",
                "label": {"type": "plain_text", "text": "Recipient name"},
                "element": {
                    "type": "plain_text_input",
                    "action_id": "value",
                    "placeholder": {"type": "plain_text", "text": "e.g. Jane Doe"},
                    "max_length": 80,
                },
                "hint": {
                    "type": "plain_text",
                    "text": "Used as the key_alias. Slugified into the user_id.",
                },
            },
            {
                "type": "input",
                "block_id": "email",
                "label": {"type": "plain_text", "text": "Recipient email"},
                "element": {
                    "type": "plain_text_input",
                    "action_id": "value",
                    "placeholder": {"type": "plain_text", "text": "jane@example.edu"},
                    "max_length": 254,
                },
                "hint": {
                    "type": "plain_text",
                    "text": "For the onboarding email only — not stored on the LiteLLM key.",
                },
            },
            {
                "type": "input",
                "block_id": "budget_usd",
                "label": {"type": "plain_text", "text": "Lifetime budget (USD)"},
                "element": {
                    "type": "plain_text_input",
                    "action_id": "value",
                    "initial_value": "2000",
                    "max_length": 7,
                },
                "hint": {
                    "type": "plain_text",
                    "text": "Default $2000 (lifetime, no reset). Override only if needed.",
                },
            },
            {
                "type": "input",
                "block_id": "note",
                "optional": True,
                "label": {"type": "plain_text", "text": "Note (optional)"},
                "element": {
                    "type": "plain_text_input",
                    "action_id": "value",
                    "multiline": True,
                    "max_length": 500,
                    "placeholder": {
                        "type": "plain_text",
                        "text": "Why this key — investor, partner, conference, etc.",
                    },
                },
                "hint": {
                    "type": "plain_text",
                    "text": "Stored as metadata.note on the key row.",
                },
            },
        ],
    }
