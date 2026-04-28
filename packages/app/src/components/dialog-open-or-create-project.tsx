import { createSignal, Show, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

export type DialogOpenOrCreateProjectProps = {
  onResolved: (directory: string) => void
  onOpenExisting: () => void
}

// Display-only join: pick the path separator that matches the parent.
// A bare `${parent}/${name}` template printed `A:\Friendo/gpd` on
// Windows because the Tauri picker hands us native backslash paths and
// we'd hardcoded a slash. The real mkdir runs Rust-side
// (`platform.createProjectDirectory`) so the on-disk path is fine
// either way; this only fixes the preview line.
function joinPathPreview(parent: string, name: string): string {
  const trimmed = parent.replace(/[\\/]+$/, "")
  const sep =
    trimmed.includes("\\") && !trimmed.includes("/")
      ? "\\"
      : /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")
        ? "\\"
        : "/"
  return `${trimmed}${sep}${name}`
}

export const DialogOpenOrCreateProject: Component<DialogOpenOrCreateProjectProps> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()

  const [mode, setMode] = createSignal<"choice" | "create">("choice")
  const [name, setName] = createSignal("")
  const [parent, setParent] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  async function pickParent() {
    if (!platform.openDirectoryPickerDialog) {
      showToast({
        title: language.t("home.combinedPicker.unsupported"),
        variant: "error",
      })
      return
    }
    const result = await platform.openDirectoryPickerDialog({
      title: language.t("home.combinedPicker.parentTitle"),
      multiple: false,
    })
    if (!result) return
    const dir = Array.isArray(result) ? result[0] : result
    if (dir) setParent(dir)
  }

  async function submitCreate() {
    const n = name().trim()
    const p = parent()
    if (!n || !p) return
    if (!platform.createProjectDirectory) {
      showToast({
        title: language.t("home.combinedPicker.unsupported"),
        description: language.t("home.combinedPicker.desktopOnly"),
        variant: "error",
      })
      return
    }
    setBusy(true)
    try {
      const created = await platform.createProjectDirectory(p, n)
      dialog.close()
      props.onResolved(created)
    } catch (err) {
      showToast({
        title: language.t("home.combinedPicker.createFailed"),
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit size="normal" title={language.t("home.combinedPicker.title")} class="w-full max-w-[460px] mx-auto">
      <Show
        when={mode() === "create"}
        fallback={
          <div class="flex flex-col gap-2 px-4 pb-4">
            <div class="text-13-regular text-text-weak pb-1">
              {language.t("home.combinedPicker.subtitle")}
            </div>
            <button
              type="button"
              class="flex items-center gap-4 rounded-lg border border-border-weaker-base hover:border-border-weak-base bg-surface-raised-base hover:bg-surface-raised-stronger-base transition-colors px-4 py-3 text-left"
              data-action="openorcreate-existing"
              onClick={() => {
                dialog.close()
                props.onOpenExisting()
              }}
            >
              <Icon name="folder-add-left" size="large" class="text-text-weak shrink-0" />
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="text-14-medium text-text-strong">{language.t("home.combinedPicker.existing.title")}</div>
                <div class="text-12-regular text-text-weak">
                  {language.t("home.combinedPicker.existing.description")}
                </div>
              </div>
            </button>
            <button
              type="button"
              class="flex items-center gap-4 rounded-lg border border-border-weaker-base hover:border-border-weak-base bg-surface-raised-base hover:bg-surface-raised-stronger-base transition-colors px-4 py-3 text-left"
              data-action="openorcreate-create"
              onClick={() => setMode("create")}
            >
              <Icon name="plus" size="large" class="text-text-weak shrink-0" />
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="text-14-medium text-text-strong">{language.t("home.combinedPicker.create.title")}</div>
                <div class="text-12-regular text-text-weak">
                  {language.t("home.combinedPicker.create.description")}
                </div>
              </div>
            </button>
          </div>
        }
      >
        <div class="flex flex-col gap-3 px-4 pb-4 pt-1">
          <div class="text-13-regular text-text-weak">
            {language.t("home.combinedPicker.create.description")}
          </div>
          <TextField
            label={language.t("home.combinedPicker.create.nameLabel")}
            placeholder={language.t("home.combinedPicker.create.namePlaceholder")}
            data-action="openorcreate-name-input"
            value={name()}
            onChange={(v) => setName(v)}
            autofocus
          />
          <div class="flex flex-col gap-1">
            <div class="text-12-medium text-text-weak">
              {language.t("home.combinedPicker.create.parentLabel")}
            </div>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="normal" onClick={pickParent} data-action="openorcreate-parent-button">
                <Icon name="folder-add-left" size="small" />
                {language.t("home.combinedPicker.create.chooseParent")}
              </Button>
              <Show when={parent()}>
                <div class="text-12-mono text-text-weak truncate flex-1" title={parent() ?? ""}>
                  {parent()}
                </div>
              </Show>
            </div>
          </div>
          <Show when={parent() && name().trim()}>
            <div class="text-11-regular text-text-weak">
              {language.t("home.combinedPicker.create.preview", {
                path: joinPathPreview(parent()!, name().trim()),
              })}
            </div>
          </Show>
          <div class="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="normal" onClick={() => setMode("choice")} disabled={busy()}>
              {language.t("common.back")}
            </Button>
            <Button
              size="normal"
              disabled={busy() || !name().trim() || !parent()}
              onClick={submitCreate}
              data-action="openorcreate-submit"
            >
              {busy() ? language.t("home.combinedPicker.create.creating") : language.t("home.combinedPicker.create.submit")}
            </Button>
          </div>
        </div>
      </Show>
    </Dialog>
  )
}
