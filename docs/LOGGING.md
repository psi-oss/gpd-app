# GPD session logging

**Audience:** future engineers / agents making changes here. This doc is the
single source of truth for *why* the logging stack looks the way it does and
*where* to poke at it. Operational setup commands live in
`infra/litellm/README.md`, `infra/bigquery/README.md`, and the scripts under
`scripts/`.

> **Scope note for forks.** Concrete infrastructure names below
> (Railway service URL, GCP project `gpd-desktop`, bucket
> `gpd-desktop-logs`, BigQuery dataset `gpd_logs`) reflect PSI-GPD's
> operational deployment. A downstream fork running its own GPD
> substitutes its own names — the script defaults read from the
> `GPD_LITELLM_BASE`, `GPD_LOG_BUCKET`, `GPD_BQ_PROJECT`, and
> `GPD_BQ_DATASET` env vars so nothing is hard-coded at runtime.

> **Legal prerequisite:** every user must accept the GPD Terms of Service
> before any session data is logged. The in-app gate
> (`packages/app/src/components/welcome-screen.tsx` +
> `tos-upgrade-gate.tsx`) POSTs to `/gpd/tos-accept` on LiteLLM before it
> writes the LiteLLM virtual key into `auth.json`. A user whose TOS
> assent is not on file cannot reach the main IDE, so the sidecar
> (which is what emits Bus events into `gpd-logger.ts`) never starts.
> Server-side acceptance rows are stored in the
> `gpd_tos_acceptance` Postgres table (see
> `infra/litellm/gpd_tos/` — schema lives under
> `gpd_tos/migrations/`, applied at worker boot via
> `gpd_tos/migrate.py`).
> GDPR deletion cascades through `scripts/delete-user.ts`.

---

## TL;DR

Every GPD Desktop session is streamed, as it happens, to
`gs://gpd-desktop-logs`, then rolled up into BigQuery. Desktop clients
authenticate with their existing LiteLLM virtual key — **no GCS credentials
ship with the app.** The SA key that writes to the bucket lives only on
Railway next to LiteLLM.

```
OpenCode session (SQLite, per-part, already exists)
        │
        │ Bus events: Session.Updated, MessageV2.Updated, PartUpdated,
        │              Session.Diff, Session.Deleted
        ▼
packages/opencode/src/sink/gpd-logger.ts        (bus sink, mirrors ShareNext)
        │
        │ 1 s debounced flush, per-session coalesce,
        │ gzip NDJSON body, atomic disk spill on failure
        ▼
POST https://litellm-production-46bb.up.railway.app/gpd/log
  Authorization: Bearer <user's LiteLLM virtual key>
  Content-Encoding: gzip
  ?session=<id>&root_session=<id>&seq=<ULID>
        │
        ▼
LiteLLM proxy on Railway (pinned release + LITELLM_WORKER_STARTUP_HOOKS)
  1. Content-Length ≤ 64 MB gate
  2. Depends(user_api_key_auth)   — validates key, handles revocation/expiry
  3. Reject keys with null/empty user_id (401)
  4. proxy_logging_obj.pre_call_hook — reuses RPM/TPM limiter
  5. Redis per-key daily byte quota (fail-closed, default 10 GiB/day)
  6. user_hash = hmac_sha256(pepper, user_id)[:16]  (server-derived, peppered)
  7. Idempotent GCS upload (if_generation_match=0)
        │
        ▼
gs://gpd-desktop-logs/
  user=<hash>/date=YYYY-MM-DD/session=<root>/
    parts/<ULID>.jsonl.gz                         (one object per flush)
    subagents/agent-<child>/parts/<ULID>.jsonl.gz (flat, not nested by depth)
        │
        ▼
BigQuery gpd_logs.sessions_external (Hive-partitioned on user, date)
        │
        │ 6h scheduled transfer (today only) — 03-materialize.sql
        ▼
BigQuery gpd_logs.sessions (partition ingest_date, cluster user_hash+session_id)
  + sessions_text_index SEARCH index on string cols
```

---

## Why we're here

Physics researchers using GPD Desktop generate long, subagent-heavy research
sessions (confirmed: one Claude Code session with **2,671 subagents / 2.5 GB**
on disk). PSI needs every session persisted to GCS for:

1. **Ops / debug** — "Prof X says the derivation at time T was wrong; show me
   the transcript."
2. **Billing reconciliation** — match LiteLLM spend vs. upstream
   Anthropic/OpenAI/Google invoices.
3. **Abuse detection** — "Which virtual keys are burning spend, and on what?"
4. **Compliance** — per-user GDPR deletion, retention policies.
5. **Fine-tuning / research output** — extract aggregate stats, curate Q&A
   datasets.

The design goals that fell out:

