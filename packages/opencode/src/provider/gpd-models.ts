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
  // Per-million-token pricing surfaced into Model.cost so the session
  // total-cost panel ($X.XX) stops reporting $0.00. Keep in lockstep with
  // models-snapshot.js cost blocks for the upstream provider/model id;
  // LiteLLM bills the upstream price 1:1 (no PSI markup at this layer).
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
  }
}

// Per-model `reasoning_effort` tier overrides. Empirically probed against
// the LiteLLM proxy on 2026-04-27 (see /tmp/reasoning-probe.log + agent
// matrix) — values that returned HTTP 400 from upstream are excluded.
//
// LiteLLM proxy version note: bumping Railway to v1.83.14.rc.1 unlocks
// opus-4-7 (was broken on v1.83.7). This table reflects the current
// end-to-end app matrix, not only minimal provider probes; tiers that pass
// direct `/v1/responses` calls but fail with the full GPD tool/system
// payload stay excluded until the app payload passes live smoke.
//
// Defaults to `["low","medium","high"]` (WIDELY_SUPPORTED_EFFORTS in
// transform.ts) when omitted. Overrides are model-id-keyed, NOT inside
// GPD_MODEL_METADATA, so dynamic models picked up from `/v1/models` that
// have no metadata still get the safe default.
export const GPD_MODEL_REASONING_EFFORTS: Record<string, readonly string[]> = {
  // fable-5 supports the full ladder. Thinking is always on (the `thinking`
  // param is omitted/adaptive — an explicit thinking.type=disabled 400s);
  // depth is controlled purely via output_config.effort=<tier>. Same
  // low→max ladder as opus-4-7. Requires the proxy `gpd-chat` access group
  // to advertise `claude-fable-5` in /v1/models before the picker shows it.
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  // opus-4-8 inherits opus-4-7's request surface (adaptive thinking +
  // output_config.effort; budget_tokens/temperature removed). Full ladder.
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  // opus-4-7 supports the full ladder. supports_max_reasoning_effort=true
  // and supports_xhigh_reasoning_effort=true in LiteLLM's model map; the
  // adapter sends thinking.type=adaptive + output_config.effort=<tier>.
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  // opus-4-6 supports `max` (only Anthropic Opus 4.6+) but not `xhigh`.
  "claude-opus-4-6": ["low", "medium", "high", "max"],
  // sonnet-4-6 / haiku-4-5 use the adaptive path; xhigh + max are not in
  // their model-map flags. Both also need `max_tokens > thinking budget`,
  // which is bounded elsewhere (see Anthropic adapter limits).
  "claude-sonnet-4-6": ["low", "medium", "high"],
  "claude-haiku-4-5": ["low", "medium", "high"],
  // 2026-05-04 live full-payload probe: low/medium/high/xhigh pass through
  // the production GPD LiteLLM proxy with streaming Responses API, app-like
  // max_output_tokens, and a padded 55-tool / 174KB request body.
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  // gpt-5.6 family (sol / terra / luna, released 2026-07-09): OpenAI
  // documents the full none→max effort ladder for all three; `none` and
  // `minimal` are not GPD tiers. Probed live 2026-07-22 through the
  // production proxy (streaming Responses API, full app tool payload).
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  // gpt-5.4 family: xhigh OK, max rejected upstream by OpenAI.
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-nano": ["low", "medium", "high", "xhigh"],
  // gemini-3.1-pro-preview: low/medium/high only. xhigh + max return
  // LiteLLM-side "Invalid reasoning effort" 500.
  "gemini-3.1-pro-preview": ["low", "medium", "high"],
  // gemini-3.1-flash-lite-preview: low/medium/high all return reasoning
  // content (probed 2026-04-27). xhigh + max → LiteLLM Vertex/Gemini
  // adapter "Invalid reasoning effort" 500.
  "gemini-3.1-flash-lite-preview": ["low", "medium", "high"],
  // gpt-5.3-codex: low/medium/high return reasoning_tokens. xhigh →
  // upstream "reasoning_effort=xhigh is not supported" 400. max → HTTP
  // 200 but reasoning_tokens=0 (silently dropped, treat as unsupported).
  "gpt-5.3-codex": ["low", "medium", "high"],
}

