"""Reverse-lookup user_hash → user_id (plus key_alias, spend).

Production stores user_hash = hmac_sha256(GPD_USER_HASH_PEPPER, user_id)[:16]
in every GCS object path and every BigQuery row. The pepper lives only in
Railway's litellm service env, so the reverse map can only be computed
there.

Run via:
    cat infra/litellm/scripts/lookup-user-hash.py | \\
      railway ssh --service litellm 'cat > /tmp/lookup.py && python /tmp/lookup.py [args]'

Args:
    --hash=<16hex>       Filter output to a single target hash (one row,
                         empty if no match). Combine with --all-keys to
                         also surface unaliased keys.
    --user-id=<id>       Just probe one user_id (no DB read) and print the
                         resulting hash. Useful for verifying the canary
                         (`--user-id=gpd-smoke-canary`).
    --all-keys           Include rows where the user_id only appears in
                         LiteLLM_VerificationToken (e.g. virtual keys not
                         joined to a UserTable row).
    --top=<N>            Sort by spend desc, print top N (default 50).
                         Ignored if --hash or --user-id is set.

Output format (TSV, sorted by spend desc):
    user_hash<TAB>user_id<TAB>key_alias<TAB>spend<TAB>max_budget<TAB>last_active_at
"""
import asyncio
import hashlib
import hmac
import os
import sys

import asyncpg

USAGE = __doc__


def parse_args() -> dict:
    out = {"hash": None, "user_id": None, "all_keys": False, "top": 50}
    for a in sys.argv[1:]:
        if a.startswith("--hash="):
            out["hash"] = a[len("--hash="):].strip().lower()
        elif a.startswith("--user-id="):
            out["user_id"] = a[len("--user-id="):]
        elif a == "--all-keys":
            out["all_keys"] = True
        elif a.startswith("--top="):
            out["top"] = int(a[len("--top="):])
        elif a in ("-h", "--help"):
            print(USAGE)
            sys.exit(0)
        else:
            print(f"unknown arg: {a}\n", file=sys.stderr)
            print(USAGE, file=sys.stderr)
            sys.exit(2)
    if out["hash"] and not (len(out["hash"]) == 16 and all(c in "0123456789abcdef" for c in out["hash"])):
        print("--hash must be 16 hex chars (first 16 of hmac_sha256)", file=sys.stderr)
        sys.exit(2)
    return out


def derive_hash(pepper: bytes, user_id: str) -> str:
    return hmac.new(pepper, user_id.encode("utf-8"), hashlib.sha256).hexdigest()[:16]


async def main() -> int:
    args = parse_args()

    pepper_hex = os.environ.get("GPD_USER_HASH_PEPPER")
    if not pepper_hex:
        print("ERROR: GPD_USER_HASH_PEPPER not set (must run on Railway litellm service)", file=sys.stderr)
        return 2
    pepper = bytes.fromhex(pepper_hex)

    # --user-id: no DB read, just compute and exit.
    if args["user_id"] is not None:
        print(derive_hash(pepper, args["user_id"]))
        return 0

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 2
    if "?" in db_url:
        db_url = db_url.split("?", 1)[0]

    conn = await asyncpg.connect(db_url)
    try:
        # UserTable rows (spend = aggregated across all of this user's keys
        # in current LiteLLM versions; key_alias picks any one alias).
        user_rows = await conn.fetch(
            'SELECT user_id, max_budget, spend, COALESCE(updated_at, created_at) AS last_active_at '
            'FROM "LiteLLM_UserTable" WHERE user_id IS NOT NULL AND user_id <> \'\'',
        )
        users = {
            r["user_id"]: {
                "key_alias": None,
                "max_budget": r["max_budget"],
                "spend": float(r["spend"] or 0),
                "last_active_at": r["last_active_at"],
            }
            for r in user_rows
        }

        # Decorate with the first non-null key_alias we see per user_id.
        token_rows = await conn.fetch(
            'SELECT user_id, key_alias, spend, max_budget, '
            'COALESCE(updated_at, created_at) AS last_active_at '
            'FROM "LiteLLM_VerificationToken" '
            'WHERE user_id IS NOT NULL AND user_id <> \'\'',
        )
        for r in token_rows:
            uid = r["user_id"]
            row = users.get(uid)
            if row is None:
                if not args["all_keys"]:
                    continue
                users[uid] = {
                    "key_alias": r["key_alias"],
                    "max_budget": r["max_budget"],
                    "spend": float(r["spend"] or 0),
                    "last_active_at": r["last_active_at"],
                }
                continue
            if row["key_alias"] is None and r["key_alias"]:
                row["key_alias"] = r["key_alias"]

        # Compute hash for every user_id (in-process: cheap, no per-call SQL).
        results = []
        for uid, meta in users.items():
            results.append({
                "user_hash": derive_hash(pepper, uid),
                "user_id": uid,
                "key_alias": meta["key_alias"] or "",
                "spend": meta["spend"],
                "max_budget": meta["max_budget"],
                "last_active_at": meta["last_active_at"],
            })

        # Filter / sort.
        if args["hash"]:
            results = [r for r in results if r["user_hash"] == args["hash"]]
            if not results:
                print(f"# no match for hash {args['hash']}", file=sys.stderr)
                print(f"# scanned {len(users)} user_ids; ensure the target user has "
                      f"a row in LiteLLM_UserTable (pass --all-keys to also scan "
                      f"orphan VerificationToken rows)", file=sys.stderr)
                return 1
        else:
            results.sort(key=lambda r: r["spend"], reverse=True)
            results = results[: args["top"]]

        # Output.
        print("user_hash\tuser_id\tkey_alias\tspend\tmax_budget\tlast_active_at")
        for r in results:
            print(
                f"{r['user_hash']}\t{r['user_id']}\t{r['key_alias']}\t"
                f"{r['spend']:.4f}\t{r['max_budget'] if r['max_budget'] is not None else ''}\t"
                f"{r['last_active_at'].isoformat() if r['last_active_at'] else ''}"
            )
        return 0
    finally:
        await conn.close()


sys.exit(asyncio.run(main()) or 0)