- **O(N) storage** per session — no O(N²) repetition of system prompt / tool
  catalog per turn.
- **Subagent-tree correlation** — every subagent's logs traceable to the
  same root session.
- **Zero user-visible latency** — logging is off the chat critical path; if
  GCS is down the session still works, flushes spill to disk.
- **SQL analytics via BigQuery** — cheap at our scale, zero extra ops surface.
- **Per-user GDPR deletion** — user-partitioned path prefix makes `rm -r` by
  user_hash a one-liner.

---

## Decisions (and what we rejected)

### HMAC with a pepper, not bare SHA256, for user_hash
Bare `sha256(user_id)[:16]` is only 64 bits and trivially reversible
given the LiteLLM user table: anyone with bucket-read access who leaks
`SELECT user_id FROM LiteLLM_UserTable` can enumerate the (user_id →
user_hash) mapping in seconds. We use `hmac_sha256(pepper, user_id)`
where `pepper` (`GPD_USER_HASH_PEPPER`, 32 random bytes hex-encoded) is
a Railway-resident env var. Without the pepper the mapping is
intractable.

**Threat model protected:** bucket-read compromise + LiteLLM user-table
leak. Attacker sees the hashes but can't map them to user identities.

**Threat model NOT protected:** Railway admin compromise. Attacker
gets the pepper + user table + bucket contents → full mapping.
Accepted — if Railway is compromised, the SA key is too.

**Pepper rotation orphans every existing GCS object** (path prefixes
use the pepper; old paths unreachable via new pepper). Do not rotate
unless you also `gcloud storage rm -r gs://gpd-desktop-logs/**` to
start fresh. The handler raises at boot if the env var is unset, so
you can't accidentally ship a deploy with no pepper.

### Don't bake the GCS SA key into the Tauri bundle
Initial plan was `include_str!("gpd-log-writer-key.json")` in `lib.rs`. That
means anyone who unpacks the `.app` gets `storage.objectCreator` on
`gs://gpd-desktop-logs`. Scoped no-read / no-list / no-delete, but still
lets an attacker:
- Write arbitrary garbage (pollutes BigQuery, DoS storage $)
- Spam 10 GB/day of junk (denial-of-wallet)
- Impersonate other users by writing under `user=<otherHash>/`

"Only objectCreator" does not mitigate any of those. The cost of switching
to Option A (route through LiteLLM) is small; the security story is much
cleaner.

### Route logs through LiteLLM (Option A), not a dedicated Cloud Run sidecar
Considered four architectures (labeled A–D in the original plan):

- **A — Log through LiteLLM** (picked)
- B — Dedicated Cloud Run log-ingest service that validates the key against
  LiteLLM's `/key/info`
- C — LiteLLM-side `CustomLogger` only (skips the OpenCode-side richness —
  loses ~40% of what we capture today)
- D — GCS signed URLs minted per-flush by LiteLLM (extra RTT per flush)

A won because: the client already holds a LiteLLM virtual key, the auth
path is already battle-tested for every LLM call, and LiteLLM already
knows how to talk to GCS (it ships a `gcs_bucket` callback internally).
Minimal new ops surface.

### Tiny Dockerfile fork, not start-command `curl` loader
Considered having LiteLLM `curl` the hook module from a config GCS bucket
at boot (zero Dockerfile fork), but that couples container startup to
config-bucket reachability. The trivial 3-line `FROM` + `COPY` Dockerfile
is simpler to reason about. Railway's `railway up` from `infra/litellm/`
rebuilds the image; the `FROM ...:main-stable` rolling tag picks up
upstream LiteLLM updates each redeploy.

### One object per flush, not one per session
GCS has a 1-write/sec-per-object ceiling. During subagent fan-out (10
subagents flushing at 1 s cadence) we'd blow through that if everyone
wrote to the same `root.jsonl.gz`. Instead each flush gets its own
`parts/<ULID>.jsonl.gz`. A nightly compactor (see "Compactor" below) fuses
them via `Objects.compose()` into a single `root.jsonl.gz` per session
per day.

**ULID naming, not sequential integers.** ULIDs sort lexicographically ==
chronologically, are unique across client restarts without any shared
counter, and let us go straight to GCS without a distributed sequence
service.

### OpenAI `metadata` field for session-id correlation, not custom headers
Phase 1 threads `gpd_session_id` / `gpd_parent_session_id` /
`gpd_root_session_id` / `gpd_agent` into the OpenAI-compatible request
body's `metadata` field on every LLM call. LiteLLM auto-records these
into `proxy_server_request.metadata.*` in its spend logs, so a BigQuery
join between spend_logs and `gpd_logs.sessions` on `gpd_root_session_id`
lets us answer "what did subagent X cost on this session?" without
needing custom LiteLLM surgery.

