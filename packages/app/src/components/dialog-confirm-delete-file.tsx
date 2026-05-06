import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

export function DialogConfirmDeleteFile(props: { node: FileNode; onDeleted?: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const language = useLanguage()

  const remove = useMutation(() => ({
    mutationFn: async () => {
      // Read first to get the current hash. Optimistic-concurrency guard
      // prevents racing a concurrent edit from another agent or the user.
      const read = await sdk.client.file.read({ path: props.node.path })
      const hash = read.data?.hash
      if (!hash) throw new Error(language.t("filetree.delete.failed.title"))
      const res = await sdk.client.file.delete({
        path: props.node.path,
        expectedHash: hash,
      })
      if (!res.data?.ok) {
        throw new Error(language.t("filetree.delete.conflict"))
      }
      dialog.close()
      props.onDeleted?.()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("filetree.delete.failed.title"), description: message })
    },
  }))

  return (
    <Dialog title={language.t("filetree.delete.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {language.t("filetree.delete.confirm", { name: props.node.name })}
          </span>
          <span class="text-12-regular text-text-weak">{props.node.path}</span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {language.t("filetree.delete.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