// Canonicalize a proxy model id for table lookups: strip a namespace
// prefix ("team/claude-opus-4-8" → "claude-opus-4-8") and normalize
// dot-form versions ("claude-opus-4.8" → "claude-opus-4-8"). Keeps
// alias deployments registered on the LiteLLM proxy resolving to the
// same effort ladder / metadata / adaptive profile as the canonical id.
export function normalizeGpdModelId(apiId: string): string {
  const unprefixed = apiId.includes("/") ? apiId.slice(apiId.lastIndexOf("/") + 1) : apiId
  return unprefixed.replace(/(\d)\.(\d)/g, "$1-$2")
}

export function gpdReasoningEffortsFor(apiId: string): readonly string[] | undefined {
  return GPD_MODEL_REASONING_EFFORTS[apiId] ?? GPD_MODEL_REASONING_EFFORTS[normalizeGpdModelId(apiId)]
}

/**
 * Request-shape profile for Anthropic adaptive-thinking models on the GPD
 * provider. Single source of truth shared by the variant builder
 * (transform.ts `variants`) and the wire-time interceptor (provider.ts
 * GPD fetch hook) so the two layers can never disagree about a model id.
 *
 * Ids are matched dot/dash-insensitively and by substring, so proxy-side
 * aliases like `claude-opus-4.8` or `team/claude-fable-5` resolve to the
 * same profile as the canonical dash-form model_name.
 *
 * Adaptive thinking is only available on the Claude 4.6+ family — per the
 * Anthropic adaptive-thinking docs: Fable 5 / Mythos 5 (always on, cannot
 * be disabled), Opus 4.8 / Opus 4.7 (only supported mode, off unless
 * requested), Opus 4.6, Sonnet 4.6. Sending `thinking: {type: "adaptive"}`
 * to claude-haiku-4-5 returns a 400 "adaptive thinking is not supported
 * on this model" (verified live 2026-05-06), so haiku intentionally has
 * no profile.
 */
export type GpdAnthropicAdaptiveProfile = {
  // `thinking.display` defaults to "omitted" on these models (empty
  // thinking text), so summaries must be requested explicitly for the UI
  // to render a reasoning part.
  summarizedDisplay: boolean
  // LiteLLM 1.83.14's AnthropicConfig has no model-map entry for these
  // ids and 500s with "Unmapped reasoning effort" on
  // `reasoning_effort: xhigh|max`. Their proxy deployments whitelist
  // `thinking` + `output_config` via allowed_openai_params instead —
  // effort must travel in `output_config.effort` ONLY (probed live
  // 2026-06-11: all five tiers pass on both models with this shape).
  omitsReasoningEffort: boolean
  // opus-4-7's adaptive scheduler declines to think on non-computational
  // prompts at xhigh in practice (verified live 2026-05-05); only `max`
  // reliably forces a thinking commit there. Opus 4.8 / Fable 5 returned
  // reasoning summaries at xhigh in the 2026-06-11 probes, so their
  // xhigh is honored as-is.
  promoteXhighToMax: boolean
}

export function gpdAnthropicAdaptiveProfile(apiId: string): GpdAnthropicAdaptiveProfile | undefined {
  const id = normalizeGpdModelId(apiId)
  if (id.includes("fable-5") || id.includes("opus-4-8")) {
    return { summarizedDisplay: true, omitsReasoningEffort: true, promoteXhighToMax: false }
  }
  if (id.includes("opus-4-7")) {
    return { summarizedDisplay: true, omitsReasoningEffort: false, promoteXhighToMax: true }
  }
  if (id.includes("opus-4-6") || id.includes("sonnet-4-6")) {
    return { summarizedDisplay: false, omitsReasoningEffort: false, promoteXhighToMax: false }
  }
  return undefined
}