Verified empirically against `/spend/logs/ui?request_id=<id>`.
`@ai-sdk/openai-compatible` spreads any unknown key in
`providerOptions[providerID]` onto the top-level request body, so
`providerOptions.gpd.metadata = {...}` lands as `body.metadata = {...}`.

### Whitelist `/gpd/log` as an LLM route on LiteLLM
`RouteChecks.non_proxy_admin_allowed_routes_check` rejects any route not
in `openai_routes / anthropic_routes / google_routes / mcp_routes / etc.`
for non-admin virtual keys. Our hook monkey-patches
`LiteLLMRoutes.openai_routes.value.append("/gpd/log")` so virtual keys
pass the check. We intentionally do NOT set `cost_per_request` on the
route, so log writes don't charge against the user's LLM budget.

### Today-only materialize, every 6h
Original plan had yesterday + today scans every hour. With no real users
yet there's no midnight-spanning-session problem to solve, and every
additional hour of lookback 2× the scanned bytes (BigQuery bills on
uncompressed). We picked:
- **Every 6h** — max 6h lag before a session shows up in the clustered
  table. Fine for ops/debug.
- **Today only** — 4× fewer bytes scanned per run. Comments in
  `03-materialize.sql` point to the two windows to widen once sessions
  actually span midnight.

### Content-hash dedup (Phase 5) — DEFERRED
The 45× storage reduction Agent 1 projected was calculated against Claude
Code's JSONL shape, which writes the full `proxy_server_request` body
(system prompt + all tool schemas) every turn. **Our Bus-event capture
doesn't include those at all.** `MessageV2.Event.Updated` and
`PartUpdated` carry message/part state only, not the assembled LLM
request. So the O(N²) growth that dedup was meant to eliminate doesn't
exist in our schema; dedup would at best save a few percent.

Reactivate Phase 5 if we add a parallel LiteLLM callback that logs
assembled request bodies (see "Future work" below).

### Admin viewer (Phase 6) — DEFERRED
BigQuery Studio + `gcloud storage cat` is enough for engineers. Revisit
when a non-engineer needs self-serve audit.

---

## What's where

### Client side (TypeScript, ships in the sidecar)

| File | What it does |
|---|---|
| `packages/opencode/src/sink/schema.ts` | `GpdLog.Event` union — one type per logged event kind (`session_init`, `message_updated`, `part_updated`, `session_diff`, `session_deleted`, `session_close`) |
| `packages/opencode/src/sink/gpd-logger.ts` | The Service. Mirrors `share-next.ts`: subscribes to 5 Bus events, coalesces updates per-session-per-key inside a 1 s flush window, materializes events, calls `GpdLogHttp.post`. Memoises `Session.root()` per session. Spawns the boot replay + retry loop. Gated on `OPENCODE_GPD_LOGS_ENABLED=1`. |
| `packages/opencode/src/sink/http-writer.ts` | Gzip + POST through LiteLLM. Handles 401/403 (auth — stop retrying), 413 (permanent — drop), 429 (quota — back off), 5xx + network (spill for retry). ULID `seq` per flush. |
| `packages/opencode/src/sink/spill.ts` | On-disk pending queue at `~/.local/share/opencode/gpd-log-spill/`. `<ulid>.gz` + `<ulid>.meta`, tmp + fsync + rename + fsync-dir for crash safety, FIFO drop at 1 GiB. |
| `packages/opencode/src/sink/jsonl-writer.ts` | Optional local-FS mirror, activated by `OPENCODE_GPD_LOG_LOCAL_MIRROR=1`. Writes structured JSONL under `~/.local/share/opencode/gpd-session-logs/<rootSessionID>/` for dev debuggability. Off by default in production; the spill dir above is the only local-disk artifact. |
| `packages/opencode/src/session/llm.ts` | Phase 1: injects GPD metadata into the LLM call when the provider is LiteLLM-bound (includes our `gpd` provider). |
| `packages/opencode/src/session/index.ts` | `Session.root(id)` helper — walks the `parent_id` chain, bounded at 100 hops. |
| `packages/opencode/src/session/prompt.ts`, `compaction.ts` | Callers compute `rootSessionID` via `Session.root()` and pass it through `StreamInput`. Title-gen doesn't need it (runs only on root sessions). |
| `packages/opencode/src/effect/{bootstrap,app}-runtime.ts`, `packages/opencode/src/project/bootstrap.ts` | Register `GpdLogger.Service` alongside `ShareNext.Service`. |
| `packages/desktop/src-tauri/src/lib.rs` | Sets `OPENCODE_GPD_LOGS_ENABLED=1` on sidecar spawn so release builds log out of the box. Also the Phase-0 `OPENCODE_DISABLE_SHARE=1`. |
| `packages/opencode/test/sink/*.test.ts` | Bun tests for spill atomicity + JSONL writer subagent routing + tool-output spill. |

