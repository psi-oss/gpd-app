/**
 * Per-key spend / usage stats fetcher for the LiteLLM proxy.
 *
 * Two endpoints, both safe to call from the desktop client with the saved
 * virtual key (Bearer auth, auto-filtered to the caller's own user_id):
 *
 *   GET /key/info               → key alias, spend, max_budget, expiry, …
 *   GET /user/daily/activity    → per-day metrics + per-model breakdown
 *
 * Hard-codes the LiteLLM base URL to match `feedback.ts` / `tos-accept.ts`.
 * If that URL ever moves to env-driven config, update all three.
 *
 * No retry. The settings-stats component re-fetches on tab focus via
 * SolidJS `createResource` (refetch on key change).
 */

const LITELLM_BASE_URL = "https://litellm-production-46bb.up.railway.app"

export type KeyInfo = {
  key_alias: string | null
  spend: number
  max_budget: number | null
  /** "30d" / "7d" / null. Null = no recurring reset. */
  budget_duration: string | null
  /** ISO 8601 string, null when there's no rolling budget. */
  budget_reset_at: string | null
  expires: string | null
  tpm_limit: number | null
  rpm_limit: number | null
  /** Per-model lifetime spend, keyed by model name. Empty if unset. */
  model_spend: Record<string, number>
  /** Per-model budget cap, keyed by model name. Empty if unset. */
  model_max_budget: Record<string, number>
  user_id: string | null
  /** ISO 8601. */
  created_at: string | null
  /** ISO 8601. Server's view of the most recent successful call. */
  last_active: string | null
  /** Models the key is allowed to call (proxy aliases). */
  models: string[]
}

export type DailyMetrics = {
  spend: number
  prompt_tokens: number
  completion_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  total_tokens: number
  successful_requests: number
  failed_requests: number
  api_requests: number
}

export type ModelBreakdown = {
  model: string
  metrics: DailyMetrics
}

export type DailyActivityRow = {
  /** YYYY-MM-DD UTC. */
  date: string
  metrics: DailyMetrics
  /** Top-level breakdown.models, flattened. */
  models: ModelBreakdown[]
}

export type DailyActivity = {
  results: DailyActivityRow[]
  totals: DailyMetrics
}

const EMPTY_METRICS: DailyMetrics = {
  spend: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  total_tokens: 0,
  successful_requests: 0,
  failed_requests: 0,
  api_requests: 0,
}

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  return 0
}

function readMetrics(raw: unknown): DailyMetrics {
  if (!raw || typeof raw !== "object") return { ...EMPTY_METRICS }
  const r = raw as Record<string, unknown>
  return {
    spend: asNumber(r.spend),
    prompt_tokens: asNumber(r.prompt_tokens),
    completion_tokens: asNumber(r.completion_tokens),
    cache_read_input_tokens: asNumber(r.cache_read_input_tokens),
    cache_creation_input_tokens: asNumber(r.cache_creation_input_tokens),
    total_tokens: asNumber(r.total_tokens),
    successful_requests: asNumber(r.successful_requests),
    failed_requests: asNumber(r.failed_requests),
    api_requests: asNumber(r.api_requests),
  }
}

async function authedGet<T>(path: string, key: string): Promise<T> {
  if (!key) throw new Error("missing LiteLLM key")
  const res = await fetch(`${LITELLM_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  })
  if (!res.ok) {
    let detail = ""
    try {
      const parsed = (await res.json()) as { detail?: unknown; error?: { message?: string } }
      const d = parsed.detail
      if (typeof d === "string") detail = d
      else if (d && typeof d === "object") detail = JSON.stringify(d)
      else if (parsed.error?.message) detail = parsed.error.message
    } catch {
      // non-JSON body; fall through
    }
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`)
  }
  return (await res.json()) as T
}

export async function fetchKeyInfo(key: string): Promise<KeyInfo> {
  const raw = await authedGet<{ info: Record<string, unknown> }>("/key/info", key)
  const info = (raw.info ?? {}) as Record<string, unknown>
  return {
    key_alias: (info.key_alias as string) ?? null,
    spend: asNumber(info.spend),
    max_budget: typeof info.max_budget === "number" ? info.max_budget : null,
    budget_duration: (info.budget_duration as string) ?? null,
    budget_reset_at: (info.budget_reset_at as string) ?? null,
    expires: (info.expires as string) ?? null,
    tpm_limit: typeof info.tpm_limit === "number" ? info.tpm_limit : null,
    rpm_limit: typeof info.rpm_limit === "number" ? info.rpm_limit : null,
    model_spend: (info.model_spend as Record<string, number>) ?? {},
    model_max_budget: (info.model_max_budget as Record<string, number>) ?? {},
    user_id: (info.user_id as string) ?? null,
    created_at: (info.created_at as string) ?? null,
    last_active: (info.last_active as string) ?? null,
    models: Array.isArray(info.models) ? (info.models as string[]) : [],
  }
}

