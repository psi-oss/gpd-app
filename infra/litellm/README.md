# GPD's LiteLLM image

Ships stock `ghcr.io/berriai/litellm:<pin>` + custom routes and a consent
gate:

- **`POST /gpd/log`** — session-log ingest to `gs://gpd-desktop-logs`. SA
  key lives only on Railway; desktop clients authenticate with their
  existing LiteLLM virtual key.
- **`POST /gpd/tos-accept`** — Terms-of-Service acceptance writer. Writes
  one append-only row per (user, version, device) to `gpd_tos_acceptance`
  in a dedicated audit Postgres (`GPD_AUDIT_DATABASE_URL`). Same
  virtual-key auth.
- **`POST /gpd/tos-revoke`** — marks every acceptance row for the user
  with `revoked_at = now()`. Does NOT delete — Art. 17(3)(e) retention.
- **`POST /gpd/feedback`** — in-app feedback / bug / feature submission.
  Same virtual-key auth. Writes one append-only row to `gpd_feedback` in
  the same audit Postgres. Body is `{"category":"bug|feature|feedback",
  "message":"...","app_version":"..."}` — server adds `user_id`,
  `token_hash_suffix`, `client_ip`, `user_agent`, `created_at`.
- **Consent gate (no route)** — `gpd_consent` registers a
  `CustomLogger` on `litellm.callbacks` that 403s every LLM API call
  (completions, embeddings, moderation, speech, transcription, pass-through
  including `/gpd/log`) when the caller's `user_id` has a non-null
  `revoked_at`. Without this gate, `/gpd/tos-revoke` would be cosmetic
  (DB row flipped, processing continues). Fails closed on audit-DB
  outage (HTTP 503).
- **Billing gate (no route)** — `gpd_billing` registers a `CustomLogger`
  that is inert by default. When `GPD_BILLING_ENABLED=true`, user-scoped
  LLM/MCP/pass-through calls reserve prepaid credits from the private GPD
  billing service before reaching providers, settle on success, and refund
  on provider failure. The public repo contains only this thin adapter;
  Stripe, pricing, and ledger authority stay in the private billing repo.

## What's in here

| File | What it does |
|---|---|
| `Dockerfile` | 4-line layer on top of stock LiteLLM |
| `gpd_log/hook.py` | `register()` entry point for `LITELLM_WORKER_STARTUP_HOOKS` — wires `/gpd/log` |
| `gpd_log/middleware.py` | Rejects requests with missing / oversized Content-Length before the body hits memory |
| `gpd_log/handler.py` | The route: auth → rate-limit → byte-quota → GCS upload |
| `gpd_log/gcs_writer.py` | `upload_from_string(if_generation_match=0)` idempotent write |
| `gpd_log/quota.py` | Per-key daily byte counter in Redis, fail-closed |
| `gpd_tos/hook.py` | `register()` entry — wires `/gpd/tos-accept` + `/gpd/tos-revoke` + runs migrations |
| `gpd_tos/handler.py` | Auth → validate version → capture IP/UA → insert row; also the revoke endpoint |
| `gpd_tos/db.py` | Lazy asyncpg pool + parameterised `INSERT`/`UPDATE` helpers |
| `gpd_consent/hook.py` | `register()` entry — appends `ConsentGateLogger` to `litellm.callbacks` |
| `gpd_consent/consent_gate.py` | `CustomLogger.async_pre_call_hook` — 403 on revoked, 503 on DB outage |
| `gpd_consent/db.py` | Reuses `gpd_tos.db` pool to query newest acceptance row |
| `gpd_consent/cache.py` | Per-worker TTL dict (300s) + `invalidate(user_id)` called from `/gpd/tos-revoke` |
| `gpd_billing/hook.py` | Optional prepaid-credit reserve/settle/refund callback |
| `gpd_billing/client.py` | Secret-free HTTP adapter for the private billing service |
| `tests/` | pytest + testcontainers harness for the consent gate, run via `.github/workflows/litellm-server-tests.yml` |