### Server side (Python, shipped via `infra/litellm/`)

| File | What it does |
|---|---|
| `infra/litellm/Dockerfile` | 3-line layer on top of `ghcr.io/berriai/litellm:main-stable`. Adds `gpd_log/` to `/app/` and sets `LITELLM_WORKER_STARTUP_HOOKS=gpd_log.hook:register`. |
| `infra/litellm/railway.json` | Forces Railway's builder to `DOCKERFILE` mode (otherwise Railpack auto-detect finds `bun.lock` and tries to build the whole monorepo). |
| `infra/litellm/gpd_log/hook.py` | The `register()` entry. Appends `/gpd/log` to `LiteLLMRoutes.openai_routes.value` and calls `app.add_api_route(...)`. Runs inside FastAPI lifespan startup. |
| `infra/litellm/gpd_log/handler.py` | The route itself. Content-Length gate → `Depends(user_api_key_auth)` → `pre_call_hook` → Redis byte quota → server-derived `user_hash` → GCS upload. |
| `infra/litellm/gpd_log/quota.py` | Per-hashed-token daily byte counter in Redis. Fail-closed on Redis outage. Default cap 1 GiB/day (override via `GPD_LOG_BYTES_PER_DAY`). |
| `infra/litellm/gpd_log/gcs_writer.py` | `upload_from_string(if_generation_match=0)` — idempotent. Treats 412 as success so client-side spill retries don't duplicate data. |
| `infra/litellm/gpd_log/compactor.py` | Nightly fuser: `parts/*.jsonl.gz` → `root.jsonl.gz` via `Objects.compose()` (32-at-a-time, two-phase for >32 parts). Run as `python -m gpd_log.compactor --yesterday`. Not currently scheduled — the nightly job is TODO. |

### Analytics (BigQuery)

| File | What it does |
|---|---|
| `infra/bigquery/01-external-table.sql` | Creates `gpd_logs.sessions_external` over the whole bucket, Hive-partitioned on `user` + `date`, `require_hive_partition_filter=true` to prevent accidental full-bucket scans. |
| `infra/bigquery/02-materialized-sessions.sql` | Creates `gpd_logs.sessions` — partition by `ingest_date`, cluster by `(user_hash, session_id)`. |
| `infra/bigquery/03-materialize.sql` | Scheduled INSERT. Today-only window, anti-dedupe via `source_object NOT IN (...)` against today's materialized rows. |
| `infra/bigquery/README.md` | Step-by-step setup commands, example queries, cost-tuning knobs. |

### GDPR + retention

| File | What it does |
|---|---|
| `infra/gcs/lifecycle.json` | 30 d → NEARLINE, 90 d → COLDLINE, 365 d → ARCHIVE, 730 d → Delete. Applied live to `gs://gpd-desktop-logs`. |
| `scripts/delete-user.ts` | `bun scripts/delete-user.ts --user-id=<id> [--confirm]`. Purges GCS prefix, BQ rows, and LiteLLM virtual keys. Dry-run by default. |

---

## Current deployed state (as of 2026-04-21)

### GCP project `gpd-desktop`
- Bucket `gs://gpd-desktop-logs` — `US-CENTRAL1`, lifecycle applied, soft-delete disabled
- Service account `gpd-log-writer@gpd-desktop.iam.gserviceaccount.com` — `roles/storage.objectCreator` only, no read/list/delete
- Project-level org policy override on `constraints/iam.disableServiceAccountKeyCreation` = `enforce: false` (org default is `enforce: true`)
- SA key exists only as the `GOOGLE_APPLICATION_CREDENTIALS_JSON` env var on Railway's `litellm` service

### Railway project `psi-gpd`
- Service `litellm`, production environment
- Source: this repo, `infra/litellm/` as build root (Dockerfile mode via `railway.json`)
- LiteLLM image pinned to `ghcr.io/berriai/litellm:v1.83.7-stable` (see Dockerfile for CVE coverage + upgrade procedure)
- Public URL: `https://litellm-production-46bb.up.railway.app`
- Env vars added for logging:
  - `GOOGLE_APPLICATION_CREDENTIALS_JSON` — inline SA JSON (gpd-log-writer)
  - `GPD_LOG_BUCKET=gpd-desktop-logs`
  - `GPD_USER_HASH_PEPPER` — 64 hex chars; **handler refuses to boot without it**
  - `GPD_LOG_BYTES_PER_DAY` — unset, defaults to 10 GiB/day/key
  - `LITELLM_WORKER_STARTUP_HOOKS` — baked into Dockerfile, **do not** also set in Railway env (would double-register)
