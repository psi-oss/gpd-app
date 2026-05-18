"""POST /gpd/slack/mint — the one Slack endpoint.

Slack payload shapes that land here. Discriminator:
  * application/json, type=url_verification
        → Slack's event-subscription handshake. Echo `challenge`.
  * application/json, type=event_callback
        → Events API. Currently handles `message.im` (DM to bot) and
        `app_mention`. Reply with a "Mint a key" button so the user
        can launch the modal without typing the slash command.
  * application/x-www-form-urlencoded with `command=/mint-gpd-key`
        → slash command. Open the mint modal directly.
  * application/x-www-form-urlencoded with `payload=<json>`,
    payload.type == "block_actions"
        → Button click (e.g. the "Mint a key" button from the DM
        reply). Open the modal via views.open.
  * application/x-www-form-urlencoded with `payload=<json>`,
    payload.type == "view_submission"
        → Modal submitted. Background-mint the key, deliver via DM.

Slack requires a 200 response within 3 seconds of each request. The
mint itself can take >1s (LiteLLM `/key/generate` round-trip), so the
view_submission path ACKs the modal immediately and does the actual
mint work in a FastAPI BackgroundTask.

All paths verify the HMAC-SHA256 signature against
GPD_MINT_SLACK_SIGNING_SECRET before doing anything else.
"""
from __future__ import annotations

import json
import logging
import os
from urllib.parse import parse_qs

import httpx
from fastapi import BackgroundTasks, HTTPException, Request, Response

from . import audit, mint as mint_mod, signature, views, whitelist

logger = logging.getLogger("gpd_mint.handler")


_SLACK_API_BASE = "https://slack.com/api"
_MAX_BUDGET_USD = 50_000  # sanity ceiling; LiteLLM enforces the real cap
_MIN_BUDGET_USD = 1


async def gpd_slack_mint(
    request: Request,
    background_tasks: BackgroundTasks,
) -> Response:
    body = await request.body()

    # Verify signature first — every code path below trusts the signed body.
    signing_secret = os.environ.get("GPD_MINT_SLACK_SIGNING_SECRET", "")
    try:
        signature.verify(
            signing_secret=signing_secret,
            body=body,
            timestamp=request.headers.get("x-slack-request-timestamp", ""),
            signature=request.headers.get("x-slack-signature", ""),
        )
    except signature.SignatureError as e:
        logger.warning("signature verification failed: %s", e)
        raise HTTPException(401, detail="invalid Slack signature") from None

    content_type = request.headers.get("content-type", "")

    if content_type.startswith("application/json"):
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            raise HTTPException(400, detail="malformed json body") from None

        ptype = data.get("type")
        if ptype == "url_verification":
            return Response(
                content=data.get("challenge", ""),
                media_type="text/plain",
            )
        if ptype == "event_callback":
            # ACK fast, dispatch the actual reply in a background task.
            background_tasks.add_task(_handle_event, data.get("event") or {})
            return Response(status_code=200)
        raise HTTPException(400, detail=f"unsupported json payload type: {ptype}")

    # All slash + interactive payloads use form-encoding.
    form = parse_qs(body.decode("utf-8"))

    if "payload" in form:
        return await _handle_interactive(form["payload"][0], background_tasks)
    if form.get("command", [""])[0] == "/mint-gpd-key":
        return await _handle_slash(form)

    raise HTTPException(400, detail="unrecognized Slack payload")


# ─── slash command ───────────────────────────────────────────────────────

async def _handle_slash(form: dict) -> Response:
    user_id = form.get("user_id", [""])[0]
    trigger_id = form.get("trigger_id", [""])[0]

    if not whitelist.is_authorized(user_id):
        logger.warning("unauthorized /mint-gpd-key from user_id=%s", user_id)
        return _ephemeral(
            "You're not on the GPD mint allowlist. Ask Cameron if you should be."
        )

    if not trigger_id:
        return _ephemeral("Slack didn't provide a trigger_id (try again).")

    bot_token = os.environ.get("GPD_MINT_SLACK_BOT_TOKEN")
    if not bot_token:
        logger.error("GPD_MINT_SLACK_BOT_TOKEN not configured")
        return _ephemeral("Mint bot not configured. Ping Cameron.")

    # Open the modal. trigger_id is single-use and expires in 3 sec.
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                f"{_SLACK_API_BASE}/views.open",
                headers={
                    "Authorization": f"Bearer {bot_token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json={"trigger_id": trigger_id, "view": views.mint_modal()},
            )
        resp = r.json()
    except Exception as e:  # noqa: BLE001
        logger.exception("views.open transport failure: %s", e)
        return _ephemeral("Slack API unreachable. Try again.")

    if not resp.get("ok"):
        logger.error("views.open ok=false: %s", resp)
        return _ephemeral(f"Couldn't open form: `{resp.get('error', 'unknown')}`")

    # Slash command requires a 200 with empty (or ephemeral) body.
    return Response(status_code=200)