## Consent-gate propagation

The gate's TTL cache is **per worker, per process**. A `/gpd/tos-revoke`
call invalidates the cache entry on the handling worker immediately, but
other workers continue serving cached "not revoked" state until the TTL
(default 300s) expires. Net effect: a revoked user can be served for up
to 5 minutes by workers other than the one that handled the revoke.

If legal requires immediate global invalidation, swap
`gpd_consent/cache.py` for a Redis-backed variant where revoke PUBLISHes
an eviction message and workers SUBSCRIBE on startup.

## One-time GCP setup

Set your project ID and bucket name as shell variables first, then run the
commands below. The bucket name you pick here becomes the `GPD_LOG_BUCKET`
env var the server reads at runtime.

```bash
# Replace with your own values:
GCP_PROJECT=<your-gcp-project-id>
LOG_BUCKET=<your-bucket-name>        # e.g. <project>-gpd-desktop-logs

# SA scoped to write-only on one bucket — no list, no read, no delete.
gcloud iam service-accounts create gpd-log-writer --project="$GCP_PROJECT" \
  --display-name="GPD LiteLLM-side log writer"

gcloud storage buckets add-iam-policy-binding "gs://$LOG_BUCKET" \
  --member="serviceAccount:gpd-log-writer@$GCP_PROJECT.iam.gserviceaccount.com" \
  --role=roles/storage.objectCreator

gcloud iam service-accounts keys create /tmp/gpd-log-writer-key.json \
  --iam-account="gpd-log-writer@$GCP_PROJECT.iam.gserviceaccount.com" \
  --project="$GCP_PROJECT"

# Print for pasting into Railway:
cat /tmp/gpd-log-writer-key.json | jq -c .   # single-line JSON for env var
shred -u /tmp/gpd-log-writer-key.json         # destroy local copy
```

## Railway configuration

1. **Switch the LiteLLM service from "Docker image" mode to "Dockerfile" mode.**
   Settings → Source → point at this repo, root directory `infra/litellm/`.
2. **Add env vars** (Settings → Variables):
   ```
   GOOGLE_APPLICATION_CREDENTIALS_JSON = <paste SA JSON from step above>
   GPD_LOG_BUCKET = <the bucket name you created above>
   GPD_USER_HASH_PEPPER = <64 hex chars — generate once, NEVER rotate>
   GPD_LOG_BYTES_PER_DAY = 10737418240   # 10 GiB/day/key (optional; default)

   # Optional prepaid billing gate. Leave disabled until the private billing
   # service URL/token are provisioned in Railway or GCP Secret Manager.
   GPD_BILLING_ENABLED = false
   GPD_BILLING_BASE_URL = https://<private-billing-service>
   GPD_BILLING_SERVICE_TOKEN = <private service token>
   GPD_BILLING_TIMEOUT_SECONDS = 5
   GPD_BILLING_EMERGENCY_BYPASS = false

   # Generate pepper:
   #   python -c 'import secrets; print(secrets.token_hex(32))'
   # Store it in Railway env only. Rotation orphans all existing GCS
   # objects (user_hash in paths uses the pepper). If you rotate, you
   # must also delete every old user=*/ prefix.
   #
   # Existing vars stay untouched: DATABASE_URL, LITELLM_MASTER_KEY,
   # REDIS_URL (or REDIS_HOST / REDIS_PASSWORD), STORE_MODEL_IN_DB, etc.
   ```
   `LITELLM_WORKER_STARTUP_HOOKS` is baked into the Dockerfile, so don't
   set it as a Railway env var (would double-register the route).
3. **Click Redeploy.** Railway rebuilds the image (~30s), the hook fires
   during worker startup, and the `/gpd/log` route becomes live.

## Verification

After deploy, with a valid LiteLLM virtual key:

