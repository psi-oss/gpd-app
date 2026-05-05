import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { useGlobalSDK } from "@/context/global-sdk"
import { type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { displayName } from "@/pages/layout/helpers"

function isNotFoundError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const data = error as { name?: unknown; message?: unknown }
  if (data.name === "NotFoundError") return true
  return typeof data.message === "string" && /\b(Project not found|NotFoundError)\b/.test(data.message)
}

export async function deleteProjectMetadata(input: {
  project: LocalProject
  deleteProject: (input: { projectID: string; directory: string }) => Promise<unknown>
}) {
  if (!input.project.id || input.project.id === "global") return

  try {
    await input.deleteProject({
      projectID: input.project.id,
      directory: input.project.worktree,
    })
  } catch (err) {
    // The sidebar can outlive the project DB row after a prior delete,
    // server reset, or stale persisted state. Treat 404 as already gone
    // and still remove the local sidebar entry.
    if (!isNotFoundError(err)) throw err
  }
}

export function DialogConfirmDeleteProject(props: {
  project: LocalProject
  onDeleted?: (project: LocalProject) => void
}) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()

  const name = displayName(props.project)

  const deleteMutation = useMutation(() => ({
    mutationFn: async () => {
      await deleteProjectMetadata({
        project: props.project,
        deleteProject: (input) => globalSDK.client.project.delete(input),
      })
      dialog.close()
      props.onDeleted?.(props.project)
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (deleteMutation.isPending) return
    deleteMutation.mutate()
  }

  return (
    <Dialog fit title={language.t("dialog.confirmDelete.title", { name })} class="w-full max-w-[420px] mx-auto">
      <form onSubmit={handleSubmit} class="flex flex-col gap-3 px-4 pb-4 pt-1">
        <p class="text-13-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
          {language.t("dialog.confirmDelete.description", { name })}
        </p>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="normal" onClick={() => dialog.close()}>
            {language.t("dialog.confirmDelete.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="normal" disabled={deleteMutation.isPending}>
            {deleteMutation.isPending
              ? language.t("common.saving")
              : language.t("dialog.confirmDelete.confirm")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
