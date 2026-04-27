/**
 * Verify a user-supplied GPD API key with the LiteLLM proxy BEFORE the
 * welcome screen advances to TOS acceptance.
 *
 * Why this exists: the welcome flow used to accept any non-empty string
 * and only discover the key was bogus when /gpd/tos-accept returned
 * HTTP 401 ("LiteLLM Virtual Key expected. Received=****, expected to
 * start with 'sk-'."). The user had already read + agreed to legal
 * text under a key the proxy will reject — wrong sequence, confusing
 * error message. We now verify against the proxy first.
 *
 * Endpoint: GET /v1/models is the OpenAI-compatible model-list surface.
 * Every valid GPD virtual key has at least the `gpd-chat` access group,
 * so a 200 with at least one model in `data` confirms the key is real
 * AND has model access. A 401 means LiteLLM rejected the key (wrong
 * format, revoked, or unknown). Other 4xx/5xx are network/proxy issues
 * we surface separately so the user can distinguish "wrong key" from
 * "internet down".
 *
 * Hard-codes the same base URL as tos-accept.ts. If that moves to an
 * env-var, update both sites.
 */
const LITELLM_BASE_URL = "https://litellm-production-46bb.up.railway.app"

export type KeyValidationResult =
  | { ok: true }
  | { ok: false; reason: "invalid_key"; httpStatus: number; detail?: string }
  | { ok: false; reason: "network_error"; httpStatus?: number; detail?: string }

/**
 * Probe LiteLLM `/v1/models` with the candidate key. Returns:
 *   - { ok: true } when 200 + at least one model is visible.
 *   - { ok: false, reason: "invalid_key", httpStatus: 401|403 } when the
 *     proxy explicitly rejects the bearer token.
 *   - { ok: false, reason: "network_error" } for everything else
 *     (5xx, timeout, fetch failure, bad TLS, captive portal).
 *
 * Times out after `timeoutMs` (default 10 s) so a hung proxy doesn't
 * lock the user on the welcome screen.
 */
export async function validateGpdKey(
  key: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<KeyValidationResult> {
  const timeoutMs = opts?.timeoutMs ?? 10_000

  // AbortController so the fetch can be cancelled if the caller's signal
  // aborts OR our own timeout fires. We don't trust the user's signal
  // alone — a stuck proxy with a never-aborting parent would hang.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  if (opts?.signal) {
    if (opts.signal.aborted) ac.abort()
    else opts.signal.addEventListener("abort", () => ac.abort(), { once: true })
  }

  try {
    const res = await fetch(`${LITELLM_BASE_URL}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: ac.signal,
    })

    if (res.status === 401 || res.status === 403) {
      // Proxy explicitly rejected. Try to surface its detail string so
      // the user knows whether the issue is "wrong format", "revoked",
      // or "no model access" — but ALWAYS classify as invalid_key.
      let detail: string | undefined
      try {
        const body = (await res.json()) as {
          detail?: string
          error?: { message?: string }
        }
        detail = body.detail ?? body.error?.message
      } catch {
        // non-JSON body; OK
      }
      return { ok: false, reason: "invalid_key", httpStatus: res.status, detail }
    }

    if (!res.ok) {
      // 5xx, 429, etc. — proxy is reachable but unhappy. Distinct from
      // "invalid key" so the user can retry without changing input.
      return {
        ok: false,
        reason: "network_error",
        httpStatus: res.status,
        detail: `proxy returned HTTP ${res.status}`,
      }
    }

    // 200. Confirm we actually got a non-empty model list. A wired-up
    // proxy with an empty access group would technically return 200
    // with `data: []`, which means the key is "valid" but useless;
    // treat that as invalid_key so the user gets a clear message
    // rather than landing in TOS and discovering empty model picker.
    let parsed: { data?: unknown[] } | null = null
    try {
      parsed = (await res.json()) as { data?: unknown[] }
    } catch {
      return {
        ok: false,
        reason: "network_error",
        httpStatus: res.status,
        detail: "proxy returned non-JSON response",
      }
    }
    if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0) {
      return {
        ok: false,
        reason: "invalid_key",
        httpStatus: res.status,
        detail: "key has no model access",
      }
    }

    return { ok: true }
  } catch (err) {
    // AbortError (our timeout or caller's), TypeError (fetch failure),
    // DOMException, etc. All map to network_error. The original
    // message is preserved in detail for debug.
    const detail =
      err instanceof Error
        ? err.name === "AbortError"
          ? `request timed out after ${timeoutMs}ms`
          : err.message
        : String(err)
    return { ok: false, reason: "network_error", detail }
  } finally {
    clearTimeout(timer)
  }
}