# ─── modal submission ────────────────────────────────────────────────────

async def _handle_interactive(
    payload_raw: str,
    background_tasks: BackgroundTasks,
) -> Response:
    try:
        payload = json.loads(payload_raw)
    except json.JSONDecodeError:
        raise HTTPException(400, detail="malformed interaction payload") from None

    ptype = payload.get("type")

    if ptype == "block_actions":
        return await _handle_block_actions(payload)

    if ptype != "view_submission":
        # Shortcuts, message actions, etc. — none defined yet. ACK 200.
        return Response(status_code=200)

    view = payload.get("view", {})
    if view.get("callback_id") != views.CALLBACK_ID:
        return Response(status_code=200)

    user = payload.get("user", {})
    slack_user_id = user.get("id", "")
    slack_username = user.get("username") or user.get("name")

    if not whitelist.is_authorized(slack_user_id):
        # Defense-in-depth: whitelist re-checked at submission. Returns an
        # error-style modal response so the modal stays open with the
        # message visible.
        logger.warning("unauthorized view_submission from user_id=%s", slack_user_id)
        return _json({
            "response_action": "errors",
            "errors": {
                "display_name": "You're not on the GPD mint allowlist.",
            },
        })

    state_values = view.get("state", {}).get("values", {})
    try:
        display_name = state_values["display_name"]["value"]["value"].strip()
        email = state_values["email"]["value"]["value"].strip()
        budget_raw = state_values["budget_usd"]["value"]["value"].strip()
        note_block = state_values.get("note", {}).get("value", {})
        note = (note_block.get("value") or "").strip() or None
    except (KeyError, AttributeError, TypeError):
        return _json({
            "response_action": "errors",
            "errors": {"display_name": "Form fields missing — please re-open."},
        })

    field_errors: dict[str, str] = {}
    if not display_name:
        field_errors["display_name"] = "Required."
    if "@" not in email or "." not in email.split("@", 1)[-1]:
        field_errors["email"] = "Must look like an email address."
    try:
        budget = float(budget_raw)
        if budget < _MIN_BUDGET_USD or budget > _MAX_BUDGET_USD:
            raise ValueError
    except ValueError:
        field_errors["budget_usd"] = f"Integer USD between {_MIN_BUDGET_USD} and {_MAX_BUDGET_USD}."
        budget = 0.0

    # Validate the slug shape eagerly so the user sees the error in the modal
    # rather than via ephemeral after submission.
    if "display_name" not in field_errors:
        try:
            mint_mod.slugify_user_id(display_name)
        except mint_mod.MintError as e:
            field_errors["display_name"] = str(e)

    if field_errors:
        return _json({"response_action": "errors", "errors": field_errors})

    # All checks passed — close the modal and do the mint in the background.
    background_tasks.add_task(
        _do_mint,
        display_name=display_name,
        email=email,
        budget=budget,
        note=note,
        slack_user_id=slack_user_id,
        slack_username=slack_username,
    )
    return _json({"response_action": "clear"})


async def _do_mint(
    *,
    display_name: str,
    email: str,
    budget: float,
    note: str | None,
    slack_user_id: str,
    slack_username: str | None,
) -> None:
    """Runs after the modal is closed. Posts the key to the operator
    via Slack DM (chat.postMessage to the operator's user_id channel)
    and audits the event to GPD_MINT_AUDIT_CHANNEL.
    """
    try:
        result = await mint_mod.mint(
            display_name=display_name,
            email=email,
            budget_usd=budget,
            note=note,
            minted_by_slack_user=slack_user_id,
            minted_by_slack_username=slack_username,
        )
    except mint_mod.MintError as e:
        logger.error("mint failed for %s: %s", display_name, e)
        await _post_message(slack_user_id, f":x: Mint failed for *{display_name}*: `{e}`")
        return

    sk = result["key"]
    user_id = result["_user_id"]
    last4 = sk[-4:]

    await _post_message(
        slack_user_id,
        f":white_check_mark: Key minted for *{display_name}* "
        f"(user_id `{user_id}`, ${budget:,.0f} lifetime).\n\n"
        f"`{sk}`",
    )

    await audit.post(
        minted_by_slack_user_id=slack_user_id,
        minted_by_slack_username=slack_username,
        recipient_user_id=user_id,
        recipient_display_name=display_name,
        recipient_email=email,
        budget_usd=budget,
        key_last4=last4,
        note=note,
    )


