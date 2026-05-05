import { Component, createMemo, createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { postFeedback, type FeedbackCategory } from "@/lib/feedback"

const MAX_LEN = 8000

type CategoryOption = { value: FeedbackCategory; labelKey: string }

const CATEGORY_OPTIONS: CategoryOption[] = [
  { value: "feedback", labelKey: "settings.feedback.category.feedback" },
  { value: "bug", labelKey: "settings.feedback.category.bug" },
  { value: "feature", labelKey: "settings.feedback.category.feature" },
]

export const SettingsFeedback: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()

  const [category, setCategory] = createSignal<FeedbackCategory>("feedback")
  const [message, setMessage] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)

  const categoryOptions = createMemo(() =>
    CATEGORY_OPTIONS.map((o) => ({ value: o.value, label: language.t(o.labelKey) })),
  )

  const remaining = () => MAX_LEN - message().length
  const canSubmit = () => !submitting() && message().trim().length > 0 && remaining() >= 0

  const submit = async () => {
    if (!canSubmit()) return
    setSubmitting(true)
    try {
      const key = platform.readGpdKey ? await platform.readGpdKey() : null
      if (!key) {
        showToast({
          title: language.t("settings.feedback.toast.noKey"),
          variant: "error",
        })
        return
      }
      await postFeedback({
        key,
        category: category(),
        message: message(),
        appVersion: platform.version,
      })
      showToast({
        title: language.t("settings.feedback.toast.sent"),
        variant: "success",
      })
      setMessage("")
      setCategory("feedback")
    } catch (e) {
      showToast({
        title: language.t("settings.feedback.toast.failed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "error",
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="flex flex-col gap-4 p-6 max-w-2xl">
      <div class="flex flex-col gap-1">
        <h2 class="text-16-semibold text-text-base">
          {language.t("settings.feedback.title")}
        </h2>
        <p class="text-13-regular text-text-weak">
          {language.t("settings.feedback.description")}
        </p>
      </div>

      <div class="flex flex-col gap-2">
        <label class="text-13-medium text-text-base">
          {language.t("settings.feedback.categoryLabel")}
        </label>
        <Select
          options={categoryOptions()}
          current={categoryOptions().find((o) => o.value === category())}
          value={(o) => o.value}
          label={(o) => o.label}
          onSelect={(option) => {
            if (option) setCategory(option.value)
          }}
          variant="secondary"
          size="small"
          triggerVariant="settings"
        />
      </div>

      <div class="flex flex-col gap-2">
        <label class="text-13-medium text-text-base" for="settings-feedback-message">
          {language.t("settings.feedback.messageLabel")}
        </label>
        <textarea
          id="settings-feedback-message"
          class="min-h-40 w-full rounded-md border border-border-base bg-surface-base p-3 text-14-regular text-text-base outline-none focus:border-border-strong resize-y"
          placeholder={language.t("settings.feedback.messagePlaceholder")}
          maxlength={MAX_LEN}
          value={message()}
          onInput={(e) => setMessage(e.currentTarget.value)}
          disabled={submitting()}
        />
        <div class="flex justify-between text-12-regular text-text-weak">
          <Show
            when={remaining() < 0}
            fallback={<span>{language.t("settings.feedback.charCount", { remaining: remaining() })}</span>}
          >
            <span class="text-text-critical">
              {language.t("settings.feedback.tooLong", { over: -remaining() })}
            </span>
          </Show>
        </div>
      </div>

      <div class="flex justify-end">
        <Button onClick={submit} disabled={!canSubmit()} variant="primary">
          {language.t(submitting() ? "settings.feedback.submitting" : "settings.feedback.submit")}
        </Button>
      </div>
    </div>
  )
}
