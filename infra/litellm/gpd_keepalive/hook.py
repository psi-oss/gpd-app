"""Worker-startup hook: monkey-patch Starlette's StreamingResponse so every
SSE response emitted by LiteLLM goes through the keepalive wrapper.

We can't use `app.add_middleware(...)` because LiteLLM has already begun
its lifespan startup by the time worker hooks fire (proxy_server.py:777-
803) — Starlette refuses middleware additions after that point.

Patching the class is the smallest reliable lever:
  - One-time monkey-patch on `StreamingResponse.__init__`.
  - When the response declares `media_type=text/event-stream`, we replace
    its `body_iterator` with the keepalive-wrapped version BEFORE the
    response is sent. Non-SSE StreamingResponses (binary downloads, JSON
    line streams) pass through untouched.
  - Idempotent: the patch tags itself on `StreamingResponse`, so
    re-registration (e.g. if the hook is accidentally listed twice in
    LITELLM_WORKER_STARTUP_HOOKS) is a no-op.

If LiteLLM ever switches its streaming responses off Starlette, this
hook silently no-ops and the gpd-side fallback (client `chunkTimeout`,
re-armed at e.g. 90s after this lands) kicks back in.
"""

from __future__ import annotations

import logging


_PATCH_MARKER = "_gpd_keepalive_patched"


def register() -> None:
    logger = logging.getLogger("gpd_keepalive")

    # Local imports to keep worker startup cost low if this hook isn't
    # listed in LITELLM_WORKER_STARTUP_HOOKS.
    try:
        from starlette.responses import StreamingResponse
    except ImportError:
        logger.warning(
            "gpd_keepalive: starlette.responses not importable; "
            "skipping SSE keepalive injection (LiteLLM streaming will "
            "rely on client-side chunkTimeout)."
        )
        return

    if getattr(StreamingResponse, _PATCH_MARKER, False):
        logger.info("gpd_keepalive: already patched; skipping")
        return

    from .keepalive import wrap_with_keepalive

    original_init = StreamingResponse.__init__

    def patched_init(self, content, *args, **kwargs):
        original_init(self, content, *args, **kwargs)
        media_type = getattr(self, "media_type", None) or ""
        if media_type.startswith("text/event-stream"):
            # `self.body_iterator` is set by the original __init__ and is
            # always an async iterator (Starlette wraps sync iterables
            # via `iterate_in_threadpool`). Swap it for the keepalive
            # wrapper — the wrapper yields the same bytes plus keepalive
            # comments during silences.
            self.body_iterator = wrap_with_keepalive(self.body_iterator)

    StreamingResponse.__init__ = patched_init
    setattr(StreamingResponse, _PATCH_MARKER, True)

    logger.info(
        "gpd_keepalive: patched StreamingResponse.__init__ "
        "(SSE responses now emit keepalive every 25s during upstream silences)"
    )