```bash
KEY=sk-<your-key>
BASE=<your-litellm-base-url>   # e.g. https://<service>.up.railway.app
SEQ=$(python -c 'import secrets, time; import string; \
  alpha="0123456789ABCDEFGHJKMNPQRSTVWXYZ"; \
  print("".join(secrets.choice(alpha) for _ in range(26)))')

# Small test body (gzipped NDJSON)
echo '{"kind":"test","ts":1}' | gzip | curl -sS -X POST \
  "$BASE/gpd/log?session=ses_test&root_session=ses_test&seq=$SEQ" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Encoding: gzip" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @- \
  | jq

# Expected: {"ok": true, "path": "user=.../session=ses_test/parts/<SEQ>.jsonl.gz", "bytes": N}

# Check the object landed
gcloud storage cat "gs://$GPD_LOG_BUCKET/user=*/date=$(date -u +%Y-%m-%d)/session=ses_test/parts/$SEQ.jsonl.gz" \
  | gunzip
```

Negative tests:

```bash
# Missing key → 401
curl -sS -X POST "$BASE/gpd/log?session=s&seq=$SEQ" -H "Content-Length: 10" -d abc
# Revoked key → 401 (after LiteLLM cache TTL)
# Missing Content-Length → 411
# Oversize Content-Length (>64MB) → 413
# Malformed seq → 400
# Over daily byte quota → 429
```

## Client-side mapping

Client POSTs `POST /gpd/log` with:

- `Authorization: Bearer <virtual key>`
- `Content-Encoding: gzip`
- `Content-Type: application/x-ndjson`
- Query: `session=<id>&root_session=<id>&seq=<ULID>`
- Body: gzipped NDJSON — one `GpdLog.Event` per line

The server writes the object to:
```
gs://$GPD_LOG_BUCKET/user=<hashed_user_id>/date=YYYY-MM-DD/session=<root_id>/parts/<seq>.jsonl.gz
```
or for subagents:
```
gs://$GPD_LOG_BUCKET/user=<hashed_user_id>/date=YYYY-MM-DD/session=<root_id>/subagents/agent-<child_id>/parts/<seq>.jsonl.gz
```

A nightly compactor (separate service) fuses `parts/*.jsonl.gz` into
a single `root.jsonl.gz` per session per day, using GCS `Objects.compose()`
in 32-at-a-time batches.

## TOS acceptance — one-time DDL before deploy

`/gpd/tos-accept` writes to the `gpd_tos_acceptance` table in LiteLLM's
Postgres DB. The handler assumes the table exists; the first INSERT
against a missing table returns `503 tos write failed: ...`.

Schema is applied automatically by `infra/litellm/gpd_tos/migrate.py`,
which the LiteLLM worker runs at boot. Migrations live in
`infra/litellm/gpd_tos/migrations/` and are versioned (`0001_init.sql`,
`0002_privacy_sha.sql`, …). Workers run pending migrations idempotently
under an advisory lock, so a multi-replica redeploy is safe.

To apply migrations manually (e.g. against a fresh dev DB):

```bash
GPD_AUDIT_DATABASE_URL="$DATABASE_URL" \
  python -m infra.litellm.gpd_tos.migrate
```

### TOS endpoint verification

```bash
KEY=sk-<your-key>                   # must carry a user_id (non-admin)
BASE=<your-litellm-base-url>

curl -sS -X POST \
  "$BASE/gpd/tos-accept?tos_version=0.0-placeholder&app_version=1.1.10" \
  -H "Authorization: Bearer $KEY" \
  -H "User-Agent: smoke-test/1.0" | jq
# Expected: {"ok": true}

# Verify the row landed
railway ssh --service litellm \
  'psql "$DATABASE_URL" -c "SELECT user_id, key_last4, tos_version, client_ip, accepted_at FROM gpd_tos_acceptance ORDER BY accepted_at DESC LIMIT 5;"'
```

Negative tests:

```bash
# Missing tos_version → 400
# Master / admin key (no user_id) → 401
# tos_version > 64 chars → 400
```
