# gpd_mint — Slack-driven LiteLLM key minting

A FastAPI route mounted on the LiteLLM proxy at `POST /gpd/slack/mint`
that lets approved operators mint GPD virtual keys from Slack via the
`/mint-gpd-key` slash command + a modal form.

Built on the same pattern as `gpd_log`, `gpd_feedback`, `gpd_consent`,
`gpd_sanitize` — a worker-startup hook that appends a route to
`LiteLLMRoutes.openai_routes` so virtual-key auth doesn't block the
route, then runs its own auth (HMAC of Slack's signing secret +
explicit user-ID allowlist).

## Flow

```
Slack /mint-gpd-key            POST /gpd/slack/mint  (form-encoded, command=...)
   ↓                                ↓
trigger_id (3s expiry)         signature verify (sig.py)
                                whitelist check (whitelist.py)
                                views.open with mint modal
                                ↓
                          [Slack renders modal to operator]
                                ↓
Modal submitted               POST /gpd/slack/mint  (form-encoded, payload=<json>)
                                ↓
                          signature verify
                          whitelist re-check (defense in depth)
                          field validation (email shape, budget range, slug)
                          response_action: clear (close modal)
                          ↓ background task
                          mint.mint() → POST /key/generate w/ LITELLM_MASTER_KEY
                          ↓
                          chat.postMessage to operator (DM with key)
                          chat.postMessage to GPD_MINT_AUDIT_CHANNEL (no full key)
```

## Auth model

Three layers:

1. **Slack signature** (`signature.py`): every request must carry a
   valid `v0=...` signature computed with `GPD_MINT_SLACK_SIGNING_SECRET`
   over the raw body + a timestamp ≤ 300s old. Random POSTs from the
   public internet get 401. Replay protection comes from the timestamp
   ceiling.
2. **User-ID allowlist** (`whitelist.py`): `GPD_MINT_AUTHORIZED_USERS`
   env var is a comma-separated list of Slack user IDs (`U0XXX...`).
   Slash command and view submission both re-check. Anyone else in the
   workspace running `/mint-gpd-key` gets an ephemeral "not authorized"
   reply and an audit log line on the server.
3. **Slack-level workspace membership**: the slash command is only
   reachable to people who can see the bot in the workspace. Combined
   with the user-ID allowlist, an outside attacker cannot trigger
   minting even if they discover the endpoint URL.

The route is open at the LiteLLM HTTP layer (registered on
`openai_routes` to bypass virtual-key auth) because Slack itself doesn't
hold a LiteLLM key. The signature + allowlist substitute for that.

## What gets minted

```python
{
  "user_id":    slugify(display_name),           # e.g. "jane-doe"
  "key_alias":  display_name[:80],               # "Jane Doe"
  "models":     ["gpd-chat"],                    # access-group sync'd with
                                                 #   GPD_MODEL_METADATA (11 models)
  "max_budget": 2000,                            # lifetime; no budget_duration
  "metadata":   {
    "minted_via":              "slack",
    "minted_by_slack_user_id": "U0XXX",
    "minted_by_slack_username": "matt",          # if present
    "recipient_email":         "jane@example.com",
    "note":                    "investor demo"   # optional
  }
}
```

`gpd-chat` is the proxy-side access group that maps to exactly the 11
models in `packages/opencode/src/provider/gpd-models.ts`
`GPD_MODEL_METADATA`. Adding/removing models from the picker means
updating both `gpd-models.ts` AND the model's `access_groups` on the
LiteLLM admin API. The pro variants `gpt-5.4-pro` / `gpt-5.5-pro` are
explicitly NOT in `gpd-chat` (see `docs/GPD_DISTRIBUTION.md`).

## Secret handling

This repo is public. No secrets live in the tree:

