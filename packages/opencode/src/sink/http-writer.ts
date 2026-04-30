import { gzipSync } from "zlib"
import { Auth } from "@/auth"
import { Log } from "@/util/log"
import { GpdLogSpill } from "./spill"
import type { GpdLog } from "./schema"
import { ulid } from "ulid"

/**
 * POST /gpd/log through the LiteLLM proxy.
 *
 * Request shape: gzipped NDJSON body, ULID `seq` query param, one HTTP
 * POST per flush. LiteLLM's `Depends(user_api_key_auth)` authenticates
 * the request against the user's existing virtual key; the same proxy
 * reads the key from our Auth service (backed by `auth.json`).
 *
 * Outcomes:
 *   2xx  → done
 *   401/403 → key invalid/revoked. Spill, stop in-flight retries, caller
 *            should toast "Fix Key" via Bus event.
 *   413  → body too big. Should never happen (flush size is KB-range).
 *          Spill just in case; dev can inspect.
 *   429  → over daily byte quota. Spill, back off.
 *   5xx / network → spill, retry via replay loop.
 */
export namespace GpdLogHttp {
  const log = Log.create({ service: "gpd-log-http" })

  const LITELLM_URL =
    process.env["OPENCODE_GPD_LOG_URL"] ??
    "https://litellm-production-46bb.up.railway.app/gpd/log"

  // Exported so the upstream enqueue path (gpd-logger.ts) and the
  // revoke-side spill wipe (auth/index.ts) reference the same provider
  // ID without a magic-string drift.
  export const GPD_PROVIDER_ID = "gpd"

  export type PostOutcome =
    | { kind: "ok"; path: string; bytes: number }
    | { kind: "spilled"; reason: "auth" | "quota" | "network" | "server" | "other"; statusCode?: number }

  export type Input = {
    sessionID: string
    rootSessionID: string
    events: GpdLog.Event[]
  }

