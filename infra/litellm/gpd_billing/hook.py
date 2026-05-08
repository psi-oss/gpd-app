"""LiteLLM worker-startup hook: prepaid-credit reservation/settlement.

This is intentionally a thin adapter around the private GPD billing service.
The private service owns pricing, Stripe, account state, and idempotency. The
public LiteLLM image only enforces the reserve/settle/refund flow.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

from .client import (
    BillingClient,
    BillingConfig,
    BillingUnavailable,
    extract_litellm_cost_micro_usd,
    extract_usage,
    idempotency_key,
)

logger = logging.getLogger("gpd_billing")

_META_RESERVATION_ID = "gpd_billing_reservation_id"
_META_CALL_KEY = "gpd_billing_call_key"
_META_MODEL = "gpd_billing_model"
_META_CALL_TYPE = "gpd_billing_call_type"
_META_RESERVED_MICRO_USD = "gpd_billing_reserved_micro_usd"

_MCP_CALL_TYPES = {"call_mcp_tool", "list_mcp_tools"}
_PASS_THROUGH_CALL_TYPES = {
    "pass_through_endpoint",
    "anthropic_messages",
    "generate_content",
    "agenerate_content",
    "generate_content_stream",
    "agenerate_content_stream",
}


class GpdBillingLogger(CustomLogger):
    def __init__(
        self,
        *,
        config: BillingConfig | None = None,
        client: BillingClient | None = None,
    ) -> None:
        self.config = config or BillingConfig.from_env()
        self.client = client or BillingClient(self.config)

    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict,
        call_type: str,
    ) -> dict | None:
        if not self.config.enabled:
            return None

        user_id = getattr(user_api_key_dict, "user_id", None)
        if not user_id:
            # Master/admin keys do not map to a customer ledger. Admin/API-key
            # management routes are not billable request traffic.
            return None

        metadata = _metadata(data)
        model = _model_name(data)
        billing_call_type = _billing_call_type(call_type)
        call_key = _call_key(data, metadata)
        key_hash_suffix = _key_hash_suffix(getattr(user_api_key_dict, "api_key", None))
        reserve_payload = {
            "user_id": user_id,
            "key_hash_suffix": key_hash_suffix,
            "model": model,
            "call_type": billing_call_type,
            "idempotency_key": idempotency_key("litellm-reserve", call_key),
            "metadata": _base_metadata(data, metadata, call_type, billing_call_type, call_key),
        }

        try:
            reservation = await self.client.reserve(reserve_payload)
        except HTTPException:
            raise
        except BillingUnavailable as exc:
            if self.config.emergency_bypass:
                logger.error("gpd_billing: reserve bypassed because %s", exc)
                metadata["gpd_billing_bypassed"] = str(exc)
                return data
            raise HTTPException(
                status_code=503,
                detail=f"billing_unavailable: {exc}",
            ) from None

        reservation_id = reservation.get("reservation_id")
        if not reservation_id:
            if self.config.emergency_bypass:
                logger.error("gpd_billing: reserve returned no reservation_id; bypassing")
                metadata["gpd_billing_bypassed"] = "missing_reservation_id"
                return data
            raise HTTPException(
                status_code=503,
                detail="billing_unavailable: missing reservation_id",
            )

        metadata[_META_RESERVATION_ID] = str(reservation_id)
        metadata[_META_CALL_KEY] = call_key
        metadata[_META_MODEL] = model
        metadata[_META_CALL_TYPE] = billing_call_type
        if reservation.get("reserved_micro_usd") is not None:
            metadata[_META_RESERVED_MICRO_USD] = str(reservation["reserved_micro_usd"])
        return data

    async def async_log_success_event(
        self,
        kwargs: dict[str, Any],
        response_obj: object,
        start_time: object,
        end_time: object,
    ) -> None:
        if not self.config.enabled:
            return
        metadata = _kwargs_metadata(kwargs)
        reservation_id = metadata.get(_META_RESERVATION_ID)
        if not reservation_id:
            return

        provider_cost_micro_usd = extract_litellm_cost_micro_usd(kwargs, response_obj)
        if provider_cost_micro_usd is None:
            provider_cost_micro_usd = 0
            logger.error(
                "gpd_billing: missing LiteLLM response cost for reservation %s; settling provider cost as 0",
                reservation_id,
            )

        payload = {
            "provider_cost_micro_usd": provider_cost_micro_usd,
            "idempotency_key": idempotency_key(
                "litellm-settle",
                metadata.get(_META_CALL_KEY) or kwargs.get("litellm_call_id") or reservation_id,
            ),
            "usage": extract_usage(kwargs, response_obj),
            "metadata": _settlement_metadata(kwargs, metadata),
        }

        try:
            await self.client.settle(str(reservation_id), payload)
        except Exception:
            # Provider already succeeded. Do not hide a successful answer from
            # the user; the reservation remains pending for reconciliation.
            logger.exception("gpd_billing: settlement failed for reservation %s", reservation_id)

    async def async_log_failure_event(
        self,
        kwargs: dict[str, Any],
        response_obj: object,
        start_time: object,
        end_time: object,
    ) -> None:
        if not self.config.enabled:
            return
        await self._refund_from_metadata(_kwargs_metadata(kwargs), reason="provider_failure")

    async def async_post_call_failure_hook(
        self,
        request_data: dict,
        original_exception: Exception,
        user_api_key_dict: Any,
        traceback_str: str | None = None,
    ) -> None:
        if not self.config.enabled:
            return None
        await self._refund_from_metadata(_metadata(request_data), reason="provider_failure")
        return None

    async def _refund_from_metadata(self, metadata: dict[str, Any], *, reason: str) -> None:
        reservation_id = metadata.get(_META_RESERVATION_ID)
        if not reservation_id:
            return
        payload = {
            "reason": reason,
            "idempotency_key": idempotency_key(
                "litellm-refund",
                metadata.get(_META_CALL_KEY) or reservation_id,
            ),
            "metadata": {"source": "litellm", "reason": reason},
        }
        try:
            await self.client.refund(str(reservation_id), payload)
        except Exception:
            logger.exception("gpd_billing: refund failed for reservation %s", reservation_id)


def register() -> None:
    import litellm

    for existing in litellm.callbacks:
        if isinstance(existing, GpdBillingLogger):
            logger.info("gpd_billing: already registered; skipping")
            return

    billing = GpdBillingLogger()
    litellm.logging_callback_manager.add_litellm_callback(billing)
    logger.info(
        "gpd_billing: registered GpdBillingLogger enabled=%s emergency_bypass=%s",
        billing.config.enabled,
        billing.config.emergency_bypass,
    )


def _metadata(data: dict[str, Any]) -> dict[str, Any]:
    raw = data.get("metadata")
    if isinstance(raw, dict):
        return raw
    metadata: dict[str, Any] = {}
    data["metadata"] = metadata
    return metadata


def _kwargs_metadata(kwargs: dict[str, Any]) -> dict[str, Any]:
    params = kwargs.get("litellm_params") or {}
    if isinstance(params, dict):
        raw = params.get("metadata")
        if isinstance(raw, dict):
            return raw
    raw = kwargs.get("metadata")
    return raw if isinstance(raw, dict) else {}


def _model_name(data: dict[str, Any]) -> str:
    model = data.get("model") or data.get("model_id") or "unknown"
    return str(model)[:200]


def _billing_call_type(call_type: str) -> str:
    if call_type in _MCP_CALL_TYPES:
        return "mcp"
    if call_type in _PASS_THROUGH_CALL_TYPES:
        return "pass_through"
    return "llm"


def _call_key(data: dict[str, Any], metadata: dict[str, Any]) -> str:
    for value in (
        data.get("litellm_call_id"),
        data.get("request_id"),
        metadata.get("litellm_call_id"),
        metadata.get("request_id"),
        metadata.get("session_id"),
    ):
        if value:
            return str(value)
    return str(uuid.uuid4())


def _key_hash_suffix(api_key_hash: object) -> str | None:
    value = str(api_key_hash or "")
    return value[:16] if value else None


def _base_metadata(
    data: dict[str, Any],
    metadata: dict[str, Any],
    call_type: str,
    billing_call_type: str,
    call_key: str,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "source": "litellm",
        "call_key": call_key,
        "litellm_call_type": call_type,
        "billing_call_type": billing_call_type,
        "model": _model_name(data),
    }
    for key in ("app_version", "session_id", "root_session", "agent", "project_id"):
        value = metadata.get(key) or data.get(key)
        if value is not None:
            result[key] = str(value)[:500]
    return result


def _settlement_metadata(kwargs: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "source": "litellm",
        "litellm_call_id": str(kwargs.get("litellm_call_id") or metadata.get(_META_CALL_KEY) or ""),
        "model": str(kwargs.get("model") or metadata.get(_META_MODEL) or "unknown")[:200],
        "call_type": str(metadata.get(_META_CALL_TYPE) or "")[:64],
    }
    if metadata.get(_META_RESERVED_MICRO_USD) is not None:
        result["reserved_micro_usd"] = str(metadata[_META_RESERVED_MICRO_USD])
    return result

