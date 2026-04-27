import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"

export function StaleBanner(props: {
  disabled?: boolean
  onKeep: () => void
  onReload: () => void
}) {
  const language = useLanguage()

  return (
    <div class="border-b border-border-warning-base bg-surface-warning-weak px-3 py-2 text-12-regular text-text-on-warning-strong">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-medium">{language.t("file.editor.stale.title")}</div>
          <div class="mt-0.5 text-text-on-warning-base">{language.t("file.editor.stale.description")}</div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button size="small" variant="ghost" disabled={props.disabled} onClick={props.onKeep}>
            {language.t("file.editor.stale.keepEditing")}
          </Button>
          <Button size="small" variant="secondary" disabled={props.disabled} onClick={props.onReload}>
            {language.t("file.editor.stale.reload")}
          </Button>
        </div>
      </div>
    </div>
  )
}
