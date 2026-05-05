import { Component } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useProviders } from "@/hooks/use-providers"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { useLanguage } from "@/context/language"

// The upstream OpenCode "Custom" BYOE provider entry is intentionally omitted
// for GPD: every call must route through our LiteLLM proxy for billing
// reconciliation, session logging, rate-limits, and moderation. A user-wired
// Custom OpenAI-compatible endpoint bypasses all of that.

const GPD_PROVIDER_ID = "gpd"

export const DialogSelectProvider: Component = () => {
  const dialog = useDialog()
  const providers = useProviders()
  const language = useLanguage()

  return (
    <Dialog title={language.t("command.provider.connect")} transition>
      <List
        search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.provider.empty")}
        activeIcon="plus-small"
        key={(x) => x?.id}
        items={() => {
          language.locale()
          return providers.all().filter((x) => x.id === GPD_PROVIDER_ID)
        }}
        filterKeys={["id", "name"]}
        onSelect={(x) => {
          if (!x) return
          dialog.show(() => <DialogConnectProvider provider={x.id} />)
        }}
      >
        {(i) => (
          <div class="px-1.25 w-full flex items-center gap-x-3">
            <ProviderIcon data-slot="list-item-extra-icon" id={i.id} />
            <span>{i.name}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
