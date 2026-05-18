"""Events API + block-actions: DM-the-bot flow tests."""
from __future__ import annotations

import json

import httpx
import pytest

from gpd_mint import handler


@pytest.fixture(autouse=True)
def _bot_token_env(monkeypatch):
    monkeypatch.setenv("GPD_MINT_SLACK_BOT_TOKEN", "xoxb-test-bot-token")


@pytest.fixture
def _auth_user(monkeypatch):
    monkeypatch.setenv("GPD_MINT_AUTHORIZED_USERS", "U0AUTH")
    return "U0AUTH"


@pytest.fixture
def _capture_slack_posts(monkeypatch):
    """Stub out httpx.AsyncClient.post and capture every call so we can
    assert what Slack would have seen."""
    calls: list[dict] = []

    async def fake_post(self, url, *, headers, json):  # noqa: A002
        calls.append({"url": url, "headers": headers, "body": json})
        return httpx.Response(
            200,
            content=b'{"ok": true}',
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return calls


# ─── Events API: message.im / app_mention ────────────────────────────────


@pytest.mark.asyncio
async def test_dm_to_bot_from_authorized_user_replies_with_button(
    _auth_user, _capture_slack_posts
):
    await handler._handle_event(
        {
            "type": "message",
            "user": _auth_user,
            "channel": "D0DM",
            "text": "hey",
        }
    )

    assert len(_capture_slack_posts) == 1
    call = _capture_slack_posts[0]
    assert call["url"].endswith("/chat.postMessage")
    assert call["body"]["channel"] == "D0DM"
    actions = next(b for b in call["body"]["blocks"] if b["type"] == "actions")
    assert actions["elements"][0]["action_id"] == handler._MINT_BUTTON_ACTION_ID


@pytest.mark.asyncio
async def test_app_mention_from_authorized_user_replies_with_button(
    _auth_user, _capture_slack_posts
):
    await handler._handle_event(
        {
            "type": "app_mention",
            "user": _auth_user,
            "channel": "C0CHAN",
            "text": "<@U0BOT> mint",
        }
    )

    assert len(_capture_slack_posts) == 1
    assert _capture_slack_posts[0]["body"]["channel"] == "C0CHAN"


@pytest.mark.asyncio
async def test_dm_from_unauthorized_user_gets_denial(monkeypatch, _capture_slack_posts):
    monkeypatch.setenv("GPD_MINT_AUTHORIZED_USERS", "U0AUTH")
    await handler._handle_event(
        {
            "type": "message",
            "user": "U0RANDO",
            "channel": "D0DM",
            "text": "let me in",
        }
    )

    assert len(_capture_slack_posts) == 1
    body = _capture_slack_posts[0]["body"]
    assert "not on the GPD mint allowlist" in body["text"]
    assert "blocks" not in body  # no button for unauthorized


@pytest.mark.asyncio
async def test_bot_originated_message_is_ignored(_auth_user, _capture_slack_posts):
    """The bot's own DM replies trigger message.im events. Must not loop."""
    await handler._handle_event(
        {
            "type": "message",
            "user": "U0BOT",
            "channel": "D0DM",
            "text": "Tap below to mint",
            "bot_id": "B0SELF",
        }
    )
    assert _capture_slack_posts == []


@pytest.mark.asyncio
async def test_message_subtypes_are_ignored(_auth_user, _capture_slack_posts):
    """message_changed / message_deleted etc. shouldn't trigger replies."""
    for subtype in ("message_changed", "message_deleted", "channel_join"):
        await handler._handle_event(
            {
                "type": "message",
                "user": _auth_user,
                "channel": "D0DM",
                "subtype": subtype,
            }
        )
    assert _capture_slack_posts == []


@pytest.mark.asyncio
async def test_event_with_missing_user_or_channel_is_dropped(
    _auth_user, _capture_slack_posts
):
    await handler._handle_event(
        {"type": "message", "channel": "D0DM"}  # no user
    )
    await handler._handle_event(
        {"type": "message", "user": _auth_user}  # no channel
    )
    assert _capture_slack_posts == []


@pytest.mark.asyncio
async def test_unrelated_event_types_are_ignored(_auth_user, _capture_slack_posts):
    """Reaction-added, file-shared, etc. shouldn't trigger anything."""
    await handler._handle_event(
        {
            "type": "reaction_added",
            "user": _auth_user,
            "item": {"channel": "D0DM"},
        }
    )
    assert _capture_slack_posts == []


# ─── block_actions: button click → views.open ────────────────────────────


@pytest.mark.asyncio
async def test_button_click_opens_modal(_auth_user, _capture_slack_posts):
    response = await handler._handle_block_actions(
        {
            "type": "block_actions",
            "user": {"id": _auth_user},
            "trigger_id": "trigger-abc",
            "actions": [{"action_id": handler._MINT_BUTTON_ACTION_ID}],
        }
    )
    assert response.status_code == 200

    assert len(_capture_slack_posts) == 1
    call = _capture_slack_posts[0]
    assert call["url"].endswith("/views.open")
    assert call["body"]["trigger_id"] == "trigger-abc"
    assert call["body"]["view"]["callback_id"] == "gpd_mint_submit"


@pytest.mark.asyncio
async def test_button_click_from_unauthorized_user_does_nothing(
    monkeypatch, _capture_slack_posts
):
    monkeypatch.setenv("GPD_MINT_AUTHORIZED_USERS", "U0AUTH")
    response = await handler._handle_block_actions(
        {
            "type": "block_actions",
            "user": {"id": "U0RANDO"},
            "trigger_id": "trigger-abc",
            "actions": [{"action_id": handler._MINT_BUTTON_ACTION_ID}],
        }
    )
    assert response.status_code == 200
    assert _capture_slack_posts == []


@pytest.mark.asyncio
async def test_button_click_with_wrong_action_id_is_ignored(
    _auth_user, _capture_slack_posts
):
    response = await handler._handle_block_actions(
        {
            "type": "block_actions",
            "user": {"id": _auth_user},
            "trigger_id": "trigger-abc",
            "actions": [{"action_id": "some_other_button"}],
        }
    )
    assert response.status_code == 200
    assert _capture_slack_posts == []


@pytest.mark.asyncio
async def test_button_click_missing_trigger_id_is_dropped(
    _auth_user, _capture_slack_posts
):
    response = await handler._handle_block_actions(
        {
            "type": "block_actions",
            "user": {"id": _auth_user},
            "actions": [{"action_id": handler._MINT_BUTTON_ACTION_ID}],
        }
    )
    assert response.status_code == 200
    assert _capture_slack_posts == []
