import { Component, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { PhysicsShortcutsBar } from "@/components/physics-shortcuts-bar"

interface MathfieldElement extends HTMLElement {
  getValue: (format?: string) => string
  setValue: (value: string) => void
  insert: (latex: string, options?: Record<string, unknown>) => void
  mathVirtualKeyboardPolicy?: "auto" | "manual" | "sandboxed"
}

interface Props {
  onInsert: (latex: string) => void
}

export const DialogEquationEditor: Component<Props> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const [loaded, setLoaded] = createSignal(false)
  const [failed, setFailed] = createSignal(false)

  let containerRef: HTMLDivElement | undefined
  let rootRef: HTMLDivElement | undefined
  let mathField: MathfieldElement | undefined

  // Dynamic import of MathLive so the ~1MB bundle stays out of the initial
  // chat load. soundsDirectory=null silences MathLive's audio feedback which
  // otherwise 404s in production (sound files aren't bundled).
  onMount(async () => {
    try {
      const ml = await import("mathlive")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const MFE: any = ml.MathfieldElement ?? customElements.get("math-field")
      if (MFE && "soundsDirectory" in MFE) MFE.soundsDirectory = null
      // Class-level default so every math-field created inherits `manual`.
      // Belt-and-braces with the per-instance attribute set at mount time;
      // some MathLive builds consult the class default before the element
      // attribute is parsed.
      if (MFE && "mathVirtualKeyboardPolicy" in MFE) {
        MFE.mathVirtualKeyboardPolicy = "manual"
      }
      // Ensure any already-visible keyboard instance is hidden.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mvk: any = (window as any).mathVirtualKeyboard
      if (mvk && typeof mvk.hide === "function") mvk.hide()
      setLoaded(true)
    } catch {
      setFailed(true)
    }
  })

  // Mount the math-field element after MathLive has registered the custom
  // element. Using document.createElement+append mirrors the gpd-web React
  // pattern; Solid's JSX doesn't understand <math-field> without extra typing.
  createEffect(() => {
    if (!loaded() || !containerRef) return
    if (!customElements.get("math-field")) return

    const existing = containerRef.querySelector("math-field") as MathfieldElement | null
    if (existing) {
      mathField = existing
      requestAnimationFrame(() => mathField?.focus())
      return
    }

    const field = document.createElement("math-field") as MathfieldElement
    field.style.width = "100%"
    field.style.minHeight = "56px"
    field.style.fontSize = "18px"
    // Suppress MathLive's built-in virtual keyboard (steals focus, overflows
    // the Dialog). Desktop users have a physical keyboard + PhysicsShortcutsBar.
    // The context Menu stays — see menuItems override below.
    field.setAttribute("math-virtual-keyboard-policy", "manual")
    field.mathVirtualKeyboardPolicy = "manual"
    containerRef.appendChild(field)
    mathField = field
    requestAnimationFrame(() => {
      field.focus()
      // Strip the `data-tooltip` attribute on the menu/keyboard toggles as a
      // JS backstop: some WebKit builds don't honor `::part()::after` for
      // CSS-generated tooltip content, so the label still floats up and
      // clips. Querying into the shadow DOM requires shadowRoot access.
      const sr = (field as unknown as { shadowRoot?: ShadowRoot }).shadowRoot
      if (sr) {
        sr.querySelectorAll("[part=menu-toggle][data-tooltip], [part=virtual-keyboard-toggle][data-tooltip]")
          .forEach((el) => el.removeAttribute("data-tooltip"))
      }
    })
  })

  onCleanup(() => {
    if (mathField && mathField.parentNode) {
      mathField.parentNode.removeChild(mathField)
    }
    mathField = undefined
  })

  const handleShortcut = (latex: string) => {
    if (!mathField) return
    mathField.insert(latex)
    requestAnimationFrame(() => mathField?.focus())
  }

  const handleInsert = () => {
    const latex = mathField ? mathField.getValue("latex") : ""
    dialog.close()
    if (latex.trim().length > 0) setTimeout(() => props.onInsert(latex), 0)
  }

  // Two-stage Escape: if MathLive has an active popover or virtual keyboard,
  // let MathLive swallow the first Escape. Close the dialog only if neither
  // is visible. Stop propagation in the popover case so Kobalte's dialog
  // dismissal doesn't also fire.
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return
    const hasPopover =
      document.querySelector(".ML__popover:not([hidden])") ||
      document.querySelector(".ML__keyboard:not([hidden])")
    if (hasPopover) {
      e.stopPropagation()
      return
    }
    e.preventDefault()
    dialog.close()
  }

  return (
    <Dialog title={language.t("equation.dialog.title")} size="large">
      {/* Hard backstop: MathLive auto-injects the virtual keyboard overlay
          despite mathVirtualKeyboardPolicy="manual". Hide the keyboard host
          + its in-field toggle, but keep the Menu toggle visible so users
          can access the context menu (Insert Matrix, Cut/Copy/Paste, etc.). */}
      <style>{`.ML__keyboard,
.ML__keyboard-container,
.ML__virtual-keyboard,
#mathlive-virtual-keyboard,
[part="keyboard"],
[part="container"].ML__keyboard,
math-field::part(virtual-keyboard-toggle) { display: none !important; visibility: hidden !important; pointer-events: none !important; }

/* MathLive's Menu button puts a [data-tooltip]::after label positioned at
   top: -100% — on the first row of math-field that's above the field's
   own bounds and gets clipped by the Dialog header. Hide the tooltip
   pseudo; the icon alone is clear enough and screen readers still get
   the aria-label. */
math-field::part(menu-toggle)::after,
math-field::part(virtual-keyboard-toggle)::after { display: none !important; content: none !important; }`}</style>
      <div
        ref={rootRef}
        role="group"
        aria-label={language.t("equation.dialog.title")}
        data-testid="gpd-equation-editor"
        onKeyDown={handleKeyDown}
        class="flex flex-col gap-3 p-1"
      >
        <Show
          when={!failed()}
          fallback={
            <div class="min-h-[56px] flex items-center justify-center text-13-regular text-on-critical-base">
              {language.t("equation.dialog.unavailable")}
            </div>
          }
        >
          <Show
            when={loaded()}
            fallback={
              <div class="min-h-[56px] flex items-center justify-center text-13-regular text-text-weak">
                {language.t("equation.dialog.loading")}
              </div>
            }
          >
            <div
              ref={containerRef}
              class="rounded-md border border-border-base bg-surface-raised-base p-2"
            />
          </Show>

          <PhysicsShortcutsBar onInsert={handleShortcut} />
        </Show>

        <div class="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="normal" onClick={() => dialog.close()}>
            {language.t("equation.dialog.discard")}
          </Button>
          <Button type="button" variant="primary" size="normal" onClick={handleInsert}>
            {language.t("equation.dialog.insert")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
