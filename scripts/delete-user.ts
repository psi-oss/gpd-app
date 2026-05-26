#!/usr/bin/env bun
/**
 * GDPR per-user deletion.
 *
 * Purges a user's data from every persistence layer:
 *   1. GCS: rm -r gs://$GPD_LOG_BUCKET/user=<hash>/
 *   2. BigQuery: DELETE FROM <project>.<dataset>.sessions WHERE user_hash = <hash>
 *   3. LiteLLM Postgres: DELETE FROM gpd_tos_acceptance WHERE user_id = <id>
 *      (requires plain user_id; indexed by id, not hash)
 *   4. LiteLLM: POST /user/delete (removes virtual keys, spend records)
 *
 * Runs as the shell user's gcloud + bq credentials. Requires --confirm to
 * prevent accidents; defaults to dry-run so you can see what would be
 * deleted first.
 *
 * Configuration: defaults read from env vars so operators don't have to
 * bake deployment-specific names into every invocation. Every value can
 * also be overridden via CLI flag.
 *
 *   GPD_LITELLM_BASE        (default: empty — must be passed via --litellm-base)
 *   GPD_LOG_BUCKET          (default: empty — must be passed via --bucket)
 *   GPD_BQ_PROJECT          (default: empty — must be passed via --bq-project)
 *   GPD_BQ_DATASET          (default: "gpd_logs")
 *   GPD_USER_HASH_PEPPER    (hex; required only when using --user-id)
 *
 * user_hash derivation matches the server: HMAC-SHA256(pepper, user_id)[:16]
 * (see infra/litellm/gpd_log/handler.py). Bare sha256(user_id) — what this
 * script computed before — does NOT match production paths and would cause
 * a silent no-op delete. Prefer pre-computing the hash on the Railway
 * litellm service (`infra/litellm/scripts/lookup-user-hash.py
 * --user-id=...`) and passing --user-hash here.
 *
 * Usage:
 *   bun scripts/delete-user.ts --user-hash=<16 hex chars> \
 *     --litellm-base=... --bucket=... --bq-project=...
 *
 *   # Or, if the pepper is available locally:
 *   GPD_USER_HASH_PEPPER=<hex> GPD_LITELLM_BASE=... GPD_LOG_BUCKET=... \
 *     GPD_BQ_PROJECT=... bun scripts/delete-user.ts --user-id=<plain user id>
 *
 *   Add --confirm to actually delete.
 *   Add --litellm-master-key=<sk-...> to also purge the LiteLLM records.
 */
import crypto from "crypto"
import { spawnSync } from "child_process"

function die(msg: string): never {
  console.error(`delete-user: ${msg}`)
  process.exit(2)
}

