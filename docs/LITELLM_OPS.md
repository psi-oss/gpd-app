# LiteLLM ops — pin policy + env-resolution workaround

Companion to `docs/LOGGING.md` and `infra/litellm/README.md`. Captures why
we pin the LiteLLM image, what regression the pin introduced, and the
literal-key workaround we apply on top.

> **Scope.** This document describes PSI's operational GPD deployment.
> Concrete values (the Railway service, the LiteLLM version pin, specific
> CVE references) reflect PSI-GPD's deploy at the time of writing.
> Downstream forks running their own GPD will substitute their own
> Railway project, version pin, and operational cadence.

> **Current pin: `v1.83.14.rc.1`** (deployed to Railway 2026-04-27,
> commit `b0de8c0f1b`). RC, not `-stable`, because no stable cut past
> `v1.83.7-stable.patch.1` exists yet — see `infra/litellm/Dockerfile`
> for the full rationale. Carries forward every CVE patch listed below
> from `v1.83.7-stable` plus whatever shipped in the 04-19 → 04-27 window.

## Why the pin

`infra/litellm/Dockerfile` pins `FROM ghcr.io/berriai/litellm:v1.83.14.rc.1`
(not rolling `main-stable`). Reasons:

1. **Monkey-patch stability.** `infra/litellm/gpd_log/hook.py` appends
   `/gpd/log` to `LiteLLMRoutes.openai_routes.value` so non-admin
   virtual keys can POST to it. That's reaching into LiteLLM's internal
   route-classification table; a rename upstream silently breaks the
   route.
2. **Security patch coverage.** v1.83.14.rc.1 carries forward every
   advisory patched in v1.83.7-stable (the previous pin) plus whatever
   shipped in the 04-19 → 04-27 window:
   - GHSA-r75f-5x8p-qvmc (critical) — SQL injection in virtual-key
     verification. **Exploitable from any valid key**, reachable on
     every LLM call.
   - GHSA-53mr-6c8q-9789 (high) — privesc via unrestricted proxy-config
     endpoint.
   - GHSA-69x8-hrgq-fjj8 (high) — password-hash exposure / pass-the-hash
     on the admin UI.
   - GHSA-v4p8-mg3p-g94g (high) — authed RCE via MCP stdio test
     endpoints.
   - GHSA-xqmj-j6mv-4862 (high) — SSTI on `/prompts/test`.
   - GHSA-jjhc-v7c2-5hh6 (critical) — OIDC userinfo cache-key collision
     → auth bypass.

Rolling back the pin below `1.83.0` reopens all six. The first two
apply directly to our surface (any valid virtual key can reach both).

The weekly smoke-test workflow (`.github/workflows/litellm-smoke-test.yml`)
catches ABI breakage in the monkey-patch whenever we bump the pin.

## The regression introduced by the pin

LiteLLM v1.83.14.rc.1 (and v1.83.7-stable before it) stops resolving the
`os.environ/<VAR>` reference syntax in `litellm_params.api_key` on
DB-backed model deployments. The string is forwarded verbatim to the
upstream provider as the API key, which rejects it (`Incorrect API key
provided: os.envir*...`).

Symptom in the UI: every chat turn fails with
`Sign-in failed. Check your API key in Settings.` (the frontend's
catch-all for any provider 401). The user's virtual key is fine; the
failure is LiteLLM → upstream (Anthropic / OpenAI / Google).

Reproduction:

```bash
KEY=<any valid virtual key>
BASE=<your-litellm-base-url>   # e.g. https://<service>.up.railway.app

curl -sS "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
# → 401 "Incorrect API key provided: os.envir*************_KEY"
```