// Models that exist in LiteLLM and have metadata here, but are not safe to
// expose in the desktop picker yet. Keep this list empty unless a model fails
// the full-payload probe in `script/gpd-full-payload-probe.ts`.
//
// 2026-05-08: gpt-5.5-pro and gpt-5.4-pro are kept hidden as a *defence*
// against LiteLLM proxy lag. Their metadata + reasoning-effort overrides
// were removed from this file the same day, so the picker would already
// show empty stubs for them, but the proxy's gpd-chat access group may
// still advertise them in `/v1/models` for some hours/days. The hidden
// set short-circuits the resolver (`resolveGpdProviderModels`, line 323)
// before any stub gets created, so the picker stays clean even on stale
// proxy state. Once the proxy rows are fully purged the entries here can
// be removed (no harm in leaving them — set lookup is O(1)).
export const GPD_MODEL_HIDDEN_IDS: ReadonlySet<string> = new Set([
  "gpt-5.5-pro",
  "gpt-5.4-pro",
])

// Whether to route a GPD model through OpenAI's `/v1/responses` endpoint
// (vs `/v1/chat/completions`). The Responses API is the only path that
// surfaces `reasoning_summary_text.delta` chunks for OpenAI's GPT-5.x and
// o-series reasoning models — chat.completions returns `reasoning_tokens`
// counts but no streaming summary text. Empirically verified against the
// LiteLLM proxy on 2026-05-03: gpt-5.4*, gpt-5.5*, and gpt-5.3-codex all
// stream non-empty summaries via `/v1/responses`. Claude/Gemini accept
// `/v1/responses` too but LiteLLM's translator strips their thinking
// content, so they must stay on chat.completions where their native
// thinking/reasoning blocks come through. o4-mini / gpt-4.1 family were
// not provisioned for the test key and are conservatively omitted; add
// them here once the access group is widened.
const GPD_RESPONSES_API_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
  // gpt-5.6 family verified 2026-07-22: reasoning summaries stream via
  // `/v1/responses` through the proxy, same as the 5.4/5.5 families.
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
])

export function gpdUsesResponsesApi(apiId: string): boolean {
  return GPD_RESPONSES_API_MODELS.has(apiId)
}

