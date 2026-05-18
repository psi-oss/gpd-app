"""Slack signature verification."""
from __future__ import annotations

import hashlib
import hmac
import time

import pytest

from gpd_mint import signature

SECRET = "test-signing-secret-do-not-leak"


def _sign(body: bytes, ts: str, secret: str = SECRET) -> str:
    basestring = b"v0:" + ts.encode("ascii") + b":" + body
    return "v0=" + hmac.new(secret.encode("utf-8"), basestring, hashlib.sha256).hexdigest()


def test_valid_signature_passes() -> None:
    body = b"command=%2Fmint-gpd-key&user_id=U123"
    ts = str(int(time.time()))
    signature.verify(
        signing_secret=SECRET, body=body, timestamp=ts, signature=_sign(body, ts)
    )


def test_tampered_body_fails() -> None:
    body = b"command=%2Fmint-gpd-key&user_id=U123"
    ts = str(int(time.time()))
    sig = _sign(body, ts)
    with pytest.raises(signature.SignatureError, match="signature mismatch"):
        signature.verify(
            signing_secret=SECRET,
            body=body + b"&malicious=1",
            timestamp=ts,
            signature=sig,
        )


def test_wrong_secret_fails() -> None:
    body = b"x=1"
    ts = str(int(time.time()))
    sig = _sign(body, ts, secret="attacker-secret")
    with pytest.raises(signature.SignatureError, match="signature mismatch"):
        signature.verify(signing_secret=SECRET, body=body, timestamp=ts, signature=sig)


def test_replay_outside_window_fails() -> None:
    body = b"x=1"
    ts_old = str(int(time.time()) - 600)  # 10 min old
    sig = _sign(body, ts_old)
    with pytest.raises(signature.SignatureError, match="replay window"):
        signature.verify(
            signing_secret=SECRET, body=body, timestamp=ts_old, signature=sig
        )


def test_future_timestamp_fails() -> None:
    body = b"x=1"
    ts_future = str(int(time.time()) + 600)
    sig = _sign(body, ts_future)
    with pytest.raises(signature.SignatureError, match="replay window"):
        signature.verify(
            signing_secret=SECRET, body=body, timestamp=ts_future, signature=sig
        )


def test_missing_signature_header_fails() -> None:
    with pytest.raises(signature.SignatureError, match="missing signature headers"):
        signature.verify(
            signing_secret=SECRET,
            body=b"x=1",
            timestamp=str(int(time.time())),
            signature="",
        )


def test_missing_timestamp_header_fails() -> None:
    with pytest.raises(signature.SignatureError, match="missing signature headers"):
        signature.verify(
            signing_secret=SECRET, body=b"x=1", timestamp="", signature="v0=abc"
        )


def test_malformed_timestamp_fails() -> None:
    with pytest.raises(signature.SignatureError, match="malformed timestamp"):
        signature.verify(
            signing_secret=SECRET, body=b"x=1", timestamp="not-a-number", signature="v0=abc"
        )


def test_empty_secret_rejected() -> None:
    body = b"x=1"
    ts = str(int(time.time()))
    sig = _sign(body, ts)
    with pytest.raises(signature.SignatureError, match="signing_secret empty"):
        signature.verify(signing_secret="", body=body, timestamp=ts, signature=sig)
