import { Component, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { DateTime } from "luxon"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import {
  aggregateByModel,
  fetchDailyActivity,
  fetchKeyInfo,
  isoDate,
  type DailyActivity,
  type DailyMetrics,
  type KeyInfo,
} from "@/lib/stats"

type RangeOption = { value: 7 | 30 | 90; labelKey: string }

const RANGES: RangeOption[] = [
  { value: 7, labelKey: "settings.stats.range.7d" },
  { value: 30, labelKey: "settings.stats.range.30d" },
  { value: 90, labelKey: "settings.stats.range.90d" },
]

function pct(part: number, whole: number | null): number | null {
  if (!whole || whole <= 0) return null
  return Math.min(100, Math.max(0, (part / whole) * 100))
}

export const SettingsStats: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()

  const [days, setDays] = createSignal<RangeOption["value"]>(30)

  const [keyResource, keyActions] = createResource(async () => {
    const k = platform.readGpdKey ? await platform.readGpdKey() : null
    if (!k) throw new Error("settings.stats.error.noKey")
    return k
  })

  // Re-fetch /key/info whenever the key resolves (one-shot).
  const [info, infoActions] = createResource(
    () => keyResource(),
    async (k) => fetchKeyInfo(k),
  )

  // Re-fetch daily activity whenever key OR range changes.
  const [activity, activityActions] = createResource(
    () => {
      const k = keyResource()
      if (!k) return null
      const end = new Date()
      const start = new Date()
      start.setUTCDate(start.getUTCDate() - (days() - 1))
      return { key: k, start: isoDate(start), end: isoDate(end) }
    },
    async (q) => {
      if (!q) return null
      return fetchDailyActivity(q.key, q.start, q.end)
    },
  )

  const retry = () => {
    keyActions.refetch()
    infoActions.refetch()
    activityActions.refetch()
  }

  const usd = createMemo(
    () => new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }),
  )
  const usdCompact = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }),
  )
  const number = (v: number) => v.toLocaleString(language.intl())
  const tokens = (v: number) => {
    if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString(language.intl(), { maximumFractionDigits: 1 })}M`
    if (v >= 1_000) return `${(v / 1_000).toLocaleString(language.intl(), { maximumFractionDigits: 1 })}k`
    return v.toLocaleString(language.intl())
  }
  const formatDate = (iso: string | null) => {
    if (!iso) return "—"
    const dt = DateTime.fromISO(iso).setLocale(language.intl())
    return dt.isValid ? dt.toLocaleString(DateTime.DATETIME_MED) : "—"
  }
  const formatDateShort = (iso: string | null) => {
    if (!iso) return "—"
    const dt = DateTime.fromISO(iso).setLocale(language.intl())
    return dt.isValid ? dt.toLocaleString(DateTime.DATE_MED) : "—"
  }

  const rangeOptions = createMemo(() =>
    RANGES.map((r) => ({ value: r.value, label: language.t(r.labelKey) })),
  )

  return (
    <div class="flex flex-col gap-6 p-6 max-w-3xl">
      <div class="flex flex-col gap-1">
        <h2 class="text-16-semibold text-text-base">{language.t("settings.stats.title")}</h2>
        <p class="text-13-regular text-text-weak">{language.t("settings.stats.description")}</p>
      </div>

      <Switch>
        <Match when={keyResource.error || info.error}>
          <ErrorPanel
            language={language}
            error={(keyResource.error ?? info.error) as Error | undefined}
            onRetry={retry}
          />
        </Match>
        <Match when={info.loading || keyResource.loading}>
          <p class="text-13-regular text-text-weak">{language.t("settings.stats.loading")}</p>
        </Match>
        <Match when={info()}>
          {(infoData) => (
            <>
              <KeySummary
                info={infoData()}
                usd={usd()}
                formatDate={formatDate}
                formatDateShort={formatDateShort}
                language={language}
              />

              <div class="flex items-center justify-between gap-4">
                <h3 class="text-14-semibold text-text-base">
                  {language.t("settings.stats.usage.title")}
                </h3>
                <Select
                  options={rangeOptions()}
                  current={rangeOptions().find((o) => o.value === days())}
                  value={(o) => String(o.value)}
                  label={(o) => o.label}
                  onSelect={(o) => o && setDays(o.value as RangeOption["value"])}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
              </div>

              <Switch>
                <Match when={activity.error}>
                  <ErrorPanel
                    language={language}
                    error={activity.error as Error | undefined}
                    onRetry={retry}
                  />
                </Match>
                <Match when={activity.loading}>
                  <p class="text-13-regular text-text-weak">
                    {language.t("settings.stats.loading")}
                  </p>
                </Match>
                <Match when={activity()}>
                  {(act) => (
                    <UsagePanels
                      activity={act()}
                      usd={usd()}
                      usdCompact={usdCompact()}
                      tokens={tokens}
                      number={number}
                      language={language}
                    />
                  )}
                </Match>
              </Switch>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

const KeySummary: Component<{
  info: KeyInfo
  usd: Intl.NumberFormat
  formatDate: (iso: string | null) => string
  formatDateShort: (iso: string | null) => string
  language: ReturnType<typeof useLanguage>
}> = (props) => {
  const budgetPct = () => pct(props.info.spend, props.info.max_budget)
  return (
    <section class="flex flex-col gap-4 rounded-lg border border-border-base bg-surface-base p-4">
      <div class="flex flex-col gap-2">
        <div class="flex items-baseline justify-between text-13-regular text-text-base">
          <span>{props.language.t("settings.stats.summary.spent")}</span>
          <span class="text-14-semibold">
            {props.usd.format(props.info.spend)}
            <Show when={props.info.max_budget !== null}>
              <span class="text-text-weak font-normal">
                {" "}
                / {props.usd.format(props.info.max_budget!)}
              </span>
            </Show>
          </span>
        </div>
        <Show when={budgetPct() !== null}>
          <div class="h-1.5 w-full rounded bg-surface-raised-base overflow-hidden">
            <div
              class="h-full bg-text-base"
              style={{ width: `${budgetPct()!.toFixed(2)}%` }}
            />
          </div>
        </Show>
      </div>

      <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-13-regular">
        <Show when={props.info.budget_duration}>
          <SummaryRow
            label={props.language.t("settings.stats.summary.cycle")}
            value={props.info.budget_duration!}
          />
        </Show>
        <Show when={props.info.budget_reset_at}>
          <SummaryRow
            label={props.language.t("settings.stats.summary.resetsAt")}
            value={props.formatDateShort(props.info.budget_reset_at)}
          />
        </Show>
        <Show when={props.info.last_active}>
          <SummaryRow
            label={props.language.t("settings.stats.summary.lastActive")}
            value={props.formatDate(props.info.last_active)}
          />
        </Show>
        <Show when={props.info.tpm_limit !== null}>
          <SummaryRow
            label={props.language.t("settings.stats.summary.tpm")}
            value={props.info.tpm_limit!.toLocaleString(props.language.intl())}
          />
        </Show>
        <Show when={props.info.rpm_limit !== null}>
          <SummaryRow
            label={props.language.t("settings.stats.summary.rpm")}
            value={props.info.rpm_limit!.toLocaleString(props.language.intl())}
          />
        </Show>
      </div>
    </section>
  )
}

const SummaryRow: Component<{ label: string; value: string }> = (props) => (
  <div class="flex justify-between gap-3">
    <span class="text-text-weak">{props.label}</span>
    <span class="text-text-base text-right">{props.value}</span>
  </div>
)

const UsagePanels: Component<{
  activity: DailyActivity
  usd: Intl.NumberFormat
  usdCompact: Intl.NumberFormat
  tokens: (v: number) => string
  number: (v: number) => string
  language: ReturnType<typeof useLanguage>
}> = (props) => {
  const totals = () => props.activity.totals
  const byModel = createMemo(() => aggregateByModel(props.activity))
  const maxModelSpend = createMemo(() => {
    const items = byModel()
    if (items.length === 0) return 0
    return items[0].metrics.spend
  })
  const totalRequests = (m: DailyMetrics) => m.api_requests || m.successful_requests + m.failed_requests
  const failureRate = (m: DailyMetrics) => {
    const total = totalRequests(m)
    if (total <= 0) return 0
    return (m.failed_requests / total) * 100
  }

  return (
    <>
      <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label={props.language.t("settings.stats.totals.spend")}
          value={props.usd.format(totals().spend)}
        />
        <Stat
          label={props.language.t("settings.stats.totals.tokens")}
          value={props.tokens(totals().total_tokens)}
          sub={`${props.tokens(totals().prompt_tokens)} / ${props.tokens(totals().completion_tokens)}`}
          subTooltip={props.language.t("settings.stats.totals.tokensSub")}
        />
        <Stat
          label={props.language.t("settings.stats.totals.cache")}
          value={props.tokens(totals().cache_read_input_tokens)}
          sub={
            totals().cache_creation_input_tokens > 0
              ? `+${props.tokens(totals().cache_creation_input_tokens)} ${props.language.t("settings.stats.totals.cacheWrite")}`
              : undefined
          }
        />
        <Stat
          label={props.language.t("settings.stats.totals.requests")}
          value={props.number(totalRequests(totals()))}
          sub={
            totals().failed_requests > 0
              ? `${failureRate(totals()).toFixed(1)}% ${props.language.t("settings.stats.totals.failed")}`
              : undefined
          }
          subVariant={totals().failed_requests > 0 ? "warning" : undefined}
        />
      </section>

      <section class="flex flex-col gap-3">
        <h4 class="text-13-semibold text-text-base">
          {props.language.t("settings.stats.byModel.title")}
        </h4>
        <Show
          when={byModel().length > 0}
          fallback={
            <p class="text-13-regular text-text-weak">
              {props.language.t("settings.stats.byModel.empty")}
            </p>
          }
        >
          <div class="flex flex-col gap-2">
            <For each={byModel()}>
              {(row) => {
                const total = totalRequests(row.metrics)
                const width = maxModelSpend() > 0 ? (row.metrics.spend / maxModelSpend()) * 100 : 0
                return (
                  <div class="flex flex-col gap-1 rounded-md border border-border-base bg-surface-base p-3">
                    <div class="flex items-baseline justify-between gap-3">
                      <span class="text-13-semibold text-text-base font-mono truncate">
                        {row.model}
                      </span>
                      <span class="text-13-medium text-text-base">
                        {props.usdCompact.format(row.metrics.spend)}
                      </span>
                    </div>
                    <div class="h-1 w-full rounded bg-surface-raised-base overflow-hidden">
                      <div class="h-full bg-text-base" style={{ width: `${width.toFixed(2)}%` }} />
                    </div>
                    <div class="flex justify-between gap-3 text-12-regular text-text-weak">
                      <span>
                        {props.tokens(row.metrics.total_tokens)} {props.language.t("settings.stats.byModel.tokens")}
                      </span>
                      <span>
                        {props.number(total)} {props.language.t("settings.stats.byModel.requests")}
                      </span>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </section>

      <section class="flex flex-col gap-3">
        <h4 class="text-13-semibold text-text-base">
          {props.language.t("settings.stats.byDay.title")}
        </h4>
        <Show
          when={props.activity.results.length > 0}
          fallback={
            <p class="text-13-regular text-text-weak">
              {props.language.t("settings.stats.byDay.empty")}
            </p>
          }
        >
          <div class="flex flex-col gap-1 text-13-regular">
            <div class="grid grid-cols-[1fr_7rem_6rem_5rem] gap-x-4 px-2 py-1 text-12-medium text-text-weak">
              <span>{props.language.t("settings.stats.byDay.date")}</span>
              <span class="text-right">{props.language.t("settings.stats.byDay.spend")}</span>
              <span class="text-right">{props.language.t("settings.stats.byDay.tokens")}</span>
              <span class="text-right">{props.language.t("settings.stats.byDay.requests")}</span>
            </div>
            <For each={props.activity.results}>
              {(row) => {
                const dt = DateTime.fromISO(row.date).setLocale(props.language.intl())
                const label = dt.isValid ? dt.toLocaleString(DateTime.DATE_MED) : row.date
                const total = totalRequests(row.metrics)
                return (
                  <div class="grid grid-cols-[1fr_7rem_6rem_5rem] gap-x-4 px-2 py-1 border-t border-border-weak">
                    <span class="text-text-base">{label}</span>
                    <span class="text-right text-text-base tabular-nums">
                      {props.usdCompact.format(row.metrics.spend)}
                    </span>
                    <span class="text-right text-text-weak tabular-nums">
                      {props.tokens(row.metrics.total_tokens)}
                    </span>
                    <span class="text-right text-text-weak tabular-nums">{props.number(total)}</span>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </section>
    </>
  )
}

const Stat: Component<{
  label: string
  value: string
  sub?: string
  subTooltip?: string
  subVariant?: "warning"
}> = (props) => (
  <div class="flex flex-col gap-1 rounded-md border border-border-base bg-surface-base p-3">
    <span class="text-12-medium text-text-weak">{props.label}</span>
    <span class="text-16-semibold text-text-base tabular-nums">{props.value}</span>
    <Show when={props.sub}>
      <span
        title={props.subTooltip}
        classList={{
          "text-11-regular": true,
          "text-text-weak": props.subVariant !== "warning",
          "text-text-critical": props.subVariant === "warning",
        }}
      >
        {props.sub}
      </span>
    </Show>
  </div>
)

const ErrorPanel: Component<{
  language: ReturnType<typeof useLanguage>
  error?: Error
  onRetry: () => void
}> = (props) => {
  const detail = () => {
    const m = props.error?.message ?? ""
    if (m.startsWith("settings.stats.error.")) return props.language.t(m)
    return m
  }
  return (
    <div class="flex flex-col gap-3 rounded-md border border-border-base bg-surface-base p-4">
      <p class="text-13-regular text-text-base">
        {props.language.t("settings.stats.error.title")}
      </p>
      <p class="text-12-regular text-text-weak break-words">{detail()}</p>
      <div>
        <Button onClick={() => props.onRetry()} variant="secondary" size="small">
          {props.language.t("settings.stats.error.retry")}
        </Button>
      </div>
    </div>
  )
}
