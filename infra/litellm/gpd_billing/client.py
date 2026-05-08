"""Async client for the private GPD billing authority.

This module intentionally contains no pricing rules and no Stripe logic. The
public LiteLLM image only knows how to reserve, settle, and refund against the
private billing service.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Callable

import httpx
from fastapi import HTTPException

MICRO_USD_PER_USD = Decimal("1000000")

_ENABLED_ENV = "GPD_BILLING_ENABLED"
_BASE_URL_ENV = "GPD_BILLING_BASE_URL"
_TOKEN_ENV = "GPD_BILLING_SERVICE_TOKEN"
_TIMEOUT_ENV = "GPD_BILLING_TIMEOUT_SECONDS"
_BYPASS_ENV = "GPD_BILLING_EMERGENCY_BYPASS"
_DEFAULT_TIMEOUT_SECONDS = 5.0
_MAX_IDEMPOTENCY_KEY_LEN = 200


HttpClientFactory = Callable[..., httpx.AsyncClient]


@dataclass(frozen=True)
class BillingConfig:
    enabled: bool
    base_url: str | None
    service_token: str | None
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS
    emergency_bypass: bool = False

    @classmethod
    def from_env(cls) -> "BillingConfig":
        enabled = _truthy(os.environ.get(_ENABLED_ENV))
        timeout_seconds = _DEFAULT_TIMEOUT_SECONDS
        raw_timeout = os.environ.get(_TIMEOUT_ENV, "").strip()
        if raw_timeout:
            try:
                timeout_seconds = float(raw_timeout)
            except ValueError as exc:
                raise RuntimeError(f"{_TIMEOUT_ENV} must be numeric") from exc
            if timeout_seconds <= 0:
                raise RuntimeError(f"{_TIMEOUT_ENV} must be positive")

        base_url = _blank_to_none(os.environ.get(_BASE_URL_ENV))
        service_token = _blank_to_none(os.environ.get(_TOKEN_ENV))
        if enabled and (base_url is None or service_token is None):
            raise RuntimeError(
                f"{_BASE_URL_ENV} and {_TOKEN_ENV} are required when {_ENABLED_ENV}=true"
            )

        return cls(
            enabled=enabled,
            base_url=base_url.rstrip("/") if base_url else None,
            service_token=service_token,
            timeout_seconds=timeout_seconds,
            emergency_bypass=_truthy(os.environ.get(_BYPASS_ENV)),
        )


class BillingClient:
    def __init__(
        self,
        config: BillingConfig,
        *,
        http_client_factory: HttpClientFactory = httpx.AsyncClient,
    ) -> None:
        self._config = config
        self._http_client_factory = http_client_factory

    async def reserve(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._post("/v1/reservations", payload)

    async def settle(self, reservation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._post(f"/v1/reservations/{reservation_id}/settle", payload)

    async def refund(self, reservation_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._post(f"/v1/reservations/{reservation_id}/refund", payload)

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._config.enabled:
            raise RuntimeError("billing client called while disabled")
        assert self._config.base_url is not None
        assert self._config.service_token is not None

        try:
            async with self._http_client_factory(timeout=self._config.timeout_seconds) as client:
                response = await client.post(
                    f"{self._config.base_url}{path}",
                    headers={
                        "Authorization": f"Bearer {self._config.service_token}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            raise BillingUnavailable("billing_timeout") from exc
        except httpx.HTTPError as exc:
            raise BillingUnavailable("billing_unreachable") from exc

        if response.status_code >= 400:
            detail = _safe_error_detail(response)
            if response.status_code == 402:
                raise HTTPException(status_code=402, detail=f"billing_insufficient_credits: {detail}")
            if response.status_code in (401, 403):
                raise BillingUnavailable("billing_auth_failed")
            if 400 <= response.status_code < 500:
                raise HTTPException(
                    status_code=400,
                    detail=f"billing_rejected_request: {detail}",
                )
            raise BillingUnavailable(f"billing_http_{response.status_code}")

        try:
            data = response.json()
        except ValueError as exc:
            raise BillingUnavailable("billing_invalid_json") from exc
        if not isinstance(data, dict):
            raise BillingUnavailable("billing_invalid_response")
        return data


class BillingUnavailable(RuntimeError):
    """Raised when the billing service cannot be reached or trusted."""


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _blank_to_none(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def idempotency_key(prefix: str, raw: object) -> str:
    raw_s = str(raw or "").strip() or "missing"
    key = f"{prefix}:{raw_s}"
    if len(key) <= _MAX_IDEMPOTENCY_KEY_LEN:
        return key
    digest = hashlib.sha256(key.encode()).hexdigest()
    return f"{prefix}:sha256:{digest}"


def usd_to_micro_usd(value: object) -> int | None:
    if value is None:
        return None
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if decimal < 0:
        return None
    micro = (decimal * MICRO_USD_PER_USD).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(micro)


def extract_litellm_cost_micro_usd(kwargs: dict[str, Any], response_obj: object | None = None) -> int | None:
    for candidate in (
        kwargs.get("response_cost"),
        kwargs.get("cost"),
        _header_value(kwargs.get("response_headers"), "x-litellm-response-cost"),
        _hidden_param(response_obj, "response_cost"),
        getattr(response_obj, "response_cost", None),
    ):
        converted = usd_to_micro_usd(candidate)
        if converted is not None:
            return converted
    return None


def extract_usage(kwargs: dict[str, Any], response_obj: object | None = None) -> dict[str, Any]:
    usage = _jsonable(getattr(response_obj, "usage", None))
    if isinstance(usage, dict) and usage:
        return usage

    body_usage = _usage_from_body(kwargs.get("response_body"))
    if body_usage:
        return body_usage
    return {}


def _header_value(headers: object, name: str) -> object | None:
    if isinstance(headers, dict):
        lowered = {str(k).lower(): v for k, v in headers.items()}
        return lowered.get(name.lower())
    return None


def _hidden_param(response_obj: object | None, name: str) -> object | None:
    hidden = getattr(response_obj, "_hidden_params", None)
    if isinstance(hidden, dict):
        return hidden.get(name)
    return None


def _usage_from_body(body: object) -> dict[str, Any]:
    if isinstance(body, (bytes, bytearray)):
        try:
            body = body.decode("utf-8")
        except UnicodeDecodeError:
            return {}
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            return {}
    if isinstance(body, dict):
        usage = body.get("usage")
        if isinstance(usage, dict):
            return usage
    return {}


def _jsonable(value: object) -> object:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    return value


def _safe_error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:500]
    if isinstance(body, dict):
        detail = body.get("detail") or body.get("error") or body
        return str(detail)[:500]
    return str(body)[:500]
