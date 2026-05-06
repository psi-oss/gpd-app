import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"

export function DialogRenameSession(props: {
  session: Session
  client: OpencodeClient
  onRenamed?: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [title, setTitle] = createSignal(props.session.title ?? "")

  const mutation = useMutation(() => ({
    mutationFn: async () => {
      const next = title().trim()
      if (!next) throw new Error(language.t("session.rename.placeholder"))
      // Cross-directory call shape mirrors layout archive at
      // pages/layout.tsx — pass `directory` so the request is routed to
      // the correct opencode instance for the session's project.
      const res = await props.client.session.update({
        sessionID: props.session.id,
        directory: props.session.directory,
        title: next,
      })
      if (res.error) {
        const err = res.error as { message?: string }
        throw new Error(err.message ?? JSON.stringify(res.error))
      }
      dialog.close()
      props.onRenamed?.()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (mutation.isPending) return
    mutation.mutate()
  }

  return (
    <Dialog title={language.t("session.rename.title")} class="w-full max-w-[420px] mx-auto" fit>
      <form onSubmit={handleSubmit} class="flex flex-col gap-3 px-4 pb-4 pt-1">
        <TextField
          autofocus
          type="text"
          placeholder={language.t("session.rename.placeholder")}
          value={title()}
          onChange={(v) => setTitle(v)}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("session.rename.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? language.t("common.saving") : language.t("session.rename.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
