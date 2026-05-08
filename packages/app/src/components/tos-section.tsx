import { JSX, Show, createEffect, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { useLanguage } from "@/context/language"
import { PRIVACY_TEXT, TOS_TEXT } from "./tos-content"

/**
 * Reusable TOS acceptance UI — TWO scroll+checkbox affordances (Terms of
 * Service AND Privacy Policy) plus an Accept button.
 *
 * GDPR Art. 7(2) requires that consent to data processing be clearly
 * distinguishable from other matters; EDPB guidance reinforces per-
 * purpose granular consent. Bundling both into a single checkbox
 * ("I agree to TOS and PP") fails that test in EU jurisdictions.
 *
 * Each section enforces scroll-to-bottom before its checkbox enables.
 * Both checkboxes must be ticked before Accept enables. The
 * `viewedInFull` flag returned to the caller is true iff BOTH were
 * scrolled to their bottom — caller posts it server-side for the
 * Specht-v.-Netscape defence record.
 *
 * Component is view-only for POSTs; caller handles server + local state.
 */
const SCROLL_BOTTOM_EPSILON_PX = 16

function ScrollingTextBlock(props: {
  heading: JSX.Element
  text: string
  onScrolledToBottom: () => void
}) {
  let scrollHost: HTMLDivElement | undefined

  function handleScroll(e: Event) {
    const el = e.currentTarget as HTMLDivElement
    if (
      el.scrollTop + el.clientHeight >=
      el.scrollHeight - SCROLL_BOTTOM_EPSILON_PX
    ) {
      props.onScrolledToBottom()
    }
  }

  function mountHost(el: HTMLDivElement) {
    scrollHost = el
    queueMicrotask(() => {
      if (!scrollHost) return
      if (
        scrollHost.scrollHeight - scrollHost.clientHeight <=
        SCROLL_BOTTOM_EPSILON_PX
      ) {
        props.onScrolledToBottom()
      }
    })
  }

  return (
    <div class="w-full">
      <h3
        class="mb-2 text-text-strong"
        style={{
          "font-size": "var(--font-size-medium)",
          "font-weight": "var(--font-weight-medium)",
        }}
      >
        {props.heading}
      </h3>
      <div
        ref={mountHost}
        onScroll={handleScroll}
        class="w-full overflow-y-auto border border-border-base rounded-md"
        style={{ "max-height": "220px" }}
      >
        <div class="p-4 text-13-regular text-text-base whitespace-pre-wrap">
          {props.text}
        </div>
      </div>
    </div>
  )
}

export function TosSection(props: {
  onAccept: (viewedInFull: boolean) => void | Promise<void>
  onBack?: () => void
  /** Quit-the-app button (version-bump mode). Hidden when undefined. */
  onCancel?: () => void | Promise<void>
  submitting?: boolean
  error?: string
  /** Hide the internal "Terms of Service" heading + intro paragraph.
   *  Callers that render their own heading (e.g. TosUpgradeGate) set this
   *  to avoid the duplicate "Terms of Service" title shown in the UI. */
  hideHeading?: boolean
}) {
  const language = useLanguage()
  const [agreedTos, setAgreedTos] = createSignal(false)
  const [agreedPrivacy, setAgreedPrivacy] = createSignal(false)
  const [scrolledTos, setScrolledTos] = createSignal(false)
  const [scrolledPrivacy, setScrolledPrivacy] = createSignal(false)
  const [pulseTos, setPulseTos] = createSignal(0)
  const [pulsePrivacy, setPulsePrivacy] = createSignal(0)
  let hintTosRef: HTMLParagraphElement | undefined
  let hintPrivacyRef: HTMLParagraphElement | undefined

  // Re-trigger CSS animation each click by removing & re-adding the
  // animation class (force reflow so the animation restarts). Without
  // the reflow, browsers see "same class still set" and skip replay.
  createEffect(() => {
    const n = pulseTos()
    if (n === 0 || !hintTosRef) return
    hintTosRef.classList.remove("gpd-tos-pulse")
    void hintTosRef.offsetWidth
    hintTosRef.classList.add("gpd-tos-pulse")
  })
  createEffect(() => {
    const n = pulsePrivacy()
    if (n === 0 || !hintPrivacyRef) return
    hintPrivacyRef.classList.remove("gpd-tos-pulse")
    void hintPrivacyRef.offsetWidth
    hintPrivacyRef.classList.add("gpd-tos-pulse")
  })

  function bumpTos() {
    if (!scrolledTos()) setPulseTos((n) => n + 1)
  }
  function bumpPrivacy() {
    if (!scrolledPrivacy()) setPulsePrivacy((n) => n + 1)
  }

  const ready = () =>
    agreedTos() && agreedPrivacy() && scrolledTos() && scrolledPrivacy()

  async function handleAccept() {
    if (!ready() || props.submitting) return
    await props.onAccept(scrolledTos() && scrolledPrivacy())
  }

  return (
    <div class="flex flex-col items-center w-full max-w-2xl">
      <Show when={!props.hideHeading}>
        <h2
          class="text-text-strong"
          style={{
            "font-size": "var(--font-size-x-large)",
            "font-weight": "var(--font-weight-medium)",
          }}
        >
          {language.t("welcome.tos.title")}
        </h2>
        <p class="mt-1.5 text-14-regular text-text-weak">
          {language.t("welcome.tos.intro")}
        </p>
      </Show>

      <div class="mt-6 w-full flex flex-col gap-5">
        <ScrollingTextBlock
          heading={language.t("welcome.tos.sectionTos")}
          text={TOS_TEXT}
          onScrolledToBottom={() => setScrolledTos(true)}
        />
        <div class="flex flex-col gap-1" onClick={bumpTos}>
          <Checkbox
            checked={agreedTos()}
            onChange={(checked) => setAgreedTos(checked)}
            disabled={props.submitting || !scrolledTos()}
          >
            {language.t("welcome.tos.checkboxTos")}
          </Checkbox>
          <Show when={!scrolledTos()}>
            <p
              ref={(el) => (hintTosRef = el)}
              class="text-13-regular text-text-strong"
            >
              {language.t("welcome.tos.scrollHintInline")}
            </p>
          </Show>
        </div>

        <ScrollingTextBlock
          heading={language.t("welcome.tos.sectionPrivacy")}
          text={PRIVACY_TEXT}
          onScrolledToBottom={() => setScrolledPrivacy(true)}
        />
        <div class="flex flex-col gap-1" onClick={bumpPrivacy}>
          <Checkbox
            checked={agreedPrivacy()}
            onChange={(checked) => setAgreedPrivacy(checked)}
            disabled={props.submitting || !scrolledPrivacy()}
          >
            {language.t("welcome.tos.checkboxPrivacy")}
          </Checkbox>
          <Show when={!scrolledPrivacy()}>
            <p
              ref={(el) => (hintPrivacyRef = el)}
              class="text-13-regular text-text-strong"
            >
              {language.t("welcome.tos.scrollHintInline")}
            </p>
          </Show>
        </div>
      </div>

      <Show when={props.error}>
        <p class="mt-4 w-full text-13-regular text-text-danger">{props.error}</p>
      </Show>

      <div class="mt-6 w-full flex flex-col gap-3">
        <Button
          type="button"
          size="large"
          variant="primary"
          class="w-full"
          disabled={!ready() || props.submitting}
          onClick={handleAccept}
        >
          {language.t("welcome.tos.accept")}
        </Button>
        <Show when={props.onBack}>
          <Button
            type="button"
            size="large"
            variant="secondary"
            class="w-full"
            disabled={props.submitting}
            onClick={props.onBack}
          >
            {language.t("welcome.tos.back")}
          </Button>
        </Show>
        <Show when={props.onCancel}>
          <Button
            type="button"
            size="large"
            variant="ghost"
            class="w-full"
            disabled={props.submitting}
            onClick={props.onCancel}
          >
            {language.t("welcome.tos.cancel")}
          </Button>
        </Show>
      </div>
    </div>
  )
}