function arg(name: string): string | undefined {
  const flag = `--${name}=`
  const raw = process.argv.find((a) => a.startsWith(flag))
  return raw ? raw.slice(flag.length) : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function hashUserId(userId: string, pepperHex: string): string {
  if (!/^[0-9a-fA-F]+$/.test(pepperHex) || pepperHex.length % 2 !== 0) {
    die("GPD_USER_HASH_PEPPER must be a hex string with even length")
  }
  const pepper = Buffer.from(pepperHex, "hex")
  if (pepper.length === 0) die("GPD_USER_HASH_PEPPER must be non-empty hex bytes")
  return crypto.createHmac("sha256", pepper).update(userId, "utf8").digest("hex").slice(0, 16)
}

function run(cmd: string, args: string[], opts: { capture?: boolean } = {}): string {
  const res = spawnSync(cmd, args, {
    stdio: opts.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  })
  if (res.status !== 0) die(`${cmd} ${args.join(" ")} → exit ${res.status}`)
  return (res.stdout ?? "").trim()
}

const userId = arg("user-id")
const userHashArg = arg("user-hash")
const confirm = flag("confirm")
const litellmMasterKey = arg("litellm-master-key") ?? process.env.LITELLM_MASTER_KEY
const litellmBase = arg("litellm-base") ?? process.env.GPD_LITELLM_BASE
const bucket = arg("bucket") ?? process.env.GPD_LOG_BUCKET
const bqProject = arg("bq-project") ?? process.env.GPD_BQ_PROJECT
const bqDataset = arg("bq-dataset") ?? process.env.GPD_BQ_DATASET ?? "gpd_logs"
const pepperHex = process.env.GPD_USER_HASH_PEPPER

if (!litellmBase) die("pass --litellm-base=... or set GPD_LITELLM_BASE")
if (!bucket) die("pass --bucket=... or set GPD_LOG_BUCKET")
if (!bqProject) die("pass --bq-project=... or set GPD_BQ_PROJECT")

if (!userId && !userHashArg) die("pass --user-id=<id> OR --user-hash=<hash>")
if (userHashArg && !/^[0-9a-f]{16}$/.test(userHashArg)) {
  die("--user-hash must be 16 hex chars (first 16 of hmac_sha256)")
}
if (userId && !pepperHex) {
  die(
    "--user-id requires GPD_USER_HASH_PEPPER in env (same value as the Railway litellm service).\n" +
      "       Alternatively, pre-compute the hash on Railway:\n" +
      "         railway ssh --service litellm 'python3 -c \"...\"'  # see infra/litellm/scripts/lookup-user-hash.py\n" +
      "       then pass --user-hash=<hash> here.",
  )
}

const userHash = userHashArg ?? hashUserId(userId!, pepperHex!)
const dryRun = !confirm

console.log(`--- GDPR delete ---`)
console.log(`  user_id:   ${userId ?? "(unknown)"}`)
console.log(`  user_hash: ${userHash}`)
console.log(`  mode:      ${dryRun ? "DRY RUN (pass --confirm to execute)" : "EXECUTING"}`)
console.log()

// 1. GCS
console.log(`[1/3] GCS: gs://${bucket}/user=${userHash}/`)
const gcsPrefix = `gs://${bucket}/user=${userHash}/`
const listing = spawnSync("gcloud", ["storage", "ls", "-r", gcsPrefix], {
  stdio: ["inherit", "pipe", "pipe"],
  encoding: "utf8",
})
if (listing.status === 0) {
  const objectLines = (listing.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("gs://") && !l.endsWith("/"))
  console.log(`      ${objectLines.length} object(s) under prefix`)
  if (!dryRun && objectLines.length > 0) {
    run("gcloud", ["storage", "rm", "-r", gcsPrefix])
    console.log(`      ✓ deleted`)
  }
} else {
  // gcloud storage ls returns exit 1 when the prefix matched nothing.
  // That's success-by-vacuous-truth for us (nothing to delete).
  console.log(`      0 objects (prefix empty)`)
}

// 2. BigQuery
console.log()
console.log(`[2/3] BigQuery: DELETE FROM ${bqProject}.${bqDataset}.sessions`)
const bqSelect = `SELECT COUNT(*) as n FROM \`${bqProject}.${bqDataset}.sessions\` WHERE user_hash = '${userHash}'`
try {
  const bqOut = run(
    "bq",
    [
      "query",
      "--format=csv",
      "--use_legacy_sql=false",
      `--project_id=${bqProject}`,
      bqSelect,
    ],
    { capture: true },
  )
  const rowCount = bqOut.split("\n").slice(1)[0]
  console.log(`      ${rowCount} row(s) matching`)
} catch {
  console.log(`      (query failed — table may not exist)`)
}
if (!dryRun) {
  run(
    "bq",
    [
      "query",
      "--use_legacy_sql=false",
      `--project_id=${bqProject}`,
      `DELETE FROM \`${bqProject}.${bqDataset}.sessions\` WHERE user_hash = '${userHash}'`,
    ],
  )
  console.log(`      ✓ deleted`)
}

// 3. Audit Postgres: PSEUDONYMIZE gpd_tos_acceptance rows.
//
// Not DELETE — GDPR Art. 17(3)(e) permits (and legal practice requires)
// retention of "I once consented" proof post-erasure. We strip
// surveillance-grade fields (client_ip, user_agent, token_hash_suffix)
// and keep the minimal row: user_id + tos_version + tos_text_sha256 +
// viewed_in_full + accepted_at + revoked_at. That's enough to answer
// "did user X consent to version Y at time Z" in a future dispute,
// without retaining identifying metadata.
console.log()
console.log(`[3/4] Audit DB: pseudonymize gpd_tos_acceptance rows for user_id=${userId ?? "(skipped — need plain user_id)"}`)
if (!userId) {
  console.log(`      skipped: gpd_tos_acceptance is indexed by plain user_id, not hash.`)
} else if (dryRun) {
  console.log(`      would UPDATE via railway ssh → python (asyncpg) against GPD_AUDIT_DATABASE_URL`)
} else {
  // asyncpg baked into the LiteLLM image (infra/litellm/Dockerfile)
  // since the TOS hook added it. Prisma rolls DDL/DML back on disconnect
  // and is unusable from a standalone script.
  const pyScript = `
import asyncio, os, sys, asyncpg

async def main():
    url = os.environ.get("GPD_AUDIT_DATABASE_URL") or os.environ["DATABASE_URL"]
    if "?" in url:
        url = url.split("?", 1)[0]
    c = await asyncpg.connect(url)
    try:
        result = await c.execute(
            """UPDATE gpd_tos_acceptance
                  SET client_ip = NULL,
                      user_agent = NULL,
                      token_hash_suffix = 'REDACTED'
                WHERE user_id = $1""",
            ${JSON.stringify(userId)},
        )
        print(f"    {result}")
    finally:
        await c.close()

asyncio.run(main())
`
  const b64 = Buffer.from(pyScript).toString("base64")
  const res = spawnSync(
    "railway",
    [
      "ssh",
      "--service",
      "litellm",
      `echo ${b64} | base64 -d > /tmp/pseudonymize-tos.py && python /tmp/pseudonymize-tos.py`,
    ],
    { stdio: "inherit", encoding: "utf8" },
  )
  if (res.status !== 0) {
    die(`railway ssh python UPDATE failed (exit ${res.status})`)
  }
  console.log(`      ✓ pseudonymized (user_id retained for legal-audit evidence)`)
}

// 4. LiteLLM virtual keys + spend records
console.log()
console.log(`[4/4] LiteLLM keys + spend for user_id=${userId ?? "(skipped — need plain user_id)"}`)
if (!userId) {
  console.log(`      skipped: LiteLLM indexes by plain user_id, not hash.`)
  console.log(`      Run this script with --user-id=<id> to also purge LiteLLM state.`)
} else if (!litellmMasterKey) {
  console.log(`      skipped: pass --litellm-master-key=<sk-...> or set LITELLM_MASTER_KEY`)
} else {
  if (dryRun) {
    console.log(`      would POST ${litellmBase}/user/delete with {user_ids:[${userId}]}`)
  } else {
    const res = await fetch(`${litellmBase}/user/delete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${litellmMasterKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ user_ids: [userId] }),
    })
    if (res.status === 404) {
      // LiteLLM returns 404 when user_id never had any records — vacuous success.
      console.log(`      ✓ no LiteLLM records for user_id=${userId} (404)`)
    } else if (!res.ok) {
      const txt = await res.text()
      die(`LiteLLM /user/delete returned ${res.status}: ${txt}`)
    } else {
      console.log(`      ✓ ${await res.text()}`)
    }
  }
}

console.log()
if (dryRun) {
  console.log(`Dry-run only. Re-run with --confirm to actually delete.`)
} else {
  console.log(`All done.`)
}
