// RES-1158: in-conversation search bar.
//
// Pinned to the top of the message-timeline scroll container, opened by
// Cmd/Ctrl+F from session.tsx. Finds case-insensitive matches across all
// currently-loaded messages, lets the user step prev/next, and highlights
// the active match via CSS in message-part.css.
//
// Match discovery uses a TreeWalker over text nodes inside elements with
// `data-message-id`, skipping text that lives inside UI affordances
// (anything with [data-search-skip] or role="button"). Each match becomes
// a <mark data-search-match="true"> wrapping exactly one text node, which
// makes the unwrap step a single replaceWith + parent.normalize().
//
// A MutationObserver re-runs the wrap pass on a 50ms debounce so the
// match list stays accurate while the bottom assistant message streams in
// new tokens.

import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"

export interface SessionSearchBarProps {
  open: () => boolean
  onClose: () => void
  scroller: () => HTMLDivElement | undefined
  // A ref-style accessor that the parent can call to (re-)focus the input
  // when Cmd+F is pressed again while the bar is already open.
  registerFocus?: (focus: () => void) => void
}

const SKIP_SELECTOR = "[data-search-skip], [role=\"button\"], [data-component=\"message-actions\"], button"

function isInsideSkippable(node: Node): boolean {
  let el: Node | null = node.parentNode
  while (el && el instanceof Element) {
    if (el.matches?.(SKIP_SELECTOR)) return true
    if (el.hasAttribute?.("data-search-skip")) return true
    el = el.parentNode
  }
  return false
}

function isInsideMark(node: Node): boolean {
  let el: Node | null = node.parentNode
  while (el && el instanceof Element) {
    if (el.tagName === "MARK" && el.getAttribute("data-search-match") === "true") return true
    el = el.parentNode
  }
  return false
}

/** Walk all text nodes under root, return text nodes that aren't already
 * inside a search mark or skip region. */
function* candidateTextNodes(root: Element): Generator<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT
      if (isInsideMark(node)) return NodeFilter.FILTER_REJECT
      if (isInsideSkippable(node)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let n: Node | null
  while ((n = walker.nextNode())) {
    yield n as Text
  }
}

/** Wrap one substring inside `text` (at [start, end)) with a <mark>.
 * Returns the new <mark> element. The text node is split twice. */
function wrapRange(text: Text, start: number, end: number): HTMLElement {
  const before = start
  const middleLength = end - start
  // Split off everything before the match — `text` now holds the tail.
  const tail = before > 0 ? text.splitText(before) : text
  // Split tail again so it holds exactly the matched substring.
  if (tail.nodeValue && tail.nodeValue.length > middleLength) {
    tail.splitText(middleLength)
  }
  const mark = document.createElement("mark")
  mark.setAttribute("data-search-match", "true")
  tail.replaceWith(mark)
  mark.appendChild(tail)
  return mark
}

/** Unwrap all <mark data-search-match> elements under root. */
function unwrapAll(root: Element): void {
  const marks = Array.from(root.querySelectorAll<HTMLElement>("mark[data-search-match=\"true\"]"))
  const touchedParents = new Set<Node>()
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark)
    }
    parent.removeChild(mark)
    touchedParents.add(parent)
  }
  for (const parent of touchedParents) {
    if (parent instanceof Element) parent.normalize()
    else if (parent instanceof Node && "normalize" in parent && typeof (parent as Node & { normalize: () => void }).normalize === "function") {
      ;(parent as Node & { normalize: () => void }).normalize()
    }
  }
}

/** Find all matches of `needle` (case-insensitive) inside `haystack`, return
 * [start, end) pairs in order. */
function findMatchRanges(haystack: string, needle: string): Array<[number, number]> {
  if (!needle) return []
  const hay = haystack.toLowerCase()
  const nee = needle.toLowerCase()
  const out: Array<[number, number]> = []
  let from = 0
  while (from <= hay.length - nee.length) {
    const idx = hay.indexOf(nee, from)
    if (idx === -1) break
    out.push([idx, idx + nee.length])
    from = idx + nee.length
  }
  return out
}

/** Discover and wrap all matches of `query` inside `scroller`. Returns the
 * list of mark elements in DOM order. */