- `LITELLM_MASTER_KEY` — Railway env on the `litellm` service only
- `GPD_MINT_SLACK_SIGNING_SECRET` — Railway env, Slack-app dashboard only
- `GPD_MINT_SLACK_BOT_TOKEN` (`xoxb-...`) — Railway env, Slack-app dashboard only
- **Slack app-config access token** (`xoxe.xoxp-...`) — temporary,
  workspace-admin-issued, used by operators when pushing manifest changes.
  Rotates every 12h. NEVER commit one to this repo. `.gitignore` blocks
  `gpd-mint-secrets.env` patterns to prevent accidental commits.

If you're setting up the manifest from scratch and need to send a config
token to a teammate, treat it like a master key — DM only, delete the
message after the manifest push, and don't keep it in any chat history
or document. The 12h rotation bounds blast radius but doesn't eliminate
it.

## Env vars (Railway, on the `litellm` service)

| Var | Purpose |
|---|---|
| `GPD_MINT_SLACK_SIGNING_SECRET` | Slack app credentials → Basic Information → Signing Secret |
| `GPD_MINT_SLACK_BOT_TOKEN` | Slack OAuth → Bot User OAuth Token (`xoxb-...`) |
| `GPD_MINT_AUDIT_CHANNEL` | Slack channel ID (`C0XXX`) where audit posts land |
| `GPD_MINT_AUTHORIZED_USERS` | Comma-separated Slack user IDs (`U0XXX,U0YYY,...`) |
| `LITELLM_MASTER_KEY` | (reused from existing config) — admin key the mint route forwards to `/key/generate` |
| `GPD_MINT_LITELLM_BASE` | (optional) override; defaults to the prod Railway URL |

## Operations

**Add a minter:** edit `GPD_MINT_AUTHORIZED_USERS` in Railway → append
new user ID → save. No redeploy needed; LiteLLM workers read env on
every request through `whitelist.is_authorized`.

**Remove a minter:** same path — remove the ID. Effect is immediate.

**Rotate Slack signing secret:** Slack dashboard → Basic Information →
"Rotate Signing Secret" → copy new value → update Railway env → redeploy
(Slack rotates with a grace window; old secret valid for ~24h, so a
restart-only zero-downtime swap works).

**Rotate bot token:** Slack dashboard → Install App → "Reinstall to
Workspace" → copy new `xoxb-...` → update Railway env → redeploy.

**Audit channel relocation:** edit `GPD_MINT_AUDIT_CHANNEL`, invite the
bot to the new channel (`/invite @GPD Bot` in Slack), save. Next mint
posts there.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Slash command returns "dispatch failed" | endpoint 5xx or didn't reply in 3s | Check LiteLLM logs for `gpd_mint.handler` errors |
| Operator gets "invalid Slack signature" | env secret out of sync with Slack | Re-copy signing secret from Slack dashboard |
| Operator gets "not on allowlist" but should be | their Slack user ID missing from env | Click their profile in Slack → Copy member ID → add to env |
| Modal opens but submission silent-fails | bot token missing or scopes insufficient | Reinstall app, verify `chat:write` + `chat:write.public` |
| Audit row missing | bot not in audit channel, or channel ID wrong | `/invite @GPD Bot` in the channel; verify `GPD_MINT_AUDIT_CHANNEL` |
| Mint succeeds but no DM to operator | bot can't IM the operator | Operator opens a DM with the bot once (Slack quirk for first IM) |

## Tests

`infra/litellm/tests/unit/test_gpd_mint_*.py` — no Docker required,
~0.2s end-to-end:

- `test_gpd_mint_signature.py` — HMAC verification, replay window,
  tampering, malformed headers
- `test_gpd_mint_whitelist.py` — env parsing, comma/whitespace handling
- `test_gpd_mint_mint.py` — slugify edge cases, LiteLLM call shape,
  master-key forwarding, 5xx propagation

Run: `infra/litellm/.venv/bin/python -m pytest infra/litellm/tests/unit/test_gpd_mint_*.py`