`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. on Railway are valid —
direct curl from inside the container reaches Anthropic/OpenAI with 200.
The env vars are right. LiteLLM just doesn't dereference them anymore.

## Approach A — patch each deployment's `api_key` with the resolved literal

Chosen path for shipping today. Rollback to v1.82.3-stable.patch.4 was
rejected because it sits below 1.83.0 and reintroduces the two
exploitable-from-any-key CVEs above.

### What it does

Reads Railway env at patch time. For every row in LiteLLM's
`LiteLLM_ProxyModelTable` whose `litellm_params.api_key` starts with
`os.environ/`, replaces that reference with the current value of the
named env var and writes the row back. LiteLLM's router picks up the
new value on router rebuild (restart the service or wait for the
auto-refresh cycle).

### What survives

- Railway redeploys (Postgres persists, router re-reads on init).
- LiteLLM version bumps on the same DB shape.

### What doesn't

- Upstream API-key rotation. After rotating (e.g.) `ANTHROPIC_API_KEY`
  in Railway env, the DB still holds the previous literal. Re-run the
  script to re-resolve.
- A LiteLLM version that changes the `LiteLLM_ProxyModelTable` schema.
  Script would need a bump.

### Secret-surface delta

The literal is stored in Postgres the same way the `os.environ/...`
string already was. Postgres row-level access was already plaintext;
no change in trust boundary.

### Run procedure

Expected location: `infra/litellm/scripts/resolve-env-keys.py` (not yet
committed at the time of this doc — committed alongside the first
application to prod).

```bash
# from repo root
railway run --service litellm -- python /app/scripts/resolve-env-keys.py
# -or- one-shot copy-in:
cat infra/litellm/scripts/resolve-env-keys.py | \
  railway ssh --service litellm 'cat > /tmp/resolve.py && python /tmp/resolve.py'

# then bounce the service so the router rereads:
railway redeploy --service litellm
```

Script is idempotent: re-running is a no-op once literals are in place,
unless the env values changed.

### Verification after running

```bash
KEY=<any virtual key>
BASE=<your-litellm-base-url>   # e.g. https://<service>.up.railway.app
for m in claude-haiku-4-5 gpt-4.1-mini gemini-3-flash-preview; do
  echo "== $m =="
  curl -sS "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":5}" \
    -w "\nHTTP:%{http_code}\n"
done
# Expect HTTP 200 on each.
```

### Rollback plan

The script logs every row it touches with both the old `api_key` string
(`os.environ/<VAR>`) and the new literal-length signature. To revert:
`UPDATE LiteLLM_ProxyModelTable SET litellm_params = jsonb_set(
litellm_params, '{api_key}', '"os.environ/<VAR>"') WHERE id = '<id>'`
for each mutated row. Stored in the script's output for audit.

## When we can drop Approach A

Watch upstream for a stable release that fixes env-var resolution
without reintroducing any of the six CVEs above. Check:

```bash
curl -s https://api.github.com/repos/BerriAI/litellm/releases?per_page=20 \
  | jq -r '.[] | select(.tag_name | endswith("-stable")) | .tag_name'
```

For each candidate tag newer than v1.83.14.rc.1, verify against the
advisory list (<https://github.com/BerriAI/litellm/security/advisories>):
the candidate must list all six patches carried forward from
v1.83.7-stable. Then:

1. Bump `FROM ghcr.io/berriai/litellm:<new-tag>` in `infra/litellm/Dockerfile`.
2. `railway up infra/litellm --path-as-root --service litellm --detach`.
3. Wait for smoke-test workflow to pass (catches any ABI drift against
   our monkey-patch).
4. Smoke-test env resolution: revert ONE deployment's `api_key` to the
   `os.environ/<VAR>` form via `/model/update`, then `POST
   /v1/chat/completions`. If it works without 401, the regression is
   fixed and we can remove the literals across all deployments.
5. If it works: run the inverse script (replace literals back to
   `os.environ/<VAR>`). Commit. Remove this section.

## Upstream tracking

File: `https://github.com/BerriAI/litellm/issues/<number>` — repro
posted by us. To be filed when Approach A is applied. Include:
- LiteLLM version: `v1.83.14.rc.1` (regression carried forward from `v1.83.7-stable`).
- Our deploy shape: DB-backed model list (`LITELLM_STORE_MODEL_IN_DB=true`),
  `api_key` stored as `os.environ/<VAR>` string, no `config.yaml` file.
- Expected: LiteLLM resolves the env reference at router init.
- Actual: literal string forwarded to upstream, 401.
- Minimal repro: direct `POST /v1/chat/completions` with any valid
  virtual key.

This doc is the canonical place for the workaround's state. Update it
when Approach A is applied, when we drop it, and when we bump the pin.