function applyWrap(scroller: HTMLElement, query: string): HTMLElement[] {
  if (!query) return []
  const messages = Array.from(scroller.querySelectorAll<HTMLElement>("[data-message-id]"))
  const marks: HTMLElement[] = []
  for (const message of messages) {
    // Snapshot text nodes first; wrapRange mutates the tree as we go.
    const nodes = Array.from(candidateTextNodes(message))
    for (const node of nodes) {
      const text = node.nodeValue ?? ""
      const ranges = findMatchRanges(text, query)
      if (ranges.length === 0) continue
      // Process right-to-left so earlier ranges' offsets stay valid.
      let current = node
      const wrappedHere: HTMLElement[] = []
      for (let i = 0; i < ranges.length; i++) {
        const [start, end] = ranges[i]!
        // After each wrapRange, `current` is the *trailing* sibling text
        // node (the part of the original split after the match). Subsequent
        // ranges have offsets relative to the ORIGINAL string; subtract the
        // accumulated cursor.
        const cursorOffset = i === 0 ? 0 : ranges[i - 1]![1]
        const localStart = start - cursorOffset
        const localEnd = end - cursorOffset
        // Find the trailing text node after the previous wrap. It IS `current`
        // until we wrap; wrapRange leaves us pointing at what follows.
        const before = current
        const mark = wrapRange(before, localStart, localEnd)
        wrappedHere.push(mark)
        // Locate the new trailing text node so the next iteration's offsets
        // are correct. wrapRange leaves us with: [preText] <mark>matched</mark> [tail]
        const tail = mark.nextSibling
        if (tail instanceof Text) {
          current = tail
        } else {
          // No tail left — no more matches expected after this point anyway.
          break
        }
      }
      marks.push(...wrappedHere)
    }
  }
  return marks
}

