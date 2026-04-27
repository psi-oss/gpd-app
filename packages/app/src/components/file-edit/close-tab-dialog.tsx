import type { JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useEditorRegistry } from "./editor-registry"

export function useCloseTabDialog() {
  const dialog = useDialog()
  const language = useLanguage()
  const registry = useEditorRegistry()

  const request = (tab: string, path: string | undefined, close: (tab: string) => void) => {
    const ed = path ? registry.get(path) : undefined
    if (!ed?.isDirty()) {
      close(tab)
      return
    }

    const done = () => {
      dialog.close()
      close(tab)
    }

    dialog.show(
      () =>
        (
          <Dialog
            title={language.t("file.editor.close.title")}
            description={language.t("file.editor.close.description")}
            fit
          >
            <div class="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  ed.discard()
                  done()
                }}
              >
                {language.t("file.editor.close.discard")}
              </Button>
              <Button
                variant="primary"
                autofocus
                onClick={async () => {
                  const out = await ed.save()
                  if (!out.ok) return
                  done()
                }}
              >
                {language.t("common.save")}
              </Button>
            </div>
          </Dialog>
        ) as JSX.Element,
    )
  }

  return { request }
}
