"""LiteLLM worker-startup hook: register POST /gpd/slack/mint.

Pointed to by `LITELLM_WORKER_STARTUP_HOOKS=...,gpd_mint.hook:register`
in the Dockerfile. Mirrors gpd_feedback.hook.register: appends the
route to `LiteLLMRoutes.openai_routes` so requests aren't 403'd by the
non-admin route allow-list (this route is auth'd by Slack signature,
not by LiteLLM virtual key).
"""
from __future__ import annotations

import logging


async def register() -> None:
    logger = logging.getLogger("gpd_mint")

    # Local imports — defer until hook fires so a mis-set env var can't
    # crash the worker at module load before logging is set up.
    from litellm.proxy.proxy_server import app
    from litellm.proxy._types import LiteLLMRoutes

    from .handler import gpd_slack_mint

    if "/gpd/slack/mint" not in LiteLLMRoutes.openai_routes.value:
        LiteLLMRoutes.openai_routes.value.append("/gpd/slack/mint")

    app.add_api_route(
        "/gpd/slack/mint",
        gpd_slack_mint,
        methods=["POST"],
        tags=["gpd"],
        summary="Slack-driven GPD virtual-key minting (slash + modal)",
    )

    logger.info("gpd_mint: registered POST /gpd/slack/mint")