- Redeploys: push changes to the `gpd` branch that touch `infra/litellm/`, then `railway up infra/litellm --path-as-root --service litellm --detach`, OR click Redeploy in the Railway dashboard

### BigQuery project `gpd-desktop`, dataset `gpd_logs`
- `sessions_external` — external table over `gs://gpd-desktop-logs/*`
- `sessions` — native clustered table, 730-day partition expiration
- `sessions_text_index` — SEARCH index on string cols
- Scheduled transfer config `6a32e0bb-0000-2128-9732-94eb2c1f907c` — "gpd_logs 6h materialize (today only)", runs every 6h, state `RUNNING`

### GitHub Actions workflows
- `.github/workflows/compactor.yml` — daily 03:00 UTC. Fuses yesterday's `parts/*.jsonl.gz` into one `root.jsonl.gz` per session via `Objects.compose()`. Uses SA `gpd-log-compactor@gpd-desktop` (role `roles/storage.objectUser` on the bucket), key in GH secret `GCS_COMPACTOR_SA_JSON`.
- `.github/workflows/litellm-smoke-test.yml` — runs on every push touching `infra/litellm/**`, plus Mondays 07:17 UTC, plus manual dispatch. POSTs a tiny payload to `/gpd/log` via a canary LiteLLM key stored in GH secret `LITELLM_SMOKE_CANARY_KEY` (rotate quarterly). Asserts 200 + response shape. Catches upstream LiteLLM renames breaking our monkey-patch.

### Invariant: materialize window vs compactor window
03-materialize.sql runs on **today only**; compactor runs on **yesterday**. The two windows MUST stay disjoint, or the sessions table double-ingests compacted data (different `source_object`, same event content — anti-dedupe misses it). Comments in both files call this out.

---

## Data model

### What's on the wire

Each `/gpd/log` POST body is a gzipped NDJSON stream of `GpdLog.Event`s. The
union:

```ts
type Event =
  | SessionInitEvent        // kind: "session_init"
  | MessageUpdatedEvent     // kind: "message_updated"
  | PartUpdatedEvent        // kind: "part_updated"
  | SessionDiffEvent        // kind: "session_diff"
  | SessionDeletedEvent     // kind: "session_deleted"
  | SessionCloseEvent       // kind: "session_close"
```

All events carry `ts` (ms epoch), `v` (schema version, currently 1), and
`sessionID`. `session_init` is the one event that includes
`parentSessionID` + `rootSessionID` inline; for all other events the root is
derived from the `session=<root>/` path segment at materialize time.

### Per-event field contents — what is and isn't captured

**NO redaction layer.** Tool stdout, user-pasted text, file contents,
and attachment URLs are written verbatim. Treat the bucket as having
the same sensitivity class as raw session transcripts.

| Event kind | Fields captured | Notable drops / gotchas |
|---|---|---|
| `session_init` | `sessionID`, `parentSessionID`, `rootSessionID`, and the full `Session.Info` (id, title, time, mode, agent, parent_id, token/cost counters, error state) | Share secret and internal-only bookkeeping omitted by construction of `Session.Info`. Emitted once per session the first time any event is flushed for that session. |
| `message_updated` | Full `MessageV2.Info`: role, id, timestamps, model id, request id, content parts, tokens (input/output/cache), cost in USD, error, finish reason, path (cwd, worktree root). **Assistant messages include the reasoning tokens/text the model emitted.** | The assembled outbound LLM request body (system prompt + tool schemas + message history) is NOT logged. If you need bit-exact replay, see Future Work. User messages logged verbatim — secrets pasted by the researcher will appear here. |
| `part_updated` | Full `Part`: type, id, messageID, state. For `tool`: arg JSON (every bash command, Read path, Write target, etc.), output text, tool title, per-tool metadata. For `text`: accumulated text. For `reasoning`: accumulated reasoning. For `file`: url (local `file://` path), filename, mime. | Tool args include the literal bash command strings; Read outputs include file contents; WebFetch responses include remote-fetched HTML/JSON. Binary attachments (image/pdf/audio) log only the `url` + `mime` + `filename`; the bytes themselves live in the local opencode SQLite and are never re-uploaded. |
| `session_diff` | `Snapshot.FileDiff[]` — per path: old content-hash, new content-hash, and a unified diff of text changes. | Only file contents the diff engine considered text-diffable. Binary-mode files show hash-only. |
| `session_deleted` | sessionID | Emitted when the user deletes a session client-side. |
| `session_close` | sessionID, reason (`flush` / `delete` / `shutdown`) | **Currently never emitted** — see "Session lifecycle observability" under Limitations. |

### What's in GCS