// Single source of truth for GPD model display names and capability
// flags. Keep ids aligned with LiteLLM proxy model_name (not upstream
// Anthropic/OpenAI names — LiteLLM remaps). Add new entries whenever
// the LiteLLM `gpd-chat` access group gains a model; missing entries
// degrade gracefully to a stub in the picker, not an error.
export const GPD_MODEL_METADATA: Record<string, GpdModelMetadata> = {
  // Output ceilings below mirror what LiteLLM `/model_group/info` reports
  // as `max_output_tokens` for each upstream model id, matching the PSI
  // inference-providers catalog (`packages/inference-providers/MODELS.md`).
  // Anthropic 4.x rejects requests where `max_tokens` exceeds the model's
  // documented maximum, so the metadata here is the actual ceiling we can
  // ask for — not aspirational.
  // Anthropic's most capable widely released model. New tokenizer (~30% more
  // tokens for the same content vs Opus-tier — don't reuse opus token/cost
  // baselines). 1M context (default), 128K max output. Pricing $10/$50 per
  // MTok; cache_read/write derived at the same 0.1x / 1.25x multipliers as
  // the other Anthropic rows. temperature/top_p/top_k are rejected upstream
  // (the GPD adapter already strips them, same as opus-4-7). Thinking is
  // always on. NOTE: this metadata only styles the picker — the model must
  // also be registered on the LiteLLM proxy and added to the `gpd-chat`
  // access group, or it never appears in /v1/models and never resolves.
  "claude-fable-5": {
    name: "Claude Fable 5",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  },
  // Current top Opus-tier model. Same request surface as opus-4-7 (no new
  // breaking changes); 1M context, 128K output, $5/$25 per MTok.
  "claude-opus-4-8": {
    name: "Claude Opus 4.8",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-opus-4-7": {
    name: "Claude Opus 4.7",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  "claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 200_000, output: 64_000 },
    cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  },
  "gpt-5.5": {
    name: "GPT 5.5",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 128_000 },
    cost: { input: 5, output: 30, cache_read: 0.5 },
  },
  // gpt-5.6 family (2026-07-09): sol is the frontier tier, terra the
  // balanced tier, luna the high-volume tier. Unlike the 5.4/5.5 families,
  // OpenAI bills prompt-cache writes for 5.6 (models.dev cost blocks carry
  // cache_write), so cache_write is set here where earlier GPT entries
  // omit it.
  "gpt-5.6-sol": {
    name: "GPT 5.6 Sol",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 128_000 },
    cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
  },
  "gpt-5.6-terra": {
    name: "GPT 5.6 Terra",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 128_000 },
    cost: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 3.125 },
  },
  "gpt-5.6-luna": {
    name: "GPT 5.6 Luna",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 128_000 },
    cost: { input: 1, output: 6, cache_read: 0.1, cache_write: 1.25 },
  },
  "gpt-5.4": {
    name: "GPT 5.4",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 128_000 },
    cost: { input: 2.5, output: 15, cache_read: 0.25 },
  },
  "gpt-5.4-mini": {
    name: "GPT 5.4 mini",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 128_000 },
    cost: { input: 0.75, output: 4.5, cache_read: 0.075 },
  },
  "gpt-5.4-nano": {
    name: "GPT 5.4 nano",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_050_000, output: 128_000 },
    cost: { input: 0.2, output: 1.25, cache_read: 0.02 },
  },
  "gpt-5.3-codex": {
    name: "GPT 5.3 Codex",
    tool_call: true,
    // 2026-04-27 probe: low → reasoning_tokens=9, medium → 81, high → 64.
    // Original metadata omitted reasoning=true (regression: model is
    // reasoning-capable; effort picker should appear). xhigh → HTTP 400,
    // max → silently dropped (rt=0), so cap at high in the effort table.
    reasoning: true,
    attachment: true,
    temperature: true,
    // Output ceiling per PSI MODELS.md (128K for the GPT-5.x family).
    // Was previously 32_768 — half the chat-completions chunked stream
    // could be cut short, especially on long codex outputs.
    limit: { context: 1_000_000, output: 128_000 },
    cost: { input: 1.75, output: 14, cache_read: 0.175 },
  },
  "gemini-3.1-pro-preview": {
    name: "Gemini 3.1 Pro",
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 65_536 },
    cost: { input: 2, output: 12, cache_read: 0.2 },
  },
  "gemini-3.1-flash-lite-preview": {
    name: "Gemini 3.1 Flash-Lite",
    tool_call: true,
    // 2026-04-27 probe: low/medium/high all return reasoning content
    // (HTTP 200 with thinking_blocks + reasoning_tokens). Original
    // metadata omitted reasoning=true. Effort picker should be available.
    // xhigh/max → 500 (Vertex/Gemini config rejects), capped at high.
    reasoning: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 65_536 },
    cost: { input: 0.25, output: 1.5, cache_read: 0.025, cache_write: 1 },
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

function exposedMetadataFrom(ids: Iterable<string>): Record<string, GpdModelMetadata> {
  const result: Record<string, GpdModelMetadata> = {}
  for (const id of ids) {
    if (GPD_MODEL_HIDDEN_IDS.has(id) || GPD_MODEL_HIDDEN_IDS.has(normalizeGpdModelId(id))) continue
    result[id] = GPD_MODEL_METADATA[id] ?? GPD_MODEL_METADATA[normalizeGpdModelId(id)] ?? stubMetadataFor(id)
  }
  return result
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
  if (!baseURL || !apiKey) return exposedMetadataFrom(Object.keys(GPD_MODEL_METADATA))
  const outcome = await getOutcome(baseURL, apiKey)
  if (outcome.reason === "forbidden") return {}
  if (outcome.reason === "fallback") return exposedMetadataFrom(Object.keys(GPD_MODEL_METADATA))
  return exposedMetadataFrom(outcome.ids)
}
