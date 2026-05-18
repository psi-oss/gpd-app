#!/usr/bin/env bash
#
# Mint a LiteLLM virtual key for a single user.
#
# Reads LITELLM_MASTER_KEY from Railway via `railway variables` if not
# already in the environment, so operators only need `railway link`
# done once for the litellm service.
#
# Usage:
#   scripts/mint_key.sh <name> [--budget=<usd>] [--duration=<period>]
#                              [--access=<group>] [--no-budget-cap]
#                              [--metadata='{"k":"v"}']
#
#   <name>              Required. Used as both `user_id` and `key_alias`.
#                       Convention: lowercase, hyphenated (e.g. `jane-doe`).
#   --budget=<usd>      Hard USD cap. Default 2000. Lifetime / one-shot —
#                       once spend reaches the cap the key is dead until an
#                       admin raises max_budget. Use --no-budget-cap to mint
#                       without one (NOT recommended for external users).
#   --duration=<period> OPTIONAL. Recurring budget reset window (e.g. "30d",
#                       "7d", "24h"). Omit (default) for the lump-sum policy
#                       used for current keys. Set only if you want a
#                       self-resetting allowance.
#   --access=<group>    LiteLLM access group. Default "gpd-chat" — the
#                       11 models the desktop picker actually surfaces
#                       (sync'd with gpd-models.ts GPD_MODEL_METADATA).
#                       Use "all-models" for the 17-model superset
#                       (adds gpt-4.1*, o4-mini, gemini-3-flash-preview,
#                       gpt-5.4-pro, gpt-5.5-pro — invisible in the
#                       picker but reachable via raw API).
#   --metadata=<json>   Extra metadata stored on the key row.
#
# Output: the freshly-minted `sk-...` key on stdout (and nothing else),
# so the script composes with `key=$(scripts/mint_key.sh user-x)`.
# Diagnostics go to stderr.
#
# Examples:
#   # Default: $2000 lifetime, all models, never resets
#   scripts/mint_key.sh jane-doe
#
#   # Pilot user, smaller cap (still lifetime)
#   scripts/mint_key.sh jane-doe --budget=200
#
#   # Recurring 30-day allowance (rare — explicit opt-in)
#   scripts/mint_key.sh jane-doe --budget=200 --duration=30d
#
#   # CI smoke key (tiny cap)
#   scripts/mint_key.sh ci-smoke --budget=1

set -euo pipefail

LITELLM_BASE="${LITELLM_BASE:-https://litellm-production-46bb.up.railway.app}"

usage() {
  sed -n '3,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 1
}

[[ $# -ge 1 ]] || usage
NAME="$1"; shift

BUDGET=2000
DURATION=""
ACCESS="gpd-chat"
METADATA='{}'
HAS_BUDGET=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --budget=*)         BUDGET="${1#*=}"; HAS_BUDGET=true ;;
    --no-budget-cap)    HAS_BUDGET=false ;;
    --duration=*)       DURATION="${1#*=}" ;;
    --access=*)         ACCESS="${1#*=}" ;;
    --metadata=*)       METADATA="${1#*=}" ;;
    -h|--help)          usage ;;
    *)                  echo "unknown arg: $1" >&2; usage ;;
  esac
  shift
done

if [[ ! "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "name must match [a-z0-9][a-z0-9-]* (got: '$NAME')" >&2
  exit 2
fi

if [[ -z "${LITELLM_MASTER_KEY:-}" ]]; then
  if ! command -v railway >/dev/null 2>&1; then
    echo "LITELLM_MASTER_KEY not set and 'railway' CLI not on PATH" >&2
    exit 3
  fi
  LITELLM_MASTER_KEY="$(railway variables --service litellm --kv \
    | awk -F= '/^LITELLM_MASTER_KEY=/{print $2; exit}')"
  if [[ -z "$LITELLM_MASTER_KEY" ]]; then
    echo "could not resolve LITELLM_MASTER_KEY (run 'railway link' first)" >&2
    exit 3
  fi
fi

payload=$(python3 -c '
import json, sys
name, access, budget, duration, metadata, has_budget = sys.argv[1:7]
body = {
  "user_id":   name,
  "key_alias": name,
  "models":    [access],
  "metadata":  json.loads(metadata),
}
if has_budget == "1":
    body["max_budget"] = float(budget)
if duration:
    body["budget_duration"] = duration
print(json.dumps(body))
' "$NAME" "$ACCESS" "$BUDGET" "$DURATION" "$METADATA" "$($HAS_BUDGET && echo 1 || echo 0)")

response="$(curl -sS --fail-with-body -X POST "$LITELLM_BASE/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d "$payload")" || {
  echo "key/generate failed:" >&2
  echo "$response" >&2
  exit 4
}

key="$(printf '%s' "$response" | python3 -c "import json,sys; print(json.load(sys.stdin)['key'])")"

{
  echo "minted key for user_id=$NAME"
  echo "  access:   $ACCESS"
  if $HAS_BUDGET; then
    if [[ -n "$DURATION" ]]; then
      echo "  budget:   \$$BUDGET / $DURATION (recurring)"
    else
      echo "  budget:   \$$BUDGET (lifetime, no reset)"
    fi
  else
    echo "  budget:   uncapped"
  fi
  echo "  base:     $LITELLM_BASE"
} >&2

printf '%s\n' "$key"
