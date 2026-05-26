"""Tests for the SSE keepalive wrapper.

Run with: python -m pytest infra/litellm/tests/test_gpd_keepalive.py
(or `cd infra/litellm && python -m pytest tests/test_gpd_keepalive.py`)
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Allow the test to import gpd_keepalive without installing the package —
# matches the pattern used by the other gpd_* modules' tests.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from gpd_keepalive import keepalive  # noqa: E402


async def _sleep_then(value: bytes, delay: float):
    await asyncio.sleep(delay)
    return value


async def _async_iter(items):
    """Yield (value, delay) pairs from a list, sleeping `delay` before each."""
    for value, delay in items:
        await asyncio.sleep(delay)
        yield value


@pytest.mark.asyncio
async def test_passthrough_without_silence(monkeypatch):
    """Steady chunks at sub-keepalive intervals → no keepalives emitted."""
    monkeypatch.setattr(keepalive, "KEEPALIVE_INTERVAL_SECONDS", 0.5)
    upstream = _async_iter([
        (b"chunk1", 0.0),
        (b"chunk2", 0.1),
        (b"chunk3", 0.1),
    ])
    out = []
    async for chunk in keepalive.wrap_with_keepalive(upstream):
        out.append(chunk)
    assert out == [b"chunk1", b"chunk2", b"chunk3"]


@pytest.mark.asyncio
async def test_keepalive_during_silence(monkeypatch):
    """A 1.5s silence with 0.4s keepalive interval → at least 3 keepalives."""
    monkeypatch.setattr(keepalive, "KEEPALIVE_INTERVAL_SECONDS", 0.4)
    upstream = _async_iter([
        (b"first", 0.0),
        (b"second", 1.5),  # silence longer than 3× keepalive interval
        (b"third", 0.1),
    ])
    out = []
    async for chunk in keepalive.wrap_with_keepalive(upstream):
        out.append(chunk)
    # Order must be: first, then ≥3 keepalives, then second, then third
    assert out[0] == b"first"
    assert out[-2] == b"second"
    assert out[-1] == b"third"
    keepalives = [c for c in out if c == keepalive.KEEPALIVE_BYTES]
    assert len(keepalives) >= 3, f"expected ≥3 keepalives, got {len(keepalives)}: {out!r}"


@pytest.mark.asyncio
async def test_string_chunks_are_encoded(monkeypatch):
    """str chunks from upstream must be utf-8 encoded for downstream bytes consumers."""
    monkeypatch.setattr(keepalive, "KEEPALIVE_INTERVAL_SECONDS", 5.0)

    async def upstream():
        yield "hello"
        yield "wörld"

    out = []
    async for chunk in keepalive.wrap_with_keepalive(upstream()):
        out.append(chunk)
    assert out == [b"hello", "wörld".encode("utf-8")]


@pytest.mark.asyncio
async def test_upstream_exception_propagates(monkeypatch):
    """Exceptions from the upstream iterator must surface to the caller."""
    monkeypatch.setattr(keepalive, "KEEPALIVE_INTERVAL_SECONDS", 5.0)

    async def upstream():
        yield b"first"
        raise RuntimeError("upstream blew up")

    out = []
    with pytest.raises(RuntimeError, match="upstream blew up"):
        async for chunk in keepalive.wrap_with_keepalive(upstream()):
            out.append(chunk)
    assert out == [b"first"]


@pytest.mark.asyncio
async def test_keepalive_format_is_sse_comment():
    """The keepalive payload must be a spec-compliant SSE comment line."""
    payload = keepalive.KEEPALIVE_BYTES
    assert payload.startswith(b":"), "SSE comments must start with `:`"
    assert payload.endswith(b"\n\n"), "SSE events must terminate with blank line"
    # No `data:` prefix — that'd be parsed as actual content.
    assert b"\ndata:" not in payload


@pytest.mark.asyncio
async def test_ttft_silence_emits_keepalive(monkeypatch):
    """Slow first chunk: keepalive should fire BEFORE any data arrives."""
    monkeypatch.setattr(keepalive, "KEEPALIVE_INTERVAL_SECONDS", 0.3)
    upstream = _async_iter([
        (b"finally_first", 1.0),  # 1s before first byte → ≥3 keepalives
    ])
    out = []
    async for chunk in keepalive.wrap_with_keepalive(upstream):
        out.append(chunk)
    # All but the last must be keepalives.
    assert out[-1] == b"finally_first"
    assert all(c == keepalive.KEEPALIVE_BYTES for c in out[:-1])
    assert len(out) >= 4  # 3+ keepalives + 1 real chunk
