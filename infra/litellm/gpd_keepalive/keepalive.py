"""SSE-stream wrapper that emits keepalive comments during upstream silences.

The core primitive is `wrap_with_keepalive(async_iterator)`: it yields
the same chunks as the wrapped iterator, but if no chunk arrives for
KEEPALIVE_INTERVAL_SECONDS, it yields a single `: keepalive\\n\\n` line
and continues waiting. Each subsequent silent interval emits another
keepalive — there is no upper bound on how many can be emitted during
one prolonged silence.

The keepalive payload is a spec-compliant SSE comment (RFC EventSource):
lines starting with `:` are ignored by parsers but DO advance the
stream-progress counter that client-side chunk-timeout watchdogs use.

We deliberately do NOT inject keepalives for non-SSE streaming responses
(JSON bodies, binary downloads). The dispatch in `hook.py` keys off
`media_type.startswith("text/event-stream")` to skip them.
"""

from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator, Union

# Tuned for current default Anthropic / OpenAI Responses behavior.
# Real silences during tool_use payload prep land in the 30-90s range;
# 25s gives clients with a 30s+ watchdog plenty of headroom while keeping
# bandwidth overhead at <1 byte/sec per idle stream.
KEEPALIVE_INTERVAL_SECONDS: float = 25.0

# SSE comment line — clients ignore the content, but it's still a chunk
# from the network's perspective so it resets any chunk-timeout watchdog.
# Trailing `\n\n` terminates the SSE event the same way `data:` lines do.
KEEPALIVE_BYTES: bytes = b": keepalive\n\n"

logger = logging.getLogger("gpd_keepalive")


async def wrap_with_keepalive(
    iterator: AsyncIterator[Union[bytes, str]],
) -> AsyncIterator[bytes]:
    """Race each next() against KEEPALIVE_INTERVAL_SECONDS.

    On timeout, emit one keepalive comment and start a new race for the
    SAME pending next() — we never cancel the upstream read, so chunks
    arrive in order with no data loss. When the upstream finally yields,
    we forward its chunk and start a fresh race for the next item.
    """
    # Pre-create the first read task so the first chunk's TTFT is also
    # protected by the keepalive watchdog. Without this, a slow first
    # token would not trigger any keepalive until 1 full read had landed.
    aiter = iterator.__aiter__()
    pending: asyncio.Task = asyncio.ensure_future(_next(aiter))

    keepalive_count = 0
    try:
        while True:
            done, _ = await asyncio.wait(
                {pending},
                timeout=KEEPALIVE_INTERVAL_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                # Upstream silent. Emit one keepalive and keep waiting on
                # the same pending task — we don't cancel it.
                keepalive_count += 1
                if keepalive_count == 1 or keepalive_count % 4 == 0:
                    # Log on first keepalive + every 100s thereafter to
                    # avoid spamming logs but still surface long silences.
                    logger.debug(
                        "emitted keepalive #%d (upstream silent >%.1fs)",
                        keepalive_count,
                        KEEPALIVE_INTERVAL_SECONDS * keepalive_count,
                    )
                yield KEEPALIVE_BYTES
                continue

            # Upstream produced a chunk (or signalled end).
            try:
                chunk = pending.result()
            except StopAsyncIteration:
                return
            except Exception:
                # Propagate the upstream error to the caller — the route
                # handler is responsible for turning it into the right
                # response shape (LiteLLM does its own error formatting).
                raise

            if isinstance(chunk, str):
                yield chunk.encode("utf-8")
            else:
                yield chunk

            if keepalive_count:
                logger.debug(
                    "upstream recovered after %d keepalive(s)",
                    keepalive_count,
                )
                keepalive_count = 0

            # Start the next read.
            pending = asyncio.ensure_future(_next(aiter))
    finally:
        # If the consumer disconnected mid-stream (client abort), make
        # sure we don't leave a dangling read task pointing into a
        # broken upstream connection.
        if not pending.done():
            pending.cancel()
            try:
                await pending
            except (asyncio.CancelledError, StopAsyncIteration, Exception):
                pass


async def _next(aiter: AsyncIterator) -> Union[bytes, str]:
    """Coroutine wrapper around `__anext__` so we can put it in a Task."""
    return await aiter.__anext__()