# ─── DM-the-bot flow (Events API → button → modal) ──────────────────────

_MINT_BUTTON_ACTION_ID = "gpd_mint_open_modal"


async def _handle_event(event: dict) -> None:
    """Background-task handler for Events API payloads.

    For both `message.im` (DM to the bot) and `app_mention`, reply with
    a "Mint a key" button so the user doesn't have to remember the
    slash command. Authorization check happens here so unauthorized
    Slack members can't even see the button.

    Filters out bot-originated messages to avoid an infinite loop (the
    bot's own reply would otherwise trigger another message.im event).
    """
    etype = event.get("type")
    if etype not in {"message", "app_mention"}:
        return

    # Ignore bot messages, message_changed/deleted subtypes, and threaded
    # bot replies. Slack sends message.im events for the bot's own posts
    # in DM channels — without this guard we'd loop.
    if event.get("bot_id") or event.get("subtype"):
        return

    slack_user_id = event.get("user", "")
    channel = event.get("channel", "")
    if not slack_user_id or not channel:
        return

    if not whitelist.is_authorized(slack_user_id):
        await _post_message(
            channel,
            "You're not on the GPD mint allowlist. Ask Cameron if you should be.",
        )
        logger.warning("unauthorized DM/mention from user_id=%s", slack_user_id)
        return

    blocks = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": "Tap below to mint a new GPD virtual key.",
            },
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "style": "primary",
                    "text": {"type": "plain_text", "text": "Mint a key"},
                    "action_id": _MINT_BUTTON_ACTION_ID,
                }
            ],
        },
    ]
    await _post_message(channel, "Tap below to mint a new GPD virtual key.", blocks=blocks)


async def _handle_block_actions(payload: dict) -> Response:
    """Open the mint modal in response to the 'Mint a key' button.

    block_actions payloads carry a trigger_id that's valid for ~3 sec —
    long enough to call views.open. Re-checks the whitelist defensively
    (the event handler already does, but block_actions could in
    principle arrive from a stale message).
    """
    user_id = payload.get("user", {}).get("id", "")
    trigger_id = payload.get("trigger_id", "")

    actions = payload.get("actions") or []
    action_id = actions[0].get("action_id") if actions else ""
    if action_id != _MINT_BUTTON_ACTION_ID:
        return Response(status_code=200)

    if not whitelist.is_authorized(user_id):
        logger.warning("block_actions from unauthorized user_id=%s", user_id)
        return Response(status_code=200)

    if not trigger_id:
        return Response(status_code=200)

    bot_token = os.environ.get("GPD_MINT_SLACK_BOT_TOKEN")
    if not bot_token:
        logger.error("GPD_MINT_SLACK_BOT_TOKEN not configured")
        return Response(status_code=200)

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                f"{_SLACK_API_BASE}/views.open",
                headers={
                    "Authorization": f"Bearer {bot_token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json={"trigger_id": trigger_id, "view": views.mint_modal()},
            )
        if not r.json().get("ok"):
            logger.error("views.open ok=false: %s", r.text)
    except Exception as e:  # noqa: BLE001
        logger.exception("views.open transport failed: %s", e)

    return Response(status_code=200)


async def _post_message(channel: str, text: str, blocks: list | None = None) -> None:
    """chat.postMessage helper. Best-effort; logs failures and returns."""
    bot_token = os.environ.get("GPD_MINT_SLACK_BOT_TOKEN")
    if not bot_token:
        logger.error("chat.postMessage skipped: bot token missing")
        return
    payload: dict = {
        "channel": channel,
        "text": text,
        "unfurl_links": False,
        "unfurl_media": False,
    }
    if blocks:
        payload["blocks"] = blocks
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{_SLACK_API_BASE}/chat.postMessage",
                headers={
                    "Authorization": f"Bearer {bot_token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json=payload,
            )
        if not r.json().get("ok"):
            logger.error("chat.postMessage ok=false: %s", r.text)
    except Exception as e:  # noqa: BLE001
        logger.exception("chat.postMessage transport failed: %s", e)


# ─── helpers ─────────────────────────────────────────────────────────────

def _ephemeral(text: str) -> Response:
    return _json({"response_type": "ephemeral", "text": text})


def _json(body: dict) -> Response:
    return Response(
        content=json.dumps(body),
        media_type="application/json",
    )


