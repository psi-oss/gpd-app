import { For, Show, createMemo, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { showToast } from "@opencode-ai/ui/toast"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"

const cache = new Map<string, { tab: number; answers: QuestionAnswer[]; custom: string[]; customOn: boolean[] }>()

function Mark(props: { multi: boolean; picked: boolean; onClick?: (event: MouseEvent) => void }) {
  return (
    <span data-slot="question-option-check" aria-hidden="true" onClick={props.onClick}>
      <span data-slot="question-option-box" data-type={props.multi ? "checkbox" : "radio"} data-picked={props.picked}>
        <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" />}>
          <Icon name="check-small" size="small" />
        </Show>
      </span>
    </span>
  )
}

function Option(props: {
  multi: boolean
  picked: boolean
  highlighted: boolean
  index: number
  label: string
  description?: string
  disabled: boolean
  ref?: (el: HTMLButtonElement) => void
  onFocus?: VoidFunction
  onClick: VoidFunction
}) {
  return (
    <button
      type="button"
      ref={props.ref}
      data-slot="question-option"
      data-picked={props.picked}
      data-highlighted={props.highlighted ? "true" : undefined}
      role={props.multi ? "checkbox" : "radio"}
      aria-checked={props.picked}
      aria-keyshortcuts={props.index < 9 ? String(props.index + 1) : undefined}
      disabled={props.disabled}
      onFocus={props.onFocus}
      onClick={props.onClick}
    >
      <Mark multi={props.multi} picked={props.picked} />
      <span data-slot="question-option-main">
        <span data-slot="option-label">
          <Show when={props.index < 9}>
            <span data-slot="question-option-num" class="opt-num" aria-hidden="true">
              {props.index + 1}
            </span>
          </Show>
          {props.label}
        </span>
        <Show when={props.description}>
          <span data-slot="option-description">{props.description}</span>
        </Show>
      </span>
    </button>
  )
}

export const SessionQuestionDock: Component<{ request: QuestionRequest; onSubmit: () => void }> = (props) => {
  const sdk = useSDK()
  const language = useLanguage()

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const cached = cache.get(props.request.id)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as QuestionAnswer[]),
    custom: cached?.custom ?? ([] as string[]),
    customOn: cached?.customOn ?? ([] as boolean[]),
    editing: false,
    focus: 0,
    // Transient digit-key highlight target. Not cached; resets per mount.
    // -1 means "no highlight". Cleared on arrow/tab nav and on pick().
    highlighted: -1,
  })

  let root: HTMLDivElement | undefined
  let customRef: HTMLButtonElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let replied = false
  let focusFrame: number | undefined

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const on = createMemo(() => store.customOn[store.tab] === true)
  const multi = createMemo(() => question()?.multiple === true)
  const count = createMemo(() => options().length + 1)

  const summary = createMemo(() => {
    const n = Math.min(store.tab + 1, total())
    return language.t("session.question.progress", { current: n, total: total() })
  })

  const customLabel = () => language.t("ui.messagePart.option.typeOwnAnswer")
  const customPlaceholder = () => language.t("ui.question.custom.placeholder")

  const last = createMemo(() => store.tab >= total() - 1)

  // The primary button (Next/Submit) is redundant when every remaining
  // question is single-choice without pending custom text — those will
  // auto-advance/auto-submit on pick. We keep it for multi-choice, when a
  // custom textarea is active, or as an accessibility fallback on any
  // question whose current state can't be advanced by a click alone.
  const primaryButtonVisible = createMemo(() => {
    // Always show while editing free text (user needs a commit path)
    if (store.editing) return true
    // Always show on multi-choice (Next/Submit is the only way forward)
    if (multi()) return true
    // Always show if custom free-text is the currently selected answer
    if (on()) return true
    // Single-choice, non-custom: a click on an option auto-advances, so hide.
    return false
  })

  const customUpdate = (value: string, selected: boolean = on()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, next ? [next] : [])
  }

  const measure = () => {
    if (!root) return

    const scroller = document.querySelector(".scroll-view__viewport")
    const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
    const top =
      head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
    if (!top) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }

    const dock = root.closest('[data-component="session-prompt-dock"]')
    if (!(dock instanceof HTMLElement)) return

    const dockBottom = dock.getBoundingClientRect().bottom
    const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
    const gap = 8
    const max = Math.max(240, Math.floor(dockBottom - top - gap - below))
    root.style.setProperty("--question-prompt-max-height", `${max}px`)
  }

  const clamp = (i: number) => Math.max(0, Math.min(count() - 1, i))

  const pickFocus = (tab: number = store.tab) => {
    const list = questions()[tab]?.options ?? []
    if (store.customOn[tab] === true) return list.length
    return Math.max(
      0,
      list.findIndex((item) => store.answers[tab]?.includes(item.label) ?? false),
    )
  }

  const focus = (i: number) => {
    const next = clamp(i)
    setStore("focus", next)
    if (store.editing) return
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      const el = next === options().length ? customRef : optsRef[next]
      el?.focus()
    })
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
      })
    }

    update()

    makeEventListener(window, "resize", update)

    const dock = root?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })

    focus(pickFocus())
  })

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    if (replied) return
    cache.set(props.request.id, {
      tab: store.tab,
      answers: store.answers.map((a) => (a ? [...a] : [])),
      custom: store.custom.map((s) => s ?? ""),
      customOn: store.customOn.map((b) => b ?? false),
    })
  })

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (answers: QuestionAnswer[]) => sdk.client.question.reply({ requestID: props.request.id, answers }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      replied = true
      cache.delete(props.request.id)
    },
    onError: fail,
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () => sdk.client.question.reject({ requestID: props.request.id }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      replied = true
      cache.delete(props.request.id)
    },
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const reply = async (answers: QuestionAnswer[]) => {
    if (sending()) return
    await replyMutation.mutateAsync(answers)
  }

  const reject = async () => {
    if (sending()) return
    await rejectMutation.mutateAsync()
  }

  const submit = () => void reply(questions().map((_, i) => store.answers[i] ?? []))

  const answered = (i: number) => {
    if ((store.answers[i]?.length ?? 0) > 0) return true
    return store.customOn[i] === true && (store.custom[i] ?? "").trim().length > 0
  }

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setStore("editing", false)
    // Auto-advance for single-choice, non-custom picks.
    // Custom picks still wait for the user to commit the textarea explicitly
    // (avoids submitting a half-typed free-text answer).
    if (!custom && !multi()) autoProgress()
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  const customToggle = () => {
    if (sending()) return
    setStore("focus", options().length)

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setStore("editing", false)
    focus(options().length)
  }

  const customOpen = () => {
    if (sending()) return
    setStore("focus", options().length)
    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const move = (step: number) => {
    if (store.editing || sending()) return
    // Clear any digit-key highlight; arrow nav supersedes the previous pick.
    if (store.highlighted !== -1) setStore("highlighted", -1)
    focus(store.focus + step)
  }

  // Digit-key entry: highlight option at `index` and move DOM focus to it.
  // Does NOT submit; user must press Enter (or click) to confirm. Matches
  // TUI contract except TUI auto-submits — the web app defers so the badge
  // can render and assistive tech can announce the highlight.
  const highlightOption = (index: number) => {
    if (sending() || store.editing) return
    if (index < 0 || index >= count()) return
    setStore("highlighted", index)
    focus(index)
  }

  // Clear the highlight without touching focus. Called when the user
  // converts a highlight to a pick via Enter (the pick itself moves focus).
  const clearHighlight = () => {
    if (store.highlighted !== -1) setStore("highlighted", -1)
  }

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return

    if (event.key === "Escape") {
      event.preventDefault()
      void reject()
      return
    }

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (mod && event.key === "Enter") {
      if (event.repeat) return
      event.preventDefault()
      next()
      return
    }

    if (store.editing) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    // Digit / Tab / digit-commit Enter work regardless of which element in
    // the dock has focus, so they run before the options-closest guard.
    if (event.key >= "1" && event.key <= "9") {
      const digit = Number(event.key)
      if (Number.isNaN(digit)) return
      const max = Math.min(count(), 9)
      if (digit > max) return
      event.preventDefault()
      highlightOption(digit - 1)
      return
    }

    if (event.key === "Tab") {
      if (store.highlighted !== -1) setStore("highlighted", -1)
      return
    }

    if (event.key === "Enter" && !event.shiftKey) {
      if (store.highlighted === -1) return
      if (store.focus !== store.highlighted) return
      event.preventDefault()
      const idx = store.highlighted
      clearHighlight()
      selectOption(idx)
      return
    }

    // Arrow / Home / End only make sense when focus is already inside the
    // options list — keep the legacy guard for them.
    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    if (!(target instanceof HTMLElement)) return

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      move(1)
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      move(-1)
      return
    }

    if (event.key === "Home") {
      event.preventDefault()
      if (store.highlighted !== -1) setStore("highlighted", -1)
      focus(0)
      return
    }

    if (event.key === "End") {
      event.preventDefault()
      if (store.highlighted !== -1) setStore("highlighted", -1)
      focus(count() - 1)
      return
    }
  }

  const selectOption = (optIndex: number) => {
    if (sending()) return

    // Any commit path clears a pending digit highlight so the data-*
    // attribute doesn't persist into the next question's render.
    if (store.highlighted !== -1) setStore("highlighted", -1)

    if (optIndex === options().length) {
      customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setStore("editing", false)
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
    focus(options().length)
  }

  const resizeInput = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }

  const focusCustom = (el: HTMLTextAreaElement) => {
    setTimeout(() => {
      el.focus()
      resizeInput(el)
    }, 0)
  }

  const toggleCustomMark = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    customToggle()
  }

  const next = () => {
    if (sending()) return
    if (store.editing) commitCustom()

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  // Invoked from pick() when the user selects a single-choice option.
  // Moves to the next question, or submits if this was the last question.
  // Guarded so we never submit mid-edit or while a mutation is in-flight.
  const autoProgress = () => {
    if (sending()) return
    if (store.editing) return
    if (last()) {
      submit()
      return
    }
    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const back = () => {
    if (sending()) return
    if (store.tab <= 0) return
    const tab = store.tab - 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const jump = (tab: number) => {
    if (sending()) return
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  return (
    <DockPrompt
      kind="question"
      ref={(el) => (root = el)}
      onKeyDown={nav}
      header={
        <>
          <div data-slot="question-header-title">{summary()}</div>
          <div data-slot="question-progress">
            <For each={questions()}>
              {(_, i) => (
                <button
                  type="button"
                  data-slot="question-progress-segment"
                  data-active={i() === store.tab}
                  data-answered={answered(i())}
                  disabled={sending()}
                  onClick={() => jump(i())}
                  aria-label={`${language.t("ui.tool.questions")} ${i() + 1}`}
                />
              )}
            </For>
          </div>
        </>
      }
      footer={
        <>
          <Button variant="ghost" size="large" disabled={sending()} onClick={reject} aria-keyshortcuts="Escape">
            {language.t("ui.common.dismiss")}
          </Button>
          <div data-slot="question-footer-actions">
            <Show when={store.tab > 0}>
              <Button variant="secondary" size="large" disabled={sending()} onClick={back}>
                {language.t("ui.common.back")}
              </Button>
            </Show>
            <Show when={primaryButtonVisible()}>
              <Button
                variant={last() ? "primary" : "secondary"}
                size="large"
                disabled={sending()}
                onClick={next}
                aria-keyshortcuts="Meta+Enter Control+Enter"
              >
                {last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
              </Button>
            </Show>
          </div>
        </>
      }
    >
      <div data-slot="question-text">
        <Markdown text={question()?.question ?? ""} />
      </div>
      <Show when={multi()} fallback={<div data-slot="question-hint">{language.t("ui.question.singleHint")}</div>}>
        <div data-slot="question-hint">{language.t("ui.question.multiHint")}</div>
      </Show>
      <div data-slot="question-options" aria-keyshortcuts="1 2 3 4 5 6 7 8 9 Enter">
        <For each={options()}>
          {(opt, i) => (
            <Option
              multi={multi()}
              picked={picked(opt.label)}
              highlighted={store.highlighted === i()}
              index={i()}
              label={opt.label}
              description={opt.description}
              disabled={sending()}
              ref={(el) => (optsRef[i()] = el)}
              onFocus={() => setStore("focus", i())}
              onClick={() => selectOption(i())}
            />
          )}
        </For>

        <Show
          when={store.editing}
          fallback={
            <button
              type="button"
              ref={customRef}
              data-slot="question-option"
              data-custom="true"
              data-picked={on()}
              data-highlighted={store.highlighted === options().length ? "true" : undefined}
              role={multi() ? "checkbox" : "radio"}
              aria-checked={on()}
              aria-keyshortcuts={options().length < 9 ? String(options().length + 1) : undefined}
              disabled={sending()}
              onFocus={() => setStore("focus", options().length)}
              onClick={customOpen}
            >
              <Mark multi={multi()} picked={on()} onClick={toggleCustomMark} />
              <span data-slot="question-option-main">
                <span data-slot="option-label">
                  <Show when={options().length < 9}>
                    <span data-slot="question-option-num" class="opt-num" aria-hidden="true">
                      {options().length + 1}
                    </span>
                  </Show>
                  {customLabel()}
                </span>
                <span data-slot="option-description">{input() || customPlaceholder()}</span>
              </span>
            </button>
          }
        >
          <form
            data-slot="question-option"
            data-custom="true"
            data-picked={on()}
            role={multi() ? "checkbox" : "radio"}
            aria-checked={on()}
            onMouseDown={(e) => {
              if (sending()) {
                e.preventDefault()
                return
              }
              if (e.target instanceof HTMLTextAreaElement) return
              const input = e.currentTarget.querySelector('[data-slot="question-custom-input"]')
              if (input instanceof HTMLTextAreaElement) input.focus()
            }}
            onSubmit={(e) => {
              e.preventDefault()
              commitCustom()
            }}
          >
            <Mark multi={multi()} picked={on()} onClick={toggleCustomMark} />
            <span data-slot="question-option-main">
              <span data-slot="option-label">{customLabel()}</span>
              <textarea
                ref={focusCustom}
                data-slot="question-custom-input"
                placeholder={customPlaceholder()}
                value={input()}
                rows={1}
                disabled={sending()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault()
                    setStore("editing", false)
                    focus(options().length)
                    return
                  }
                  if ((e.metaKey || e.ctrlKey) && !e.altKey) return
                  if (e.key !== "Enter" || e.shiftKey) return
                  e.preventDefault()
                  commitCustom()
                }}
                onInput={(e) => {
                  customUpdate(e.currentTarget.value)
                  resizeInput(e.currentTarget)
                }}
              />
            </span>
          </form>
        </Show>
      </div>
    </DockPrompt>
  )
}
