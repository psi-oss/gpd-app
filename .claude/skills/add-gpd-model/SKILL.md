---
name: add-gpd-model
description: End-to-end runbook for adding a new LLM (OpenAI, Anthropic, Gemini) to GPD — spec verification, LiteLLM proxy registration on Railway, effort-ladder probing, desktop picker metadata in gpd-app, key-scoping check, and cutting the release. Use whenever asked to add, register, or expose a new model in GPD.
---

# Add a model to GPD

GPD = the PSI desktop app (`psi-oss/gpd-app`, default branch `gpd`) + a LiteLLM
proxy on Railway (project `psi-gpd`, service `litellm`, URL
`https://litellm-production-46bb.up.railway.app`). A model is "added" when the
proxy serves it to `gpd-chat`-scoped keys AND the desktop ships first-class
picker metadata for it. Both sides are independent: the proxy side is live
immediately; the desktop side ships with the next release (until then the
picker shows the raw id as a stub, because the picker is dynamic —
`/v1/models` per user key, 5-minute sidecar cache).

Worked examples: gpd-app PR #39/#40 (GPT 5.6 sol/terra/luna) and PR #41
(Claude Opus 5).

**Never commit secrets — the repo is public.** Every secret is fetched at
runtime: `railway variables --service litellm --kv | grep ^<VAR>=`
(needs `railway link --project 0ddad766-1ee1-44ed-95c2-f8f7d9cb5515` once).
Relevant vars: `LITELLM_MASTER_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`.

## 1. Verify the model's specs — never from memory

New models postdate your training data. Triangulate at least two of:

- **models.dev** — `curl -s https://models.dev/api.json`, look under the
  upstream provider (e.g. `openai`, `anthropic`). This is the repo's declared
  lockstep source for cost blocks. Gives id, name, limits, cost (incl.
  cache_write, >272K tiers, priority tiers), reasoning effort values,
  temperature support.
- **The provider's live Models API** (authoritative for capabilities). For
  Anthropic: `GET https://api.anthropic.com/v1/models/<id>` with the Railway
  `ANTHROPIC_API_KEY` → `max_input_tokens`, `max_tokens`,
  `capabilities.thinking.types` (adaptive vs enabled/budget_tokens),
  `capabilities.effort.{low..max}`.
- **LiteLLM's price map** —
  `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
  (main branch; the *pinned proxy image* is older and won't have the model).
- Optionally a web-research subagent for pricing corroboration and API-shape
  notes (temperature rejection, refusal behavior, etc.).

Trust probes over documents when they disagree; the desktop repo's convention
is that effort ladders and capability flags are enabled only after a live
probe passes (step 4).

## 2. Register on the LiteLLM proxy

The proxy's model list is **DB-backed** (`LITELLM_STORE_MODEL_IN_DB`), no
config.yaml. Registration is `POST /model/new` with the master key. The
pinned image (check `infra/litellm/Dockerfile`) predates any new model, so
**the row must carry full `model_info`**: pricing per token (input/output/
cache_read/`cache_creation_input_token_cost`, plus `_above_272k_tokens` and
`_priority` variants for OpenAI, `_above_1hr` cache write for Anthropic),
`max_input_tokens`/`max_output_tokens`/`max_tokens`, capability flags
(`supports_reasoning`, `supports_xhigh_reasoning_effort`,
`supports_max_reasoning_effort`, `supports_vision`, `supports_pdf_input`,
`supports_prompt_caching`, ...), `supported_openai_params`, and
`access_groups: ["all-models", "gpd-chat"]` (`gpd-chat` is what desktop keys
see). **Mirror the newest existing row of the same provider family verbatim**
(`GET /v1/model/info` with the master key) and adjust ids + pricing.

Provider differences:
- **OpenAI**: `litellm_params.model = "openai/<id>"`, `mode: "chat"` (even for
  Responses-API models — the proxy passes `/v1/responses` through regardless).
- **Anthropic**: `litellm_params.model = "anthropic/<id>"` and, for models the
  pinned image doesn't map, the row MUST include `"drop_params": true` and
  `"allowed_openai_params": ["thinking", "output_config"]` — without it,
  adaptive thinking + `output_config.effort` never reach upstream, and
  `reasoning_effort: xhigh|max` 500s with "Unmapped reasoning effort".

**api_key handling** (the env-resolution regression, docs/LITELLM_OPS.md):
register with `"api_key": "os.environ/<PROVIDER>_API_KEY"`, then patch the
literal via `POST /model/update`. Two critical semantics learned the hard way:
- `/model/update` **REPLACES `litellm_params` wholesale** (unspecified fields
  reset to defaults — this silently wiped `allowed_openai_params` once). Send
  the FULL litellm_params including the literal api_key in one update.
- `model_info` **merges** by row id — pass `{"id": <row id>}` plus only the
  fields you're changing.
- Don't use `railway ssh` + resolve-env-keys.py from a headless session — the
  ssh session hangs with no output. The API path above is equivalent.

Then bounce the service: `railway redeploy --service litellm -y` and poll
`railway deployment list --service litellm --json` until SUCCESS (~2 min; the
old deployment serves during the build).

## 3. Mint a probe key, verify serving

```
MASTER=$(railway variables --service litellm --kv | awk -F= '/^LITELLM_MASTER_KEY=/{print $2}')
KEY=$(curl -s -X POST "$BASE/key/generate" -H "Authorization: Bearer $MASTER" \
  -H 'Content-Type: application/json' \
  -d '{"key_alias":"<model>-verify","models":["gpd-chat"],"max_budget":10,"duration":"1d"}' | jq -r .key)
