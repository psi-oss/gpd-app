"""LiteLLM /key/generate transport."""
from __future__ import annotations

import json

import httpx
import pytest

from gpd_mint import mint as mint_mod


def test_slugify_basic() -> None:
    assert mint_mod.slugify_user_id("Jane Doe") == "jane-doe"
    assert mint_mod.slugify_user_id("  Jane  Doe  ") == "jane-doe"
    assert mint_mod.slugify_user_id("Ning Bao") == "ning-bao"
    assert mint_mod.slugify_user_id("AWG") == "awg"


def test_slugify_strips_special() -> None:
    assert mint_mod.slugify_user_id("Jane Q. O'Doe-Smith") == "jane-q-o-doe-smith"
    assert mint_mod.slugify_user_id("Dr. Sergio Hernández-Cuenca") == "dr-sergio-hern-ndez-cuenca"


def test_slugify_rejects_empty() -> None:
    with pytest.raises(mint_mod.MintError):
        mint_mod.slugify_user_id("")
    with pytest.raises(mint_mod.MintError):
        mint_mod.slugify_user_id("   ")
    with pytest.raises(mint_mod.MintError):
        mint_mod.slugify_user_id("!@#$%")


def test_slugify_collapses_to_valid_pattern() -> None:
    out = mint_mod.slugify_user_id("Jane")
    import re
    assert re.match(r"^[a-z0-9][a-z0-9-]*$", out)


@pytest.mark.asyncio
async def test_mint_happy_path(monkeypatch) -> None:
    monkeypatch.setenv("LITELLM_MASTER_KEY", "sk-test-master")

    captured: dict = {}

    async def fake_post(self, url, *, headers, json):  # noqa: A002 — match httpx kwarg
        captured["url"] = url
        captured["headers"] = headers
        captured["body"] = json
        return httpx.Response(
            200,
            content=b'{"key": "sk-newly-minted-abcd1234"}',
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    result = await mint_mod.mint(
        display_name="Jane Doe",
        email="jane@example.com",
        budget_usd=2000.0,
        note=None,
        minted_by_slack_user="U0MATT",
        minted_by_slack_username="matt",
    )

    assert result["key"] == "sk-newly-minted-abcd1234"
    assert result["_user_id"] == "jane-doe"

    # Master key forwarded as bearer
    assert captured["headers"]["Authorization"] == "Bearer sk-test-master"

    body = captured["body"]
    assert body["user_id"] == "jane-doe"
    assert body["key_alias"] == "Jane Doe"
    assert body["models"] == ["gpd-chat"]
    assert body["max_budget"] == 2000.0
    assert body["metadata"]["minted_via"] == "slack"
    assert body["metadata"]["minted_by_slack_user_id"] == "U0MATT"
    assert body["metadata"]["minted_by_slack_username"] == "matt"
    assert body["metadata"]["recipient_email"] == "jane@example.com"
    assert "budget_duration" not in body  # lifetime, no recurring


@pytest.mark.asyncio
async def test_mint_with_note(monkeypatch) -> None:
    monkeypatch.setenv("LITELLM_MASTER_KEY", "sk-test-master")
    captured: dict = {}

    async def fake_post(self, url, *, headers, json):  # noqa: A002
        captured["body"] = json
        return httpx.Response(200, content=b'{"key": "sk-x"}',
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    await mint_mod.mint(
        display_name="Jane",
        email="j@x.com",
        budget_usd=500,
        note="Investor demo at Sand Hill",
        minted_by_slack_user="U0M",
        minted_by_slack_username=None,
    )

    assert captured["body"]["metadata"]["note"] == "Investor demo at Sand Hill"
    assert "minted_by_slack_username" not in captured["body"]["metadata"]


@pytest.mark.asyncio
async def test_mint_raises_on_5xx(monkeypatch) -> None:
    monkeypatch.setenv("LITELLM_MASTER_KEY", "sk-test-master")

    async def fake_post(self, url, *, headers, json):  # noqa: A002
        return httpx.Response(500, content=b"upstream down",
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    with pytest.raises(mint_mod.MintError, match="500"):
        await mint_mod.mint(
            display_name="Jane",
            email="j@x.com",
            budget_usd=2000,
            note=None,
            minted_by_slack_user="U0",
            minted_by_slack_username=None,
        )


@pytest.mark.asyncio
async def test_mint_raises_when_key_missing_from_response(monkeypatch) -> None:
    monkeypatch.setenv("LITELLM_MASTER_KEY", "sk-test-master")

    async def fake_post(self, url, *, headers, json):  # noqa: A002
        return httpx.Response(200, content=b'{"oops": "no key here"}',
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    with pytest.raises(mint_mod.MintError, match="missing `key`"):
        await mint_mod.mint(
            display_name="Jane",
            email="j@x.com",
            budget_usd=2000,
            note=None,
            minted_by_slack_user="U0",
            minted_by_slack_username=None,
        )


@pytest.mark.asyncio
async def test_mint_raises_when_master_key_missing(monkeypatch) -> None:
    monkeypatch.delenv("LITELLM_MASTER_KEY", raising=False)
    with pytest.raises(mint_mod.MintError, match="LITELLM_MASTER_KEY"):
        await mint_mod.mint(
            display_name="Jane",
            email="j@x.com",
            budget_usd=2000,
            note=None,
            minted_by_slack_user="U0",
            minted_by_slack_username=None,
        )
