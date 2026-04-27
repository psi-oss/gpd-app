# GPD's LiteLLM image: stock upstream + our custom /gpd/log route.
#
# Pinned to a specific release (not rolling main-stable) because our
# hook.py monkey-patches internal LiteLLM state:
#   LiteLLMRoutes.openai_routes.value.append("/gpd/log")
# A rename of that field in any upstream release would silently break
# /gpd/log. The smoke-test GH workflow catches ABI breakage whenever we
# bump the pin.
#
# Upgrade procedure:
#   1. Check https://github.com/BerriAI/litellm/security/advisories for
#      CVEs against the current pin.
#   2. Pick the newest tag that patches all advisories (see LOGGING.md).
#   3. Bump the FROM line.
#   4. Locally: `railway up infra/litellm --path-as-root --service litellm`
#      and re-run the smoke test (GH Actions `litellm-smoke-test.yml`).
#   5. Commit.
#
# Current pin: v1.83.14.rc.1 (release candidate). Bumped from
# v1.83.7-stable to pick up the GPT-5.5 model registry entry — without
# this, LiteLLM 1.83.7 doesn't know `gpt-5.5` exists, falls through to
# the GPT-5 base path's "supported_params" stripping, and rejects
# `tool_choice` with HTTP 400 ("openai does not support parameters:
# ['tool_choice']"). PR BerriAI/litellm#26345 (commit 3950f5ea, merged
# 2026-04-23) added the entry; first tag carrying it is
# v1.83.11-nightly, first RC is v1.83.14.rc.1 (2026-04-27).
#
# RC, not -stable: no stable cut past v1.83.7-stable.patch.1 (CVE-only)
# exists yet at bump time. The litellm-smoke-test workflow gates ABI
# regressions to our hooks. Move back to a -stable tag the moment one
# lands past 04-27.
#
# Carries forward all CVE patches from v1.83.7-stable
# (GHSA-v4p8-mg3p-g94g, GHSA-r75f-5x8p-qvmc, GHSA-xqmj-j6mv-4862,
# GHSA-69x8-hrgq-fjj8, GHSA-53mr-6c8q-9789, GHSA-jjhc-v7c2-5hh6) plus
# whatever shipped in the 04-19 → 04-27 window.
FROM ghcr.io/berriai/litellm:v1.83.14.rc.1

# asyncpg so gpd_tos.hook.ensure_schema() can (re-)create the custom
# gpd_tos_acceptance table on every worker start. Necessary because
# LiteLLM's bundled PrismaClient silently rolls DDL back on disconnect,
# AND LiteLLM's startup `prisma migrate` step drops unmanaged tables.
# Without this bootstrap, the table disappears on every redeploy.
#
# Install via `uv` not pip: LiteLLM v1.83.14.rc.1's image switched to a
# uv-managed venv at /app/.venv with no pip module bundled inside
# (`python -m pip` returns "No module named pip"). uv ships in the image
# (LiteLLM uses it for its own build) so `uv pip install` is the right
# entry point. Targets the active venv at /app/.venv via VIRTUAL_ENV
# semantics; --system avoids "no virtualenv detected" inside RUN.
# Bare `pip` worked on v1.83.7-stable; required this swap from rc.1.
RUN uv pip install --system --no-cache-dir asyncpg==0.31.0

# Our hook modules.
#   gpd_log     → POST /gpd/log (session-event ingest to GCS). See
#                 infra/litellm/gpd_log/README.md for architecture.
#   gpd_tos     → POST /gpd/tos-accept + /gpd/tos-revoke (TOS audit
#                 writer, separate Postgres via GPD_AUDIT_DATABASE_URL).
#                 See docs/LOGGING.md + infra/litellm/gpd_tos/migrations/.
#   gpd_consent → CustomLogger on litellm.callbacks that 403s LLM calls
#                 from users with non-null revoked_at. Reads
#                 gpd_tos_acceptance via gpd_tos.db's asyncpg pool, so it
#                 MUST register after gpd_tos (order of the ENV list
#                 controls hook invocation; LiteLLM iterates left-to-right).
COPY gpd_log /app/gpd_log
COPY gpd_tos /app/gpd_tos
COPY gpd_consent /app/gpd_consent

# Activate hooks in order. LiteLLM iterates this comma-separated list
# during worker startup (proxy_server.py:777-803, PR #22931) and calls
# each entry as `module:function`. gpd_consent registers LAST so the
# audit-DB pool opened by gpd_tos is already alive when consent_gate.db
# issues its first query.
ENV LITELLM_WORKER_STARTUP_HOOKS=gpd_log.hook:register,gpd_tos.hook:register,gpd_consent.hook:register
ENV PYTHONPATH=/app
