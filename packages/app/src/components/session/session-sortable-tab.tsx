import { createMemo, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Tabs } from "@opencode-ai/ui/tabs"
import { getFilename } from "@opencode-ai/util/path"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useCloseTabDialog } from "@/components/file-edit/close-tab-dialog"
import { useEditorRegistry } from "@/components/file-edit/editor-registry"

export function FileVisual(props: { path: string; active?: boolean }): JSX.Element {
  const language = useLanguage()
  const registry = useEditorRegistry()
  const status = createMemo(() => registry.get(props.path)?.status())
  const active = createMemo(() => !!status() && status() !== "clean")
  const title = createMemo(() => {
    const current = status()
    if (current === "saving") return language.t("session.tab.fileStatus.saving")
    if (current === "stale") return language.t("session.tab.fileStatus.stale")
    if (current === "conflict") return language.t("session.tab.fileStatus.conflict")
    if (current === "dirty") return language.t("session.tab.unsavedFileEditor")
    return ""
  })
  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span class="text-14-medium truncate">{getFilename(props.path)}</span>
      <Show when={active()}>
        <span
          aria-hidden="true"
          class="ml-0.5 inline-block size-1.5 shrink-0 rounded-full"
          classList={{
            "animate-pulse bg-text-weak": status() === "saving",
            "bg-icon-warning-base": status() === "stale",
            "bg-text-error": status() === "conflict",
            "bg-text-weak": !status() || status() === "dirty",
          }}
          title={title()}
        />
      </Show>
    </div>
  )
}

export function SortableTab(props: { tab: string; onTabClose: (tab: string) => void }): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const close = useCloseTabDialog()
  const sortable = createSortable(props.tab)
  const path = createMemo(() => file.pathFromTab(props.tab))
  const content = createMemo(() => {
    const value = path()
    if (!value) return
    return <FileVisual path={value} />
  })
  return (
    <div use:sortable class="h-full flex items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
      <div class="relative">
        <Tabs.Trigger
          value={props.tab}
          closeButton={
            <TooltipKeybind
              title={language.t("common.closeTab")}
              keybind={command.keybind("tab.close")}
              placement="bottom"
              gutter={10}
            >
              <IconButton
                icon="close-small"
                variant="ghost"
                class="h-5 w-5"
                onClick={() => close.request(props.tab, path(), props.onTabClose)}
                aria-label={language.t("common.closeTab")}
              />
            </TooltipKeybind>
          }
          hideCloseButton
          onMiddleClick={() => close.request(props.tab, path(), props.onTabClose)}
        >
          <Show when={content()}>{(value) => value()}</Show>
        </Tabs.Trigger>
      </div>
    </div>
  )
}
