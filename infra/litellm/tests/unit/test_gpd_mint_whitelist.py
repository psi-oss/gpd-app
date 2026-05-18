"""Authorized-user allowlist."""
from __future__ import annotations

import pytest

from gpd_mint import whitelist


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    monkeypatch.delenv("GPD_MINT_AUTHORIZED_USERS", raising=False)


def test_unset_env_means_no_one_authorized(monkeypatch) -> None:
    assert whitelist.authorized_user_ids() == frozenset()
    assert not whitelist.is_authorized("U123")


def test_single_user(monkeypatch) -> None:
    monkeypatch.setenv("GPD_MINT_AUTHORIZED_USERS", "U0ALEXWG")
    assert whitelist.is_authorized("U0ALEXWG")
    assert not whitelist.is_authorized("U0OTHER")


def test_multiple_users_with_whitespace(monkeypatch) -> None:
    monkeypatch.setenv("GPD_MINT_AUTHORIZED_USERS", " U1, U2 ,U3,  ,U4 ")
    ids = whitelist.authorized_user_ids()
    assert ids == frozenset({"U1", "U2", "U3", "U4"})
    for uid in ["U1", "U2", "U3", "U4"]:
        assert whitelist.is_authorized(uid)
    assert not whitelist.is_authorized("U5")


def test_empty_string_means_no_one(monkeypatch) -> None:
    monkeypatch.setenv("GPD_MINT_AUTHORIZED_USERS", "")
    assert whitelist.authorized_user_ids() == frozenset()


def test_only_commas_means_no_one(monkeypatch) -> None:
    monkeypatch.setenv("GPD_MINT_AUTHORIZED_USERS", ",,,")
    assert whitelist.authorized_user_ids() == frozenset()
