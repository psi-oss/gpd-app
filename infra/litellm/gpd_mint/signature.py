"""Slack request signature verification.

https://api.slack.com/authentication/verifying-requests-from-slack

Signature = "v0=" + hex(HMAC-SHA256(signing_secret, "v0:{ts}:{raw_body}"))

Slack puts the signature in `X-Slack-Signature` and the unix timestamp in
`X-Slack-Request-Timestamp`. Reject ts older than 300s to prevent replay.
Compare in constant time to dodge timing leaks.
"""
from __future__ import annotations

import hashlib
import hmac
import time

_MAX_TS_SKEW_SECONDS = 300


class SignatureError(Exception):
    """Slack signature failed verification — request is unauthenticated."""


def verify(*, signing_secret: str, body: bytes, timestamp: str, signature: str) -> None:
    """Raise SignatureError if the request did not originate from Slack
    (or was replayed > 5 min after Slack issued it).
    """
    if not signing_secret:
        raise SignatureError("server misconfigured: signing_secret empty")
    if not timestamp or not signature:
        raise SignatureError("missing signature headers")

    try:
        ts_int = int(timestamp)
    except ValueError as e:
        raise SignatureError("malformed timestamp") from e

    if abs(time.time() - ts_int) > _MAX_TS_SKEW_SECONDS:
        raise SignatureError("timestamp outside replay window")

    basestring = b"v0:" + timestamp.encode("ascii") + b":" + body
    expected = "v0=" + hmac.new(
        signing_secret.encode("utf-8"), basestring, hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        raise SignatureError("signature mismatch")