```
Use `models: ["gpd-chat"]` (what real desktop keys have), not the master key —
the consent gate 403s the master key for LLM calls. Check `/v1/models`
advertises the new id(s) to that key, then one live chat completion per model.
**Delete the key when done** (`POST /key/delete`).

## 4. Probe the effort ladder with the real app payload

From `packages/opencode` in the gpd-app repo (worktree must already contain
your metadata edits for Claude models — the probe reads the adaptive profile):

```
GPD_API_KEY=$KEY bun script/gpd-full-payload-probe.ts --live \
  --models=<ids,comma-separated> --efforts=low,medium,high,xhigh,max \
  --tool-counts=full --streams=true --output=/tmp/probe.json
```

PASS alone is not enough — check reasoning actually flows (precedent:
gpt-5.3-codex returned HTTP 200 at `max` with reasoning silently dropped):
- OpenAI models: direct `/v1/responses` call with
  `"reasoning": {"effort": "<tier>", "summary": "auto"}` on a non-trivial
  prompt → expect non-zero `usage.output_tokens_details.reasoning_tokens` and
  a summary part. (The probe's trivial prompt often yields zero reasoning —
  that's the prompt, not the model.)
- Anthropic models: chat.completions with
  `"thinking": {"type": "adaptive", "display": "summarized"}` +
  `"output_config": {"effort": "<tier>"}` → expect `thinking_blocks` /
  `reasoning_content` in the message.

Also probe **temperature** (`temperature: 0.5`): recent reasoning models
reject it (all of GPT 5.5/5.6, 5.3-codex; the 5.4 family accepts it). The
metadata `temperature` flag must reflect reality — with `true`, an
agent-configured temperature flows through `llm.ts`'s capability gate into
the request and 400s every turn. (Claude adaptive-profile models are exempt:
the GPD adapter strips sampling params at wire time, so they keep `true` by
convention.)

## 5. Desktop code (`packages/opencode/src/provider/gpd-models.ts`)

Work on a branch off **fresh `origin/gpd`** (use a worktree; the release
builds from `gpd`). Tables to touch:

- `GPD_MODEL_METADATA` — display name, capability flags, `limit`
  (context/output), `cost` per MTok **in lockstep with models.dev's cost
  block** (include `cache_write` only if the upstream bills it — OpenAI
  started with the 5.6 family; Anthropic always has).
- `GPD_MODEL_REASONING_EFFORTS` — only tiers that passed step 4, with a dated
  probe comment (repo convention).
- `GPD_RESPONSES_API_MODELS` — add OpenAI GPT-5.x reasoning models (summaries
  only stream via `/v1/responses`). NEVER add Claude/Gemini (LiteLLM's
  Responses translator strips their thinking; they stay on chat.completions).
- `gpdAnthropicAdaptiveProfile` — Claude models only. New models unmapped in
  the pinned image go in the fable-5/opus-4-8 branch
  (`{summarizedDisplay: true, omitsReasoningEffort: true, promoteXhighToMax: false}`)
  and need the step-2 `allowed_openai_params` row. Watch substring collisions
  with dash-normalized ids (`opus-5` vs `opus-4-5`) — add a regression test.
- `GPD_MODEL_HIDDEN_IDS` — only if a model must be suppressed despite the
  proxy advertising it.

Do NOT touch `models-snapshot.js` — it's gitignored on `gpd` and regenerated
from models.dev by `script/build.ts` at release-build time.

Tests: extend `test/provider/gpd-models.test.ts` (ladder, metadata, profile,
Responses routing) and `test/provider/transform.test.ts` (per-tier request
shape — copy the "GPD opus 4.8 carries effort via output_config only" or
"gpt-5.4 includes xhigh" pattern). Run
`bun test test/provider/ && bun run typecheck` — husky's pre-push runs turbo
typecheck and will block the push otherwise. One known flake:
provider.test.ts "plugin config providers persist after instance dispose"
times out under full-suite load; passes in isolation.

Optional but ideal: UI screenshot. `bun tauri dev` from the worktree needs
`packages/desktop/src-tauri/uv-bundle` (symlink from the main checkout — it's
a gitignored 32MB build artifact) and the tauri-plugin-mcp symlink for
automation. The resolver check is a faster proxy:
`bun -e 'import {resolveGpdProviderModels} ...'` against production with the
probe key.

## 6. PR and merge

PR to `gpd`. Branch protection requires review; the repo's practice is
squash-merge (`gh pr merge <n> --repo psi-oss/gpd-app --squash --delete-branch
--admin` once CodeRabbit is green). Commit style: `feat(provider): ...` with
probe evidence in the body. Never add an AI co-author.

## 7. Key scoping — who actually sees the model

Keys with `models: ["gpd-chat"]` (the mint-bot default, and everything since
the 2026-07-22 fleet migration) see new models automatically after app
restart (5-min sidecar cache). A key with an explicit pinned model list will
NOT — diagnose with `GET /key/info?key=...`, fix with
`POST /key/update {"models": ["gpd-chat", ...non-group extras]}` (verify the
pinned models are all in the group before swapping; keep any that aren't as
explicit extras).

## 8. Release

Per docs/RELEASING.md, but with one correction: **the next version must clear
existing DRAFTS, not just published tags** — dispatching at a version that has
a stale draft appends assets onto it. Check
`gh api repos/psi-oss/gpd-app/releases --jq '.[] | {tag: .tag_name, draft}'`.

```
gh workflow run gpd-release.yml --repo psi-oss/gpd-app --ref gpd -f version=<next>
```

Draft populates as platforms finish (mac ~6 min, Windows last ~15 min; 15
assets total). Publish ONLY on explicit request, and always with the explicit
tag: `gh workflow run gpd-publish-draft.yml --repo psi-oss/gpd-app --ref gpd
-f tag=gpd-desktop-v<ver>` (without `tag` it grabs the newest draft — unsafe
while stale drafts exist). Publishing auto-refreshes download.gpd.psi.inc and
reaches existing installs via auto-update.

## Verification checklist (all must pass before calling it done)

- [ ] `/v1/models` with a `gpd-chat` key lists the new id(s)
- [ ] Live completion per model through the proxy returns content
- [ ] Full-payload probe passes every advertised effort tier
- [ ] Reasoning content verified non-empty at the top tiers (not just HTTP 200)
- [ ] Temperature flag matches a live probe (or model is adaptive-profile Claude)
- [ ] Spend tracking: pricing on the row matches models.dev + LiteLLM map
- [ ] `bun test test/provider/` green, typecheck delta zero
- [ ] Resolver (or picker UI) shows the display name, cost, and full ladder
- [ ] Probe key deleted