/** YYYY-MM-DD, UTC. */
export function isoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export async function fetchDailyActivity(
  key: string,
  /** Inclusive UTC start (YYYY-MM-DD). */
  start: string,
  /** Inclusive UTC end (YYYY-MM-DD). */
  end: string,
): Promise<DailyActivity> {
  type Raw = {
    results?: Array<{
      date?: string
      metrics?: unknown
      breakdown?: { models?: Record<string, { metrics?: unknown }> }
    }>
    metadata?: Record<string, unknown>
  }
  const raw = await authedGet<Raw>(
    `/user/daily/activity?start_date=${start}&end_date=${end}&page_size=200`,
    key,
  )
  const results = Array.isArray(raw.results) ? raw.results : []
  const rows: DailyActivityRow[] = results.map((row) => {
    const models: ModelBreakdown[] = []
    const m = row.breakdown?.models ?? {}
    for (const [name, info] of Object.entries(m)) {
      models.push({ model: name, metrics: readMetrics(info?.metrics) })
    }
    // Largest spend (then tokens) first — UI shows top N.
    models.sort((a, b) => {
      const ds = b.metrics.spend - a.metrics.spend
      if (ds !== 0) return ds
      return b.metrics.total_tokens - a.metrics.total_tokens
    })
    return {
      date: row.date ?? "",
      metrics: readMetrics(row.metrics),
      models,
    }
  })
  // Newest day first.
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const md = (raw.metadata ?? {}) as Record<string, unknown>
  const totals: DailyMetrics = {
    spend: asNumber(md.total_spend),
    prompt_tokens: asNumber(md.total_prompt_tokens),
    completion_tokens: asNumber(md.total_completion_tokens),
    cache_read_input_tokens: asNumber(md.total_cache_read_input_tokens),
    cache_creation_input_tokens: asNumber(md.total_cache_creation_input_tokens),
    total_tokens: asNumber(md.total_tokens),
    successful_requests: asNumber(md.total_successful_requests),
    failed_requests: asNumber(md.total_failed_requests),
    api_requests: asNumber(md.total_api_requests),
  }
  return { results: rows, totals }
}

/** Aggregate per-model metrics across all days in `activity`. Sorted by spend.
 *
 * Drops entries whose only contribution is failed_requests with zero tokens
 * and zero spend — those are gate-rejected probes (consent gate 403, invalid
 * model alias, model-not-allowed, etc.) where the proxy still records an
 * API-touch row. They clutter the breakdown with rows like "model: $0 / 0
 * tokens / 1 call" for models the user never actually invoked. */
export function aggregateByModel(activity: DailyActivity): ModelBreakdown[] {
  const acc = new Map<string, DailyMetrics>()
  for (const row of activity.results) {
    for (const m of row.models) {
      const existing = acc.get(m.model) ?? { ...EMPTY_METRICS }
      existing.spend += m.metrics.spend
      existing.prompt_tokens += m.metrics.prompt_tokens
      existing.completion_tokens += m.metrics.completion_tokens
      existing.cache_read_input_tokens += m.metrics.cache_read_input_tokens
      existing.cache_creation_input_tokens += m.metrics.cache_creation_input_tokens
      existing.total_tokens += m.metrics.total_tokens
      existing.successful_requests += m.metrics.successful_requests
      existing.failed_requests += m.metrics.failed_requests
      existing.api_requests += m.metrics.api_requests
      acc.set(m.model, existing)
    }
  }
  return [...acc.entries()]
    .map(([model, metrics]) => ({ model, metrics }))
    .filter((row) => row.metrics.spend > 0 || row.metrics.total_tokens > 0 || row.metrics.successful_requests > 0)
    .sort((a, b) => {
      const ds = b.metrics.spend - a.metrics.spend
      if (ds !== 0) return ds
      return b.metrics.total_tokens - a.metrics.total_tokens
    })
}
