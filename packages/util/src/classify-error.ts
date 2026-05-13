/**
 * classifyError maps a raw API error (from any provider or network layer) to
 * one of a fixed set of i18n keys under the `error.classified.*` namespace.
 *
 * Callers are responsible for translating the returned key via their own
 * i18n helper (e.g. `language.t(classifyError(err))`).
 */
export function classifyError(error: unknown): string {
  const msg = extractMessage(error)
  const status = extractStatus(error)

  // Rate limit (HTTP 429 or known rate-limit signal strings)
  if (status === 429 || containsAny(msg, ["rate_limit", "too_many_requests", "rate limit", "ratelimit"])) {
    return "error.classified.rateLimit"
  }

  // Auth failure (HTTP 401/403 or known auth-failure signal strings)
  if (
    status === 401 ||
    status === 403 ||
    containsAny(msg, ["invalid_api_key", "unauthorized", "authentication", "api key", "apikey", "forbidden"])
  ) {
    return "error.classified.auth"
  }

  // Context length overflow
  if (containsAny(msg, ["context_length", "maximum context", "context length", "too long", "context window exceeded"])) {
    return "error.classified.context"
  }

  // Timeout (ETIMEDOUT or "timeout" anywhere in the message)
  if (containsAny(msg, ["etimedout", "timeout", "timed out"])) {
    return "error.classified.timeout"
  }

  // Provider unavailable — HTTP 502/503 or a transient upstream-side failure
  // that the user can resolve by retrying or switching model/provider. Catches:
  //   - "internal server error" — LiteLLM passes through Anthropic's 500-class
  //     SSE error events as `AnthropicException - Internal server error`
  //   - "midstreamfallback" / "midstream fallback" — LiteLLM's unconditional
  //     wrapper for any mid-stream upstream failure (see
  //     streaming_handler.py:2250-2323; not actually about fallbacks)
  //   - provider exception names — `AnthropicException`, `OpenAIException`,
  //     `GeminiException`, `VertexAIException` — surface from the LiteLLM
  //     proxy when the upstream is degraded
  //   - HTTP 500 — generic upstream 5xx not already covered by 502/503
  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    containsAny(msg, [
      "service unavailable",
      "bad gateway",
      "overloaded",
      "internal server error",
      "internalservererror",
      "midstreamfallback",
      "midstream fallback",
      "anthropicexception",
      "openaiexception",
      "geminiexception",
      "vertexaiexception",
    ])
  ) {
    return "error.classified.providerUnavailable"
  }

  // Network errors (fetch failures, ECONNREFUSED, etc.)
  if (containsAny(msg, ["fetch", "econnrefused", "network", "failed to fetch", "connection refused", "enotfound"])) {
    return "error.classified.network"
  }

  // Invalid request (HTTP 400 or known invalid-request signal strings)
  if (status === 400 || containsAny(msg, ["invalid_request", "invalid request", "bad request"])) {
    return "error.classified.invalidRequest"
  }

  return "error.classified.unknown"
}

/** Extract a lowercased message string from an arbitrary error shape. */
function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase()
  if (typeof error === "string") return error.toLowerCase()
  if (typeof error === "object" && error !== null) {
    const o = error as Record<string, unknown>
    // UnknownError / NamedError shape: { data: { message: string } }
    if (typeof o.data === "object" && o.data !== null) {
      const data = o.data as Record<string, unknown>
      if (typeof data.message === "string") return data.message.toLowerCase()
    }
    // Plain { message: string }
    if (typeof o.message === "string") return o.message.toLowerCase()
    // { error: { message: string } | string }
    if (typeof o.error === "string") return o.error.toLowerCase()
    if (typeof o.error === "object" && o.error !== null) {
      const e = o.error as Record<string, unknown>
      if (typeof e.message === "string") return e.message.toLowerCase()
    }
  }
  return ""
}

/** Extract an HTTP status code from an arbitrary error shape. */
function extractStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const o = error as Record<string, unknown>
  if (typeof o.status === "number") return o.status
  if (typeof o.statusCode === "number") return o.statusCode
  if (typeof o.code === "number") return o.code
  if (typeof o.data === "object" && o.data !== null) {
    const d = o.data as Record<string, unknown>
    if (typeof d.status === "number") return d.status
    if (typeof d.statusCode === "number") return d.statusCode
  }
  return undefined
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n))
}