```
gs://gpd-desktop-logs/
  user=<hmac_sha256(pepper, user_id)[:16]>/
    date=YYYY-MM-DD/
      session=<rootSessionID>/
        parts/<ULID>.jsonl.gz
        subagents/agent-<childSessionID>/parts/<ULID>.jsonl.gz
        root.jsonl.gz           ← written by the nightly compactor
```

`user_hash` is **server-derived** from `user_api_key_dict.user_id`,
HMAC'd with a Railway-resident pepper. See "HMAC with a pepper" under
Decisions for the threat model. The client cannot steer which prefix
it writes under. Keys with null user_id are rejected (401), so admin
keys can't collide into a single bucket.

Tool outputs >32 KB are NOT spilled to side files on the HTTP path —
only the (opt-in, dev-only) local-FS mirror does that. Every event
lives inline in its `parts/<ULID>.jsonl.gz` object.

### What's in BigQuery

`sessions_external`: one row per NDJSON line, Hive columns (`user`, `date`)
auto-added by BigQuery.

`sessions`: same rows, but with:
- `ingest_date` promoted from path (DATE) — partition key
- `user_hash` promoted from path (STRING) — cluster key
- `session_id`, `root_session_id` regex-extracted from `_FILE_NAME` when
  absent from the payload (`REGEXP_EXTRACT(_FILE_NAME, r'/session=([^/]+)/')`)
- `source_object` — full `gs://...` URI, enables anti-dedupe and easy
  "go fetch the raw file" debugging
- `ingested_at` — materialize-run timestamp

---

## Deploying changes

### Client-side change (TypeScript)
1. Edit under `packages/opencode/src/sink/` or `packages/opencode/src/session/`.
2. `bun turbo typecheck --filter=opencode` + run bun tests if touching
   `spill.ts` / `jsonl-writer.ts`.
3. Commit to `gpd` branch; CI rebuilds the sidecar; next release ships.

### Server-side change (Python)
1. Edit under `infra/litellm/gpd_log/`.
2. Syntax check: `python3 -c 'import ast; ast.parse(open("infra/litellm/gpd_log/<file>.py").read())'`.
3. Commit to `gpd` branch.
4. Deploy: `railway up infra/litellm --path-as-root --service litellm --detach`
   (wait ~30–60s for build; LiteLLM has a brief restart during rollover).
5. Smoke test the changed path — the curl snippet in `infra/litellm/README.md`
   is reusable.

### BigQuery SQL change
1. Edit `infra/bigquery/*.sql`.
2. Dry run: `bq query --dry_run --use_legacy_sql=false --parameter='run_date:DATE:2026-04-21' < infra/bigquery/03-materialize.sql`.
3. If it's a scheduled-query change, re-create the transfer config:
   ```bash
   bq rm -f --transfer_config --project_id=gpd-desktop <OLD_ID>
   QUERY=$(cat infra/bigquery/03-materialize.sql)
   bq mk --transfer_config --data_source=scheduled_query --target_dataset=gpd_logs \
     --project_id=gpd-desktop --location=US \
     --display_name="gpd_logs 6h materialize (today only)" \
     --schedule="every 6 hours" \
     --params="$(jq -n --arg q "$QUERY" '{query: $q}')"
   ```
4. Commit.

### Adding a new LiteLLM env var
Use `railway variables --set KEY=VALUE --service litellm`. That triggers
a redeploy automatically.

---

## Operating

### Where to look when something's broken

| Symptom | First place to look |
|---|---|
| Client showing "logging disabled" or toasts about auth | `Auth.Service.get("gpd")` state. Virtual key may have been revoked. |
| LLM calls returning 403 `consent_revoked` for a specific user | Audit DB has a non-null `revoked_at` for that user_id. Check `gpd_tos_acceptance` for the newest row. If the user has re-accepted, invalidate the per-worker cache by redeploying or waiting ≤ 300s. |
| LLM calls returning 503 `consent_check_unavailable` across users | Audit DB unreachable from the LiteLLM pod. Check `GPD_AUDIT_DATABASE_URL` resolves + the `gpd_audit` service health. Gate is fail-closed by design — every worker serves 503 until the DB comes back. |
| Spill dir filling up | Network or LiteLLM down. `ls ~/.local/share/opencode/gpd-log-spill/`. Fixes itself when connectivity returns; replay loop ticks every 30 s while spill is non-empty. |
| No objects in GCS | `railway logs --service litellm -d <deployment-id>` — look for Python exceptions in `gpd_log.*`. |
| BigQuery rows not appearing | Check scheduled transfer run history: `bq show --transfer_config projects/.../transferConfigs/<ID>`. |
| Slow queries | Check you're filtering on `ingest_date` + `user_hash` — cluster prune won't help without both. |