export function SessionSearchBar(props: SessionSearchBarProps) {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [matches, setMatches] = createSignal<HTMLElement[]>([])
  const [activeIndex, setActiveIndex] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let rewrapTimer: ReturnType<typeof setTimeout> | undefined
  let observer: MutationObserver | undefined
  // Guards against the observer reacting to our own wrap/unwrap mutations
  // (splitText fires `characterData` events whose parent is not the <mark>
  // we just inserted, so the mark-only filter alone isn't enough).
  let suspendObserver = false

  const focusInput = () => {
    if (!inputRef) return
    inputRef.focus()
    inputRef.select()
  }

  onMount(() => {
    props.registerFocus?.(focusInput)
  })

  const total = createMemo(() => matches().length)

  /** Unwrap, rewrap with the current query, restore active index near the
   * previous active match if possible. */
  const rebuild = () => {
    const root = props.scroller()
    if (!root) return
    const prevActive = matches()[activeIndex()]
    const prevText = prevActive?.firstChild?.nodeValue ?? null
    const prevTopBefore = prevActive?.getBoundingClientRect().top ?? null
    suspendObserver = true
    unwrapAll(root)
    const next = applyWrap(root, query())
    // Let the observer queue settle (microtask) before re-listening — any
    // MutationRecords from our own work are dropped by the suspend flag.
    queueMicrotask(() => {
      suspendObserver = false
    })
    setMatches(next)
    if (next.length === 0) {
      setActiveIndex(0)
      return
    }
    // Best-effort: keep active near the previous one based on viewport
    // proximity. Fall back to first match.
    let restored = 0
    if (prevTopBefore !== null) {
      let bestDiff = Infinity
      for (let i = 0; i < next.length; i++) {
        const t = next[i]!.getBoundingClientRect().top
        const diff = Math.abs(t - prevTopBefore)
        if (diff < bestDiff) {
          bestDiff = diff
          restored = i
        }
      }
    } else if (prevText) {
      const found = next.findIndex((m) => m.firstChild?.nodeValue === prevText)
      if (found !== -1) restored = found
    }
    setActiveIndex(restored)
  }

  const scheduleRebuild = () => {
    if (rewrapTimer) clearTimeout(rewrapTimer)
    rewrapTimer = setTimeout(() => {
      rewrapTimer = undefined
      rebuild()
    }, 50)
  }

  // Re-run when the query changes or the search bar opens/closes. The
  // rebuild itself is debounced (scheduleRebuild) so rapid typing doesn't
  // queue a synchronous wrap per keystroke — only one wrap after the user
  // pauses for 50ms.
  createEffect(() => {
    if (!props.open()) return
    query()
    scheduleRebuild()
  })

  // Mount / unmount MutationObserver tied to open state.
  createEffect(() => {
    const isOpen = props.open()
    const root = props.scroller()
    if (!isOpen || !root) {
      observer?.disconnect()
      observer = undefined
      return
    }
    observer?.disconnect()
    const obs = new MutationObserver((mutations) => {
      if (suspendObserver) return
      // Ignore mutations we caused ourselves (wrap/unwrap insert/remove of
      // <mark> elements). If every record's added/removed nodes are marks,
      // skip rebuild.
      const externalChange = mutations.some((m) => {
        if (m.type === "characterData") {
          const parent = m.target.parentNode
          if (parent instanceof HTMLElement && parent.tagName === "MARK") return false
          return true
        }
        const added = Array.from(m.addedNodes)
        const removed = Array.from(m.removedNodes)
        const allMarks = [...added, ...removed].every(
          (n) => n instanceof HTMLElement && n.tagName === "MARK" && n.getAttribute("data-search-match") === "true",
        )
        return !allMarks
      })
      if (externalChange) scheduleRebuild()
    })
    obs.observe(root, { childList: true, subtree: true, characterData: true })
    observer = obs
  })

  // Apply / clear active flag + scroll into view whenever activeIndex changes.
  // Uses the explicit scroller passed in via props instead of
  // Element.scrollIntoView, because the message timeline's scroll container
  // is a regular div with overflow:auto and scrollIntoView's "nearest
  // scrollable ancestor" heuristic doesn't reliably target it (verified
  // 2026-05-26: match was at y=-17645 with no scroll triggered).
  createEffect(() => {
    const list = matches()
    const idx = activeIndex()
    for (let i = 0; i < list.length; i++) {
      if (i === idx) list[i]!.setAttribute("data-search-match-active", "true")
      else list[i]!.removeAttribute("data-search-match-active")
    }
    const target = list[idx]
    if (!target) return
    const root = props.scroller()
    if (!root) {
      target.scrollIntoView({ block: "center", behavior: "auto" })
      return
    }
    const targetRect = target.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    // Center the match vertically within the visible scroller area.
    const top = targetRect.top - rootRect.top + root.scrollTop - rootRect.height / 2 + targetRect.height / 2
    root.scrollTo({ top: Math.max(0, top), behavior: "auto" })
  })

  onCleanup(() => {
    if (rewrapTimer) clearTimeout(rewrapTimer)
    observer?.disconnect()
    const root = props.scroller()
    if (root) unwrapAll(root)
  })

  const close = () => {
    if (rewrapTimer) clearTimeout(rewrapTimer)
    rewrapTimer = undefined
    observer?.disconnect()
    observer = undefined
    const root = props.scroller()
    if (root) unwrapAll(root)
    setQuery("")
    setMatches([])
    setActiveIndex(0)
    props.onClose()
  }

  const step = (delta: number) => {
    const t = total()
    if (t === 0) return
    const next = ((activeIndex() + delta) % t + t) % t
    setActiveIndex(next)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
      return
    }
  }

  // Open lifecycle: focus input when first opened.
  createEffect(() => {
    if (props.open()) {
      // Defer until DOM has the input.
      queueMicrotask(() => focusInput())
    }
  })

  return (
    <Show when={props.open()}>
      <div
        data-component="session-search-bar"
        data-search-skip
        class="sticky top-0 z-30 flex items-center gap-2 px-3 py-2 border-b border-border-base bg-surface-base shadow-sm"
      >
        <Icon name="magnifying-glass" size="small" />
        <input
          ref={(el) => (inputRef = el)}
          type="text"
          value={query()}
          placeholder={language.t("session.search.placeholder")}
          aria-label={language.t("session.search.placeholder")}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
          name="gpd-session-search"
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          class="flex-1 bg-transparent border-none outline-none text-sm text-text-base placeholder:text-text-weak"
        />
        <span class="text-xs text-text-weak tabular-nums min-w-14 text-right">
          <Show
            when={query()}
            fallback={null}
          >
            <Show
              when={total() > 0}
              fallback={language.t("session.search.noMatches")}
            >
              {language.t("session.search.matchCount", {
                current: activeIndex() + 1,
                total: total(),
              })}
            </Show>
          </Show>
        </span>
        <Tooltip value={language.t("session.search.previousMatch")} placement="top" gutter={4}>
          <IconButton
            type="button"
            icon="chevron-up"
            variant="ghost"
            size="small"
            disabled={total() === 0}
            onClick={() => step(-1)}
            aria-label={language.t("session.search.previousMatch")}
          />
        </Tooltip>
        <Tooltip value={language.t("session.search.nextMatch")} placement="top" gutter={4}>
          <IconButton
            type="button"
            icon="chevron-down"
            variant="ghost"
            size="small"
            disabled={total() === 0}
            onClick={() => step(1)}
            aria-label={language.t("session.search.nextMatch")}
          />
        </Tooltip>
        <Tooltip value={language.t("session.search.close")} placement="top" gutter={4}>
          <IconButton
            type="button"
            icon="close"
            variant="ghost"
            size="small"
            onClick={close}
            aria-label={language.t("session.search.close")}
          />
        </Tooltip>
      </div>
    </Show>
  )
}