  /**
   * Serialize events → NDJSON → gzip, POST, spill on failure.
   *
   * `opts.signal` (optional) is threaded into the underlying `fetch()`.
   * On abort the fetch throws, the network-catch branch below spills the
   * body to disk for next-boot replay. Used by the shutdown-drain path
   * to bound the total wall-clock time without leaking dangling fetches.
   */
  export async function post(
    auth: Auth.Interface,
    input: Input,
    opts?: { signal?: AbortSignal },
  ): Promise<PostOutcome> {
    const seq = ulid() // 26-char Crockford base32, monotonic
    const ndjson = input.events.map((e) => JSON.stringify(e)).join("\n") + "\n"
    const body = gzipSync(Buffer.from(ndjson, "utf8"))

    // Load API key lazily — Auth.get is an Effect but we're in promise-land;
    // caller runs this Effect-wrapped, so we just expect the service instance.
    const info = await runGet(auth, GPD_PROVIDER_ID)
    if (!info || info.type !== "api") {
      log.warn("no GPD API key in auth.json; spilling", { hasInfo: !!info, type: info?.type })
      await GpdLogSpill.write(seq, spillMeta(input, seq, body.byteLength), body)
      return { kind: "spilled", reason: "auth" }
    }
    const apiKey = info.key

    const url = new URL(LITELLM_URL)
    url.searchParams.set("session", input.sessionID)
    url.searchParams.set("root_session", input.rootSessionID)
    url.searchParams.set("seq", seq)

    let res: Response
    try {
      res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/x-ndjson",
          "content-encoding": "gzip",
          "content-length": String(body.byteLength),
        },
        // Buffer is Uint8Array-compatible; runtime accepts it but DOM types
        // don't list it in BodyInit. Cast via unknown to avoid a dep on
        // undici/whatwg-fetch type packages.
        body: body as unknown as BodyInit,
        signal: opts?.signal,
      })
    } catch (e) {
      log.info("POST failed at network layer; spilling", { error: (e as Error).message })
      await GpdLogSpill.write(seq, spillMeta(input, seq, body.byteLength), body)
      return { kind: "spilled", reason: "network" }
    }

    if (res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { path?: string }
      return { kind: "ok", path: payload.path ?? "", bytes: body.byteLength }
    }

    type SpillReason = Exclude<PostOutcome, { kind: "ok" }>["reason"]
    const reason: SpillReason =
      res.status === 401 || res.status === 403
        ? "auth"
        : res.status === 429 || res.status === 413
          ? "quota"
          : res.status >= 500
            ? "server"
            : "other"

    // 400 = our bug. Log loudly, DO NOT spill — spilling just fails forever.
    if (reason === "other" && res.status < 500) {
      const txt = await res.text().catch(() => "")
      log.error("POST rejected with permanent client error", { status: res.status, body: txt })
      return { kind: "spilled", reason, statusCode: res.status }
    }

    await GpdLogSpill.write(seq, spillMeta(input, seq, body.byteLength), body)
    log.info("POST failed; spilled for retry", { status: res.status, reason })
    return { kind: "spilled", reason, statusCode: res.status }
  }

  /**
   * Retry all spilled entries. Called on boot + periodically.
   */
  export async function replay(auth: Auth.Interface): Promise<{ posted: number; remaining: number }> {
    const entries = await GpdLogSpill.list()
    if (entries.length === 0) return { posted: 0, remaining: 0 }

    log.info("replaying spill", { count: entries.length })
    const info = await runGet(auth, GPD_PROVIDER_ID)
    if (!info || info.type !== "api") {
      return { posted: 0, remaining: entries.length }
    }
    const apiKey = info.key

    let posted = 0
    for (const e of entries) {
      const body = await GpdLogSpill.readBody(e.ulid).catch(() => undefined)
      if (!body) {
        await GpdLogSpill.remove(e.ulid)
        continue
      }
      const url = new URL(LITELLM_URL)
      url.searchParams.set("session", e.meta.sessionID)
      url.searchParams.set("root_session", e.meta.rootSessionID)
      url.searchParams.set("seq", e.meta.seq)

      let res: Response
      try {
        res = await fetch(url.toString(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/x-ndjson",
            "content-encoding": "gzip",
            "content-length": String(body.byteLength),
          },
          body: body as unknown as BodyInit,
        })
      } catch {
        break // network still down; leave the rest for the next pass
      }

      if (res.ok) {
        await GpdLogSpill.remove(e.ulid)
        posted++
        continue
      }
      if (res.status === 401 || res.status === 403) {
        log.warn("replay auth failure; leaving spill intact", { status: res.status })
        break
      }
      if (res.status === 429) {
        log.info("replay quota hit; pausing until next cycle")
        break
      }
      // 4xx non-auth → server rejects this payload forever; drop it.
      if (res.status >= 400 && res.status < 500) {
        log.warn("replay permanent rejection; dropping", { status: res.status, ulid: e.ulid })
        await GpdLogSpill.remove(e.ulid)
        continue
      }
      // 5xx → keep for next pass
      break
    }

    const remaining = (await GpdLogSpill.list()).length
    return { posted, remaining }
  }

  function spillMeta(input: Input, seq: string, contentLength: number): GpdLogSpill.Meta {
    return {
      sessionID: input.sessionID,
      rootSessionID: input.rootSessionID,
      seq,
      contentLength,
      createdAt: Date.now(),
    }
  }

  /**
   * Adapter that runs the Effect-returning `Auth.get` to a Promise without
   * requiring the caller to be in Effect-land. The logger invokes us from
   * its Effect fiber, where `auth` is the extracted service interface.
   */
  async function runGet(auth: Auth.Interface, providerID: string) {
    // Auth.get returns Effect.Effect<Info | undefined, AuthError> — we run
    // it synchronously via the Effect runtime attached to the caller.
    // When called from outside an Effect context (e.g., boot replay loop),
    // we rely on the caller supplying an already-resolved `info` object.
    // To keep this helper promise-compatible, we use the Effect `runPromise`
    // export, which is safe because Auth.get has no context requirements
    // beyond the provided service (already satisfied by `auth`).
    const { Effect } = await import("effect")
    return Effect.runPromise(auth.get(providerID).pipe(Effect.orElseSucceed(() => undefined)))
  }
}
