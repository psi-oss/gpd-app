import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { sessionTitle } from "@/utils/session-title"

export function DialogConfirmDeleteSession(props: {
  session: Session
  client: OpencodeClient
  onDeleted?: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()

  const name = sessionTitle(props.session.title) ?? language.t("command.session.new")

  const mutation = useMutation(() => ({
    mutationFn: async () => {
      const res = await props.client.session.delete({
        sessionID: props.session.id,
        directory: props.session.directory,
      })
      if (res.error) {
        const err = res.error as { message?: string }
        throw new Error(err.message ?? JSON.stringify(res.error))
      }
      dialog.close()
      props.onDeleted?.()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("session.delete.failed.title"), description: message })
    },
  }))

  return (
    <Dialog title={language.t("session.delete.title")} class="w-full max-w-[420px] mx-auto" fit>
      <div class="flex flex-col gap-3 px-4 pb-4 pt-1">
        <span class="text-13-regular text-text-base">
          {language.t("session.delete.confirm", { name })}
        </span>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("session.rename.cancel")}
          </Button>
          <Button type="button" variant="primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? language.t("common.saving") : language.t("session.delete.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
