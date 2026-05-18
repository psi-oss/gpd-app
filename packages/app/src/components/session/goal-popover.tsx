import { Button } from "@opencode-ai/ui/button"
import { Popover } from "@opencode-ai/ui/popover"
import { Progress } from "@opencode-ai/ui/progress"
import { showToast } from "@opencode-ai/ui/toast"
import type { SessionGoal } from "@opencode-ai/sdk/v2/client"
import { Show, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { formatServerError } from "@/utils/server-errors"

type GoalStatus = SessionGoal["status"]

export function GoalStatusPill(props: { status: GoalStatus }) {
  return (
    <span
      classList={{
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium": true,
        "bg-success-base/15 text-success-base": props.status === "active",
        "bg-warning-base/15 text-warning-base": props.status === "paused",
        "bg-critical-base/15 text-critical-base": props.status === "budget_limited",
        "bg-info-base/15 text-info-base": props.status === "complete",
      }}
    >
      {statusLabel(props.status)}
    </span>
  )
}

function statusLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "Active"
    case "paused":
      return "Paused"
    case "budget_limited":
      return "Budget exhausted"
    case "complete":
      return "Complete"
  }
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`
}

function formatCost(microUSD: number): string {
  return `$${(microUSD / 1_000_000).toFixed(2)}`
}

function GoalBar(props: { label: string; used: number; budget?: number; formatValue: (n: number) => string }) {
  const pct = () => {
    if (props.budget === undefined || props.budget <= 0) return 0
    return Math.min(100, Math.round((props.used / props.budget) * 100))
  }
  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between text-xs">
        <span class="text-text-strong">{props.label}</span>
        <span class="text-text-weak tabular-nums">
          {props.formatValue(props.used)}
          {props.budget !== undefined ? <> / {props.formatValue(props.budget)}</> : null}
        </span>
      </div>
      <Show when={props.budget !== undefined} fallback={<div class="h-1.5 rounded-full bg-background-stronger" />}>
        <Progress value={pct()} class="w-full" />
      </Show>
    </div>
  )
}

export function GoalPopover(props: { goal: SessionGoal }) {
  const language = useLanguage()
  const sdk = useSDK()
  const [shown, setShown] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  const sessionID = () => props.goal.sessionID

  const handle = async (op: () => Promise<unknown>, successKey: string) => {
    setBusy(true)
    try {
      await op()
      showToast({ title: language.t(successKey) })
    } catch (err) {
      showToast({
        variant: "error",
        title: "Goal action failed",
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      })
    } finally {
      setBusy(false)
    }
  }

  const onPause = () =>
    handle(() => sdk.client.session.goal.update({ sessionID: sessionID(), status: "paused" }), "session.goal.toast.paused")

  const onResume = () =>
    handle(async () => {
      const updated = await sdk.client.session.goal.update({ sessionID: sessionID(), status: "active" })
      if (updated.data?.status === "budget_limited") {
        showToast({
          variant: "error",
          title: language.t("session.goal.toast.stillLimited"),
          description: language.t("session.goal.toast.stillLimitedDesc"),
        })
        throw new Error(language.t("session.goal.toast.stillLimited"))
      }
    }, "session.goal.toast.resumed")

  const onClear = () =>
    handle(() => sdk.client.session.goal.clear({ sessionID: sessionID() }), "session.goal.toast.cleared")

  return (
    <Popover
      open={shown()}
      onOpenChange={setShown}
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class: "h-6 px-2 py-1 text-xs rounded border text-text-weak",
        "aria-label": language.t("session.goal.popover.trigger"),
      }}
      trigger={
        <span class="flex items-center gap-1.5 max-w-48 truncate">
          <span>{language.t("session.goal.title").toLowerCase()}</span>
          <GoalStatusPill status={props.goal.status} />
        </span>
      }
      class="w-[340px] max-w-[calc(100vw-40px)]"
      gutter={4}
      placement="bottom-end"
    >
      <Show when={shown()}>
        <div class="flex flex-col gap-3 p-3">
          <div class="flex flex-col gap-1">
            <div class="text-xs text-text-weak">{language.t("session.goal.objective")}</div>
            <p class="text-sm text-text-strong break-words">{props.goal.objective}</p>
          </div>
          <div class="flex flex-col gap-2.5">
            <GoalBar
              label={language.t("session.goal.tokens")}
              used={props.goal.tokens.used}
              budget={props.goal.tokens.budget}
              formatValue={(n) => n.toLocaleString()}
            />
            <GoalBar
              label={language.t("session.goal.time")}
              used={props.goal.time.used}
              budget={props.goal.time.budgetSeconds}
              formatValue={formatSeconds}
            />
            <GoalBar
              label={language.t("session.goal.cost")}
              used={props.goal.cost.usedMicroUSD}
              budget={props.goal.cost.budgetMicroUSD}
              formatValue={formatCost}
            />
          </div>
          <div class="flex items-center justify-end gap-1.5 pt-1 border-t border-border-weak-base">
            <Button
              variant="ghost"
              class="h-7 text-xs"
              disabled={busy() || props.goal.status === "paused" || props.goal.status === "complete"}
              onClick={onPause}
            >
              {language.t("session.goal.action.pause")}
            </Button>
            <Button
              variant="ghost"
              class="h-7 text-xs"
              disabled={busy() || props.goal.status === "active" || props.goal.status === "complete"}
              onClick={onResume}
            >
              {language.t("session.goal.action.resume")}
            </Button>
            <Button
              variant="ghost"
              class="h-7 text-xs text-critical-base"
              disabled={busy()}
              onClick={onClear}
            >
              {language.t("session.goal.action.clear")}
            </Button>
          </div>
        </div>
      </Show>
    </Popover>
  )
}
