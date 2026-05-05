"""LiteLLM worker-startup hook: register POST /gpd/feedback + run migrations.

Pointed to by `LITELLM_WORKER_STARTUP_HOOKS=...,gpd_feedback.hook:register`
in the Dockerfile. Mirrors gpd_tos.hook.register: appends the route to
`LiteLLMRoutes.openai_routes` so virtual-key callers aren't 403'd by the
non-admin route allow-list, then awaits migrations before serving.
"""
from __future__ import annotations

import logging


async def register() -> None:
    logger = logging.getLogger("gpd_feedback")

    # Local imports — defer until hook fires so a mis-set env var can't
    # crash the worker at module load before logging is set up.
    from litellm.proxy.proxy_server import app
    from litellm.proxy._types import LiteLLMRoutes

    from . import migrate
    from .handler import gpd_feedback

    if "/gpd/feedback" not in LiteLLMRoutes.openai_routes.value:
        LiteLLMRoutes.openai_routes.value.append("/gpd/feedback")

    app.add_api_route(
        "/gpd/feedback",
        gpd_feedback,
        methods=["POST"],
        tags=["gpd"],
        summary="GPD in-app feedback submission (desktop -> audit Postgres)",
    )

    # Block worker startup on migration completion so the first POST never
    # races a missing table. Same rationale as gpd_tos.hook.
    await migrate.apply_migrations()

    logger.info("gpd_feedback: registered POST /gpd/feedback")
