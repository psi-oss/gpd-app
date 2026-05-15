import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"

interface DialogSessionGoalProps {
  session: string
}

/**
 * RES-932: capture a user-stated session goal that gets pinned to the
 * system prompt for every turn in this session. Accepts optional inline
 * --budget=<value> and --time=<value> flags so the user can stay on a
 * single line, e.g.: `Find quantum gravity model --budget=$50 --time=2h`.
 */
export function DialogSessionGoal(props: DialogSessionGoalProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const session = createMemo(() => sync.session.get(props.session))

  const seed = createMemo(() => {
    const goal = session()?.goal
    if (!goal) return ""
    const parts = [goal.text]
    if (goal.budget) parts.push(`--budget=${goal.budget}`)
    if (goal.deadline) parts.push(`--time=${goal.deadline}`)
    return parts.join(" ")
  })

  return (
    <DialogPrompt
      title="Set Session Goal"
      placeholder="State the goal for this session. Optional: --budget=$X --time=2h"
      value={seed()}
      onConfirm={(value) => {
        const parsed = parseGoalInput(value)
        if (parsed === null) {
          // User submitted whitespace-only or a blank string with no flags —
          // treat that as "clear the goal" so /goal becomes self-correcting
          // without needing a separate /clear-goal command.
          sdk.client.session.update({ sessionID: props.session, goal: null })
        } else {
          sdk.client.session.update({ sessionID: props.session, goal: parsed })
        }
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

/**
 * Parse "<goal text> [--budget=<v>] [--time=<v>]" into a goal payload.
 * Returns null when the input is effectively empty (used to signal clear).
 *
 * Exported for unit testing — the parsing rules are stable and
 * worth pinning so future flag additions don't silently regress.
 */
export function parseGoalInput(raw: string): { text: string; budget?: string; deadline?: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Capture --budget=... and --time=... wherever they appear. We accept
  // both `--budget=value` and `--budget="quoted value"`. Removing them
  // from the input leaves only the goal text.
  let budget: string | undefined
  let deadline: string | undefined
  const consume = (re: RegExp) => {
    const match = trimmed.match(re)
    if (!match) return undefined
    const value = match[1].replace(/^['"]|['"]$/g, "").trim()
    return value || undefined
  }
  budget = consume(/--budget=("[^"]*"|'[^']*'|\S+)/)
  deadline = consume(/--time=("[^"]*"|'[^']*'|\S+)/)

  const text = trimmed
    .replace(/--budget=("[^"]*"|'[^']*'|\S+)/g, "")
    .replace(/--time=("[^"]*"|'[^']*'|\S+)/g, "")
    .replace(/\s+/g, " ")
    .trim()

  if (!text) return null

  const out: { text: string; budget?: string; deadline?: string } = { text }
  if (budget) out.budget = budget
  if (deadline) out.deadline = deadline
  return out
}
