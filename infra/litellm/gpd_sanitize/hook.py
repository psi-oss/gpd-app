"""LiteLLM worker-startup hook: strip GPD agent-orchestration keys from
incoming request bodies so they never reach the upstream LLM provider.

Pointed to by `LITELLM_WORKER_STARTUP_HOOKS=...,gpd_sanitize.hook:register`
in the Dockerfile. Runs once per uvicorn worker during FastAPI lifespan
startup (proxy_server.py:777-803), before any request is served.

## Why this exists

GPD agent definitions at `~/.config/gpd/agents/*.md` ship with frontmatter
keys consumed by GPD's orchestrator (commit-authority gate, role-family
routing, surface labelling, artifact-write authority, shared-state
authority). They are not provider request parameters.

Opencode's Agent zod schema in `packages/opencode/src/config/config.ts:515-540`
uses `.catchall(z.any())` + a transform that copies every unknown
frontmatter key into `agent.options`. `agent.options` then flows into
`providerOptions[providerID]` (`packages/opencode/src/provider/transform.ts:1040`).
The `@ai-sdk/openai-compatible` adapter spreads providerOptions[name]
keys not in its known schema directly at the top level of the outgoing
JSON request body.

Verified live 2026-05-07 against the production proxy:

    claude-sonnet-4-6 + top-level commit_authority -> HTTP 400
        AnthropicException invalid_request_error
        "commit_authority: Extra inputs are not permitted"
    gpt-5.5 (chat-completions) + top-level commit_authority -> HTTP 400
        OpenAIException "Unknown parameter: 'commit_authority'"
    gpt-5.5 (responses API) + top-level commit_authority -> HTTP 200
        (Responses API tolerates unknown body keys)

That's why Sergio's gpt-5.5-pro runs (Responses API path) succeeded
while Jonathan's claude-sonnet-4-6 runs (chat-completions path) 400'd
3 of 6 times. Same payload, different upstream validator.

## Why fix at the proxy, not at the client

* Every GPD client points at this proxy. There is no direct upstream
  path to seal off.
* One redeploy covers every already-installed v1.0.0 desktop user; we
  do not need to ship a desktop release loop for this.
* If GPD adds another orchestration frontmatter key in the future, we
  add the literal here in one place instead of patching opencode.
* Future non-desktop clients (CLI, scripts) get the fix for free.

## Hook contract (verified against the deployed source)

`/app/litellm/integrations/custom_logger.py:369-380`:
    async def async_pre_call_hook(
        self, user_api_key_dict, cache, data: dict, call_type
    ) -> Optional[Union[Exception, str, dict]]
    # "return a modified dictionary for passing into litellm"

`/app/litellm/proxy/utils.py:1391-1444` iterates `litellm.callbacks` and
calls `async_pre_call_hook` only when the subclass overrides the method
(`vars(_callback.__class__)` check). The returned dict replaces `data`
for the downstream call chain via `process_pre_call_hook_response`.

Routes covered (`/app/litellm/proxy/common_request_processing.py:823`
calls pre_call_hook with `route_type` taken from a Literal that includes
`acompletion`, `aresponses`, `aembedding`, `anthropic_messages`, ...).
That covers `/v1/chat/completions`, `/v1/responses`, and the
`/anthropic/v1/messages` passthrough — every path GPD traffic actually
takes.

## Failure mode if a key is missing from the set

A new GPD frontmatter key will leak through and start 400'ing on
chat-completions providers again. The fix is a one-line addition to the
set below + a redeploy.

## Failure mode if we accidentally strip a real provider param

We over-zealously delete a field the upstream model needs. The current
set is empirically constrained to fields that match the regex
`^[a-z_]+_(authority|family|surface)$` shape — none of these are valid
OpenAI / Anthropic / Google body params. New entries should be reviewed
against the relevant provider docs before being added.
"""
from __future__ import annotations

import logging

# Keys GPD agents put in frontmatter for orchestration. None of these
# are valid LLM-provider request parameters. Add new entries here when
# GPD ships new orchestration metadata.
GPD_ORCHESTRATION_KEYS = frozenset(
    {
        "commit_authority",
        "surface",
        "role_family",
        "artifact_write_authority",
        "shared_state_authority",
    }
)


def register() -> None:
    logger = logging.getLogger("gpd_sanitize")

    # Local imports: keep module-load cost zero on workers that crash
    # before the lifespan hook fires (mirrors the gpd_log/gpd_tos
    # registration pattern).
    import litellm
    from litellm.integrations.custom_logger import CustomLogger

    class GpdRequestSanitizer(CustomLogger):
        # We MUST define this method on the subclass — LiteLLM's
        # dispatcher at proxy/utils.py:1429 skips callbacks where
        # `_callback.__class__.async_pre_call_hook == CustomLogger.async_pre_call_hook`.
        async def async_pre_call_hook(
            self,
            user_api_key_dict,
            cache,
            data,
            call_type,
        ):
            if not isinstance(data, dict):
                return None
            stripped: list[str] = []
            for key in GPD_ORCHESTRATION_KEYS:
                if key in data:
                    data.pop(key, None)
                    stripped.append(key)
            if stripped:
                # debug, not info — every gpd-planner invocation will
                # strip ~5 keys, no need to spam INFO logs.
                logger.debug(
                    "stripped GPD orchestration keys from %s body: %s",
                    call_type,
                    stripped,
                )
            return data

    litellm.callbacks.append(GpdRequestSanitizer())
    logger.info(
        "gpd_sanitize: registered async_pre_call_hook (strips %d orchestration keys)",
        len(GPD_ORCHESTRATION_KEYS),
    )