### Checking the scheduled transfer

```bash
bq ls --transfer_config --project_id=gpd-desktop --transfer_location=us
bq show --transfer_config \
  projects/310054070437/locations/us/transferConfigs/6a32e0bb-0000-2128-9732-94eb2c1f907c
# Last N runs
bq ls --transfer_run \
  projects/310054070437/locations/us/transferConfigs/6a32e0bb-0000-2128-9732-94eb2c1f907c
```

### Force a fresh materialize run

```bash
bq query --use_legacy_sql=false --project_id=gpd-desktop \
  --parameter='run_date:DATE:'$(date -u +%Y-%m-%d) \
  < infra/bigquery/03-materialize.sql
```
Idempotent; safe to run repeatedly.

### Deleting a user (GDPR)

```bash
bun scripts/delete-user.ts --user-id=<plain user id>   # dry-run by default
bun scripts/delete-user.ts --user-id=<id> --confirm \
  --litellm-master-key=$LITELLM_MASTER_KEY              # executes
```
Purges GCS prefix, BigQuery rows, and LiteLLM virtual keys for that user_id.

---

## Cost

At steady state, scales roughly linearly with active researcher count:

| Item | 1 user | 10 researchers | 100 researchers |
|---|---|---|---|
| GCS storage | <$0.01/mo | $0.50/mo | $5/mo |
| GCS writes (Class A) | <$0.01/mo | $3/mo | $30/mo |
| BigQuery storage | <$0.01/mo | $0.30/mo | $3/mo |
| BigQuery scheduled query | $0 (free tier) | $2–5/mo | $10–30/mo |
| Railway traffic | $0 (ingress free) | $0 | ~$0 |
| **Total** | **~$0/mo** | **~$5–10/mo** | **~$50/mo** |

Single biggest cost driver: the scheduled query. BigQuery bills on
uncompressed bytes processed, and our NDJSON is roughly 5-10× larger
uncompressed.

### Knobs to tune if cost matters

| Knob | Default | Effect |
|---|---|---|
| `--schedule="every 6 hours"` | 4× runs/day | Each step down halves the cost: 6h → 12h → 24h |
| Window in `03-materialize.sql` | today only | Widening to `yesterday+today` doubles bytes scanned per run |
| `partition_expiration_days=730` on `sessions` | 2 y retention | Drop to 365 if 1y audit window is acceptable |
| Lifecycle `age: 30` → NEARLINE | 30 d hot | Drop to 7 d if queries rarely hit data that old (nearline 2× cheaper) |
| `GPD_LOG_BYTES_PER_DAY` | 10 GiB/user | Tighter cap = earlier 429 for abusive clients |

---

## Limitations / known caveats

### Transfer-Encoding: chunked is not handled correctly
If a client sends the body with `Transfer-Encoding: chunked` (and no
Content-Length), Railway's edge proxy forwards the raw chunked framing,
and FastAPI/Starlette does not dechunk before we write to GCS. Result:
the stored object has chunked framing inside the gzip stream, and
BigQuery fails to read it with "unrecognized gzip format."

**In practice this never happens** — Bun's `fetch` always sends
Content-Length. The smoke test tripped this by passing the header
explicitly with `-H "Transfer-Encoding: chunked"`. Defensive rejection
in `handler.py` would close the edge case at the cost of some ceremony;
deferred until it matters.

### Content-Length gate runs inside the handler, not as middleware
Starlette freezes its middleware stack before FastAPI lifespan startup
fires, so `app.add_middleware()` in the worker-startup hook raises
`RuntimeError: Cannot add middleware after an application has started`.
We gate on Content-Length inside `gpd_log` itself; the trade-off is that
`Depends(user_api_key_auth)` runs first and already calls
`await request.body()`, which buffers up to 64 MB in RAM before our
check fires. For the current traffic shape (KB-sized debounced flushes)
this is fine. Hardening path: pre-seed `request.scope["parsed_body"]`
via a true ASGI middleware so `user_api_key_auth` skips the body drain,
then stream with `async for chunk in request.stream()`. Implement if
large upload volume ever becomes a thing.

### Per-key USD budget doesn't fire on /gpd/log
`RouteChecks.non_proxy_admin_allowed_routes_check` gates the
`_virtual_key_max_budget_check` on `is_llm_api_route(route)`. We tell
LiteLLM `/gpd/log` is an LLM route so non-admin keys can use it, but we
don't set `cost_per_request` on it, so `spend` stays 0. This is
intentional — log writes should not eat the user's LLM budget. Team/
user/org budgets still fire via `common_checks`.

### Session lifecycle observability
Two small gaps compound to make "is session X still live or done?"
queries awkward:

- `session_close` event type exists in the schema but the logger never
  emits it. Ending a session just stops producing events. You can
  infer "done" from the `last_seen` ts of events for the session_id
  and a timeout, but it's inference.
- Sub-second staleness between the external table (where today's data
  arrives as fast as the client flushes) and the materialized table
  (refreshed every 6h) means "is this live?" can also be answered by
  "does sessions have a recent row for it" → unreliable during the
  freshness gap.

Fix path when someone actually needs this: (1) emit `session_close` on
client shutdown and when OpenCode deletes a session; (2) add a derived
view `session_status` that joins "last event ts" + "close event" + a
staleness threshold.

### Graceful shutdown flush

SIGTERM / SIGINT / normal Scope close trigger a drain of the in-memory
queue before the process exits. `packages/opencode/src/sink/gpd-logger.ts`
ships a `drainState(cache)` that materialises every pending
sessionID into a POST payload (best-effort root + skipped session_init
for not-yet-initialized sessions — Instance context is unavailable at
finalization time), then fires `GpdLogHttp.post` in bounded parallel
(concurrency 8). An `AbortController` enforces an overall budget
(`OPENCODE_GPD_SHUTDOWN_TIMEOUT_MS`, default 1500 ms); on abort the
writer's existing network-catch at `http-writer.ts:85-89` spills the
body to disk, so events land somewhere — network OR next-boot replay.

Entry points:
- `packages/opencode/src/index.ts` registers SIGTERM (Unix only) and
  SIGINT handlers that call `AppRuntime.dispose()` under a 2 s hard
  wall-clock, triggering the ManagedRuntime finalizer chain.
- The logger's own `Effect.addFinalizer` runs `drainState(cache)`
  before `Scope.close`, covering graceful yargs-driven shutdowns too.

Windows: `SIGTERM` is never delivered on Windows (Node documents it as
a no-op). `SIGINT` works only with an attached console. Abrupt
TerminateProcess / End Task kills still drop the in-memory tail —
matches behavior before Task 1.5a. Events that made it to disk via
the 1 s debounced flush or the drain spill path replay on next boot.

---

## Future work / reactivation points

- **Content-hash dedup (Phase 5)**: activate if we start logging the full
  `proxy_server_request` body (system prompt + tool schemas per turn) via
  a LiteLLM success-hook. The original Phase 5 design is preserved in
  `.claude/plans/happy-juggling-lagoon.md` for that day.
- **Admin viewer (Phase 6)**: Cloud Run + Firebase Auth restricted to
  `@psi.inc`, forking the 6 renderers under `packages/web/src/components/share/`
  plus a KaTeX renderer for physics math.
- **Bit-exact replay**: parallel LiteLLM `CustomLogger` that writes the
  exact request body (minus response body, for storage) to a 14-day sub-
  bucket, keyed on `gpd_root_session_id`. Needed only if we want to
  replay a session through a different model.
- **Emit `session_close`** (see "Session lifecycle observability" above).
- **Streaming body ingest** (see above).
- **BigQuery Dataform / DBT layer** for per-session rollup views
  (e.g., `session_summary` — one row per session_id with turn counts,
  subagent counts, total tokens). Cheaper per-query than always
  re-aggregating from the raw event table.

---

## Escape hatches

### Disable logging on a single client
Set `OPENCODE_GPD_LOGS_ENABLED=0` (or unset it) in the client's env. The
logger service short-circuits all flushes.

### Disable server-side endpoint entirely
Remove `LITELLM_WORKER_STARTUP_HOOKS` from the Dockerfile's `ENV` line
and redeploy. Route disappears; clients start spilling locally.

### Rotate the SA key
```bash
gcloud iam service-accounts keys create /tmp/new-key.json \
  --iam-account=gpd-log-writer@gpd-desktop.iam.gserviceaccount.com \
  --project=gpd-desktop
railway variables --set "GOOGLE_APPLICATION_CREDENTIALS_JSON=$(jq -c . /tmp/new-key.json)" \
  --service litellm
shred -u /tmp/new-key.json
# Disable the old key id after Railway has picked up the new one (see dashboard)
```

### Pause the scheduled materialize
```bash
# Pause (transfer config is kept, no runs)
bq update --transfer_config \
  --disable \
  projects/310054070437/locations/us/transferConfigs/6a32e0bb-0000-2128-9732-94eb2c1f907c

# Resume
bq update --transfer_config \
  --no-disable \
  projects/310054070437/locations/us/transferConfigs/6a32e0bb-0000-2128-9732-94eb2c1f907c
```

### Purge everything (nuclear)
```bash
gcloud storage rm -r gs://gpd-desktop-logs/**
bq rm -r -f --dataset gpd-desktop:gpd_logs
```
Irreversible. Don't do this in the course of normal debugging.
