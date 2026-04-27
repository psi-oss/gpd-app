/**
 * GPD (PSI) provider model catalog + runtime resolver.
 *
 * The picker on the frontend is driven by `provider.gpd.models` in the
 * resolved provider database. Historically this list was a static block
 * written into `~/.config/gpd/opencode.json` by the install-time Python
 * injector. That list drifted from the LiteLLM server's allow-list
 * whenever we toggled access groups (researchers saw ghost models that
 * returned 403 on use) and missed new models until the next desktop
 * release (e.g. `claude-opus-4-7`).
 *
 * The resolver below fetches the user's access-filtered model list from
 * LiteLLM's OpenAI-compatible `/v1/models` endpoint, then joins each
 * returned id against a static metadata table (display name,
 * capability flags, context/output limits) so the picker still renders
 * with correct metadata. Ids returned by LiteLLM that are not in the
 * metadata table are exposed as best-effort stubs (id used as the
 * display name, default capabilities) — this means new server-side
 * additions work without a desktop release, they just look plain
 * until we ship updated metadata.
 *
 * Failure behavior:
 *   - network error / timeout / 5xx → use the full static table as
 *     fallback. Matches the pre-dynamic behavior, never a worse UX
 *     than before this file existed.
 *   - 401 / 403 → return empty. The user has no usable key; the
 *     picker goes empty and the welcome / re-auth flow handles it.
 *   - fetch returns empty list → trust the server, return empty.
 *
 * In-memory cache keyed by `${baseURL}|${apiKey}` with a 5-minute TTL
 * so `provider.list` calls don't hammer LiteLLM. Cache lives for the
 * lifetime of the sidecar process; Change-API-Key triggers
 * `global.dispose` which tears down Instance state and this cache
 * along with it.
 */

export type GpdModelMetadata = {
  name: string
  tool_call?: boolean
  reasoning?: boolean
  attachment?: boolean
  temperature?: boolean
  limit?: { context?: number; output?: number }
}

// Single source of truth for GPD model display names and capability
// flags. Keep ids aligned with LiteLLM proxy model_name (not upstream
// Anthropic/OpenAI names — LiteLLM remaps). Add new entries whenever
// the LiteLLM `gpd-chat` access group gains a model; missing entries
// degrade gracefully to a stub in the picker, not an error.
export const GPD_MODEL_METADATA: Record<string, GpdModelMetadata> = {
  "claude-opus-4-7": {
    name: "Claude Opus 4.7",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 131_072 },
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 131_072 },
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 65_536 },
  },
  "claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 200_000, output: 65_536 },
  },
  "gpt-5.5": {
    name: "GPT-5.5",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 128_000 },
  },
  // NB: gpt-5.5-pro intentionally NOT listed. The Pro variant requires
  // OpenAI's /v1/responses endpoint, and LiteLLM v1.83.7-stable (our
  // pinned proxy version) doesn't include gpt-5.5-pro in its built-in
  // registry, so the chat-completions bridge can't redirect to the
  // responses endpoint at runtime — every call returns 404
  // "not a chat model". Add when LiteLLM stable picks up the model
  // (currently only in v1.83.13-nightly).
  "gpt-5.4": {
    name: "GPT-5.4",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 131_072 },
  },
  "gpt-5.4-mini": {
    name: "GPT-5.4 mini",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 131_072 },
  },
  "gpt-5.4-nano": {
    name: "GPT-5.4 nano",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 131_072 },
  },
  "gpt-5.4-pro": {
    name: "GPT-5.4 Pro",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 131_072 },
  },
  "gpt-5.3-codex": {
    name: "GPT-5.3 Codex",
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 32_768 },
  },
  "gemini-3.1-pro-preview": {
    name: "Gemini 3.1 Pro",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 65_536 },
  },
  "gemini-3.1-flash-lite-preview": {
    name: "Gemini 3.1 Flash-Lite",
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 65_536 },
  },
}

type Outcome = { ids: string[]; reason: "server" | "fallback" | "forbidden" }

type CacheEntry = { outcome: Outcome; fetchedAt: number }
const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()
const FETCH_TIMEOUT_MS = 3000

function normalizeModelsUrl(baseURL: string): string {
  // LiteLLM base URL in opencode.json is ".../v1"; the standard
  // OpenAI-compatible endpoint is `${base}/models`. Tolerate trailing
  // slash + a base that lacks /v1 (falls back to /v1/models).
  const trimmed = baseURL.replace(/\/+$/, "")
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/models`
  return `${trimmed}/v1/models`
}

async function fetchAllowedIds(baseURL: string, apiKey: string): Promise<Outcome> {
  const url = normalizeModelsUrl(baseURL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) {
      return { ids: [], reason: "forbidden" }
    }
    if (!res.ok) {
      return { ids: [], reason: "fallback" }
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    const ids = Array.isArray(body.data)
      ? body.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0)
      : []
    return { ids, reason: "server" }
  } catch {
    // Network error, DNS fail, abort-on-timeout, malformed JSON — all
    // map to "fallback". Static table is a safer default than empty.
    return { ids: [], reason: "fallback" }
  } finally {
    clearTimeout(timer)
  }
}

async function getOutcome(baseURL: string, apiKey: string): Promise<Outcome> {
  const key = `${baseURL}|${apiKey}`
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.outcome
  const outcome = await fetchAllowedIds(baseURL, apiKey)
  cache.set(key, { outcome, fetchedAt: now })
  return outcome
}

function stubMetadataFor(id: string): GpdModelMetadata {
  return { name: id, tool_call: true, attachment: true, temperature: true }
}

/**
 * Resolve the set of models to expose for the GPD provider. Shape
 * matches the `provider.models` subtree of opencode.json (which
 * provider.ts then transforms into the full Model record).
 *
 * If `apiKey` is missing or empty, skip the fetch and return the
 * static metadata table so the picker has content during the brief
 * pre-auth window.
 */
export async function resolveGpdProviderModels(
  baseURL: string | undefined,
  apiKey: string | undefined,
): Promise<Record<string, GpdModelMetadata>> {
  if (!baseURL || !apiKey) return { ...GPD_MODEL_METADATA }
  const outcome = await getOutcome(baseURL, apiKey)
  if (outcome.reason === "forbidden") return {}
  if (outcome.reason === "fallback") return { ...GPD_MODEL_METADATA }
  const result: Record<string, GpdModelMetadata> = {}
  for (const id of outcome.ids) {
    result[id] = GPD_MODEL_METADATA[id] ?? stubMetadataFor(id)
  }
  return result
}
