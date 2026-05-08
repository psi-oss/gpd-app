from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import HTTPException

from gpd_billing.client import BillingClient, BillingConfig, BillingUnavailable
from gpd_billing.hook import GpdBillingLogger

pytestmark = pytest.mark.asyncio


class _FakeBillingClient:
    def __init__(self) -> None:
        self.reserves: list[dict[str, Any]] = []
        self.settles: list[tuple[str, dict[str, Any]]] = []
        self.refunds: list[tuple[str, dict[str, Any]]] = []
        self.reserve_error: Exception | None = None
        self.settle_error: Exception | None = None
        self.refund_error: Exception | None = None

    async def reserve(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.reserve_error:
            raise self.reserve_error
        self.reserves.append(payload)
        return {
            "reservation_id": "11111111-1111-1111-1111-111111111111",
            "reserved_micro_usd": 5000,
            "available_after_reserve_micro_usd": 95000,
            "expires_at": "2026-01-01T00:00:00Z",
        }

    async def settle(self, reservation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if self.settle_error:
            raise self.settle_error
        self.settles.append((reservation_id, payload))
        return {"reservation_id": reservation_id, "status": "settled"}

    async def refund(self, reservation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if self.refund_error:
            raise self.refund_error
        self.refunds.append((reservation_id, payload))
        return {"user_id": "user-1", "balance_micro_usd": 100000}


def _http_client_factory(handler):
    return lambda **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)


def _logger(*, enabled: bool = True, emergency_bypass: bool = False, client: _FakeBillingClient | None = None):
    fake = client or _FakeBillingClient()
    return (
        GpdBillingLogger(
            config=BillingConfig(
                enabled=enabled,
                base_url="https://billing.test",
                service_token="secret-test-token",
                emergency_bypass=emergency_bypass,
            ),
            client=fake,  # type: ignore[arg-type]
        ),
        fake,
    )


def _key(user_id: str | None = "user-1"):
    return SimpleNamespace(user_id=user_id, api_key="abcdef1234567890hashed-key")


async def test_disabled_hook_is_noop() -> None:
    hook, fake = _logger(enabled=False)
    data = {"model": "gpt-5.5"}

    result = await hook.async_pre_call_hook(_key(), None, data, "acompletion")

    assert result is None
    assert fake.reserves == []
    assert data == {"model": "gpt-5.5"}


async def test_pre_call_reserves_and_stamps_metadata() -> None:
    hook, fake = _logger()
    data = {
        "model": "gpt-5.5",
        "metadata": {"session_id": "ses_123", "app_version": "1.0.0"},
    }

    result = await hook.async_pre_call_hook(_key(), None, data, "acompletion")

    assert result is data
    assert fake.reserves == [
        {
            "user_id": "user-1",
            "key_hash_suffix": "abcdef1234567890",
            "model": "gpt-5.5",
            "call_type": "llm",
            "idempotency_key": "litellm-reserve:ses_123",
            "metadata": {
                "source": "litellm",
                "call_key": "ses_123",
                "litellm_call_type": "acompletion",
                "billing_call_type": "llm",
                "model": "gpt-5.5",
                "app_version": "1.0.0",
                "session_id": "ses_123",
            },
        }
    ]
    assert data["metadata"]["gpd_billing_reservation_id"] == "11111111-1111-1111-1111-111111111111"
    assert "secret-test-token" not in str(data)


async def test_pre_call_blocks_before_provider_on_insufficient_credits() -> None:
    hook, fake = _logger()
    fake.reserve_error = HTTPException(402, detail="billing_insufficient_credits: no credits")

    with pytest.raises(HTTPException) as exc:
        await hook.async_pre_call_hook(_key(), None, {"model": "gpt-5.5"}, "acompletion")

    assert exc.value.status_code == 402
    assert fake.reserves == []


async def test_pre_call_fails_closed_when_billing_unavailable() -> None:
    hook, fake = _logger()
    fake.reserve_error = BillingUnavailable("billing_timeout")

    with pytest.raises(HTTPException) as exc:
        await hook.async_pre_call_hook(_key(), None, {"model": "gpt-5.5"}, "acompletion")

    assert exc.value.status_code == 503
    assert "billing_unavailable" in exc.value.detail


async def test_emergency_bypass_allows_transport_failures() -> None:
    hook, fake = _logger(emergency_bypass=True)
    fake.reserve_error = BillingUnavailable("billing_timeout")
    data = {"model": "gpt-5.5"}

    result = await hook.async_pre_call_hook(_key(), None, data, "acompletion")

    assert result is data
    assert data["metadata"]["gpd_billing_bypassed"]


async def test_success_settles_from_litellm_cost_header() -> None:
    hook, fake = _logger()
    metadata = {
        "gpd_billing_reservation_id": "11111111-1111-1111-1111-111111111111",
        "gpd_billing_call_key": "call-1",
        "gpd_billing_model": "gpt-5.5",
        "gpd_billing_call_type": "llm",
    }

    await hook.async_log_success_event(
        {
            "litellm_call_id": "call-1",
            "model": "gpt-5.5",
            "litellm_params": {"metadata": metadata},
            "response_headers": {"x-litellm-response-cost": "0.0042"},
            "response_body": b'{"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}',
        },
        object(),
        None,
        None,
    )

    assert fake.settles == [
        (
            "11111111-1111-1111-1111-111111111111",
            {
                "provider_cost_micro_usd": 4200,
                "idempotency_key": "litellm-settle:call-1",
                "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8},
                "metadata": {
                    "source": "litellm",
                    "litellm_call_id": "call-1",
                    "model": "gpt-5.5",
                    "call_type": "llm",
                },
            },
        )
    ]


async def test_success_settlement_failure_does_not_hide_provider_success() -> None:
    hook, fake = _logger()
    fake.settle_error = RuntimeError("database down")

    await hook.async_log_success_event(
        {
            "litellm_params": {
                "metadata": {
                    "gpd_billing_reservation_id": "11111111-1111-1111-1111-111111111111",
                    "gpd_billing_call_key": "call-1",
                }
            },
            "response_headers": {"x-litellm-response-cost": "0.001"},
        },
        object(),
        None,
        None,
    )

    assert fake.settles == []


async def test_failure_refunds_reserved_credits() -> None:
    hook, fake = _logger()

    await hook.async_log_failure_event(
        {
            "litellm_params": {
                "metadata": {
                    "gpd_billing_reservation_id": "11111111-1111-1111-1111-111111111111",
                    "gpd_billing_call_key": "call-1",
                }
            }
        },
        object(),
        None,
        None,
    )

    assert fake.refunds == [
        (
            "11111111-1111-1111-1111-111111111111",
            {
                "reason": "provider_failure",
                "idempotency_key": "litellm-refund:call-1",
                "metadata": {"source": "litellm", "reason": "provider_failure"},
            },
        )
    ]


async def test_post_call_failure_refunds_from_request_data() -> None:
    hook, fake = _logger()

    await hook.async_post_call_failure_hook(
        {
            "metadata": {
                "gpd_billing_reservation_id": "11111111-1111-1111-1111-111111111111",
                "gpd_billing_call_key": "call-1",
            }
        },
        RuntimeError("provider failed"),
        _key(),
    )

    assert fake.refunds[0][1]["idempotency_key"] == "litellm-refund:call-1"


async def test_call_type_mapping_preserves_non_llm_classes() -> None:
    hook, fake = _logger()
    await hook.async_pre_call_hook(_key(), None, {"model": "arxiv"}, "call_mcp_tool")
    await hook.async_pre_call_hook(_key(), None, {"model": "claude"}, "anthropic_messages")

    assert fake.reserves[0]["call_type"] == "mcp"
    assert fake.reserves[1]["call_type"] == "pass_through"


async def test_admin_key_without_user_id_is_not_billed() -> None:
    hook, fake = _logger()

    result = await hook.async_pre_call_hook(_key(None), None, {"model": "gpt-5.5"}, "acompletion")

    assert result is None
    assert fake.reserves == []


async def test_register_installs_callback_once(monkeypatch: pytest.MonkeyPatch) -> None:
    import litellm
    from gpd_billing.hook import register

    monkeypatch.delenv("GPD_BILLING_ENABLED", raising=False)
    monkeypatch.delenv("GPD_BILLING_BASE_URL", raising=False)
    monkeypatch.delenv("GPD_BILLING_SERVICE_TOKEN", raising=False)
    litellm.logging_callback_manager._reset_all_callbacks()
    try:
        register()
        register()

        callbacks = [callback for callback in litellm.callbacks if isinstance(callback, GpdBillingLogger)]
        assert len(callbacks) == 1
        assert callbacks[0].config.enabled is False
    finally:
        litellm.logging_callback_manager._reset_all_callbacks()


async def test_client_maps_billing_402_to_payment_required() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"detail": "insufficient_balance"})

    client = BillingClient(
        BillingConfig(enabled=True, base_url="https://billing.test", service_token="token"),
        http_client_factory=_http_client_factory(handler),
    )

    with pytest.raises(HTTPException) as exc:
        await client.reserve({"user_id": "user-1"})

    assert exc.value.status_code == 402
    assert "insufficient_balance" in exc.value.detail


async def test_client_maps_transport_errors_to_unavailable() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out")

    client = BillingClient(
        BillingConfig(enabled=True, base_url="https://billing.test", service_token="token"),
        http_client_factory=_http_client_factory(handler),
    )

    with pytest.raises(BillingUnavailable) as exc:
        await client.reserve({"user_id": "user-1"})

    assert str(exc.value) == "billing_timeout"
