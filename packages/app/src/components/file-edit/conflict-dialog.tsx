import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import type { FileWriteConflict } from "@opencode-ai/sdk/v2"

export function ConflictDialog(props: {
  draft: string
  issue: FileWriteConflict
  saving?: boolean
  onCancel: () => void
  onKeep: () => void
  onTake: () => void
}) {
  const language = useLanguage()

  return (
    <Dialog
      title={language.t("file.editor.conflict.title")}
      description={language.t("file.editor.conflict.description")}
      size="x-large"
    >
      <div class="grid max-h-[60vh] min-h-0 gap-3 md:grid-cols-2">
        <div class="min-w-0">
          <div class="mb-1 text-12-medium text-text-weak">{language.t("file.editor.conflict.draft")}</div>
          <pre class="max-h-[50vh] overflow-auto rounded bg-surface-inset-base p-2 font-mono text-xs text-text">
            {props.draft}
          </pre>
        </div>
        <div class="min-w-0">
          <div class="mb-1 text-12-medium text-text-weak">{language.t("file.editor.conflict.disk")}</div>
          <pre class="max-h-[50vh] overflow-auto rounded bg-surface-inset-base p-2 font-mono text-xs text-text">
            {props.issue.currentContent}
          </pre>
        </div>
      </div>
      <div class="mt-3 flex justify-end gap-2">
        <Button variant="ghost" disabled={props.saving} onClick={props.onCancel}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="secondary" disabled={props.saving} onClick={props.onTake}>
          {language.t("file.editor.conflict.takeTheirs")}
        </Button>
        <Button variant="primary" disabled={props.saving} onClick={props.onKeep}>
          {props.saving ? language.t("common.saving") : language.t("file.editor.conflict.keepMine")}
        </Button>
      </div>
    </Dialog>
  )
}
