import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { type LocalProject } from "@/context/layout"

export const SidebarContent = (props: {
  mobile?: boolean
  opened: Accessor<boolean>
  aimMove: (event: MouseEvent) => void
  projects: Accessor<LocalProject[]>
  // Rail-wide mode: caller renders project rows with name labels next to
  // the icon (ChatGPT/Claude.ai-style). Rail-narrow mode (default 64px):
  // icon-only tiles. The same `renderProject` callback handles both —
  // it inspects `railWide()` to decide.
  renderProject: (project: LocalProject) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragEnd: () => void
  handleDragOver: (event: DragEvent) => void
  openProjectLabel: JSX.Element
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  renderProjectOverlay: () => JSX.Element
  homeLabel: Accessor<string>
  onGoHome: () => void
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
  apiKeyLabel: Accessor<string>
  onOpenApiKey: () => void
  feedbackLabel: Accessor<string>
  onOpenFeedback: () => void
  // The bottom-of-rail toggle button flips the LEFTMOST project rail
  // between wide (named-row) and narrow (icon-only) modes. The 280px
  // conversation panel toggle stays bound to Cmd/Ctrl+B (via the
  // `sidebar.toggle` keybind), no on-screen affordance — having one
  // inside the rail and another inside the panel produced a doubled
  // settings bar that overlapped with the titlebar back/forward
  // chevrons at certain widths.
  railToggleLabel: Accessor<string>
  railToggleKeybind: Accessor<string | undefined>
  onToggleRail: () => void
  railWide: Accessor<boolean>
  railWidth: Accessor<number>
  renderPanel: () => JSX.Element
}): JSX.Element => {
  const expanded = createMemo(() => !!props.mobile || props.opened())
  const placement = () => (props.mobile ? "bottom" : "right")
  const railWide = createMemo(() => !props.mobile && props.railWide())
  let panel: HTMLDivElement | undefined

  createEffect(() => {
    const el = panel
    if (!el) return
    if (expanded()) {
      el.removeAttribute("inert")
      return
    }
    el.setAttribute("inert", "")
  })

  return (
    <div class="flex h-full w-full min-w-0 overflow-hidden">
      <div
        data-component="sidebar-rail"
        data-rail-wide={railWide() ? "true" : "false"}
        classList={{
          "shrink-0 bg-background-base flex flex-col overflow-hidden": true,
          "items-center": !railWide(),
          "items-stretch": railWide(),
        }}
        style={{ width: railWide() ? `${props.railWidth()}px` : "4rem" }}
        onMouseMove={props.aimMove}
      >
        <div class="flex-1 min-h-0 w-full">
          <DragDropProvider
            onDragStart={props.handleDragStart}
            onDragEnd={props.handleDragEnd}
            onDragOver={props.handleDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragXAxis />
            <div
              classList={{
                "h-full w-full flex flex-col gap-2 px-3 py-3 overflow-y-auto no-scrollbar": true,
                "items-center gap-3": !railWide(),
                "items-stretch": railWide(),
              }}
            >
              <Show
                when={railWide()}
                fallback={
                  <Tooltip placement={placement()} value={props.homeLabel()}>
                    <IconButton
                      icon="home"
                      variant="ghost"
                      size="large"
                      onClick={props.onGoHome}
                      aria-label={props.homeLabel()}
                    />
                  </Tooltip>
                }
              >
                <Button
                  variant="ghost"
                  size="large"
                  icon="home"
                  class="w-full justify-start text-text-base hover:bg-surface-base-hover"
                  onClick={props.onGoHome}
                  aria-label={props.homeLabel()}
                >
                  {props.homeLabel()}
                </Button>
              </Show>
              <SortableProvider ids={props.projects().map((p) => p.worktree)}>
                <For each={props.projects()}>{(project) => props.renderProject(project)}</For>
              </SortableProvider>
              <Show
                when={railWide()}
                fallback={
                  <Tooltip
                    placement={placement()}
                    value={
                      <div class="flex items-center gap-2">
                        <span>{props.openProjectLabel}</span>
                        <Show when={!props.mobile && !!props.openProjectKeybind()}>
                          <span class="text-icon-base text-12-medium">{props.openProjectKeybind()}</span>
                        </Show>
                      </div>
                    }
                  >
                    <IconButton
                      icon="plus"
                      variant="ghost"
                      size="large"
                      onClick={props.onOpenProject}
                      aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
                    />
                  </Tooltip>
                }
              >
                <Button
                  variant="ghost"
                  size="large"
                  icon="plus"
                  class="w-full justify-start text-text-base hover:bg-surface-base-hover"
                  onClick={props.onOpenProject}
                  aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
                >
                  {props.openProjectLabel}
                </Button>
              </Show>
            </div>
            <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
          </DragDropProvider>
        </div>
        <div
          classList={{
            "shrink-0 w-full pt-3 pb-6 flex": true,
            "flex-col items-center gap-2": !railWide(),
            "flex-row items-center justify-between px-3 gap-2": railWide(),
          }}
        >
          <TooltipKeybind placement={placement()} title={props.settingsLabel()} keybind={props.settingsKeybind() ?? ""}>
            <IconButton
              icon="settings-gear"
              variant="ghost"
              size="large"
              onClick={props.onOpenSettings}
              aria-label={props.settingsLabel()}
            />
          </TooltipKeybind>
          <Tooltip placement={placement()} value={props.apiKeyLabel()}>
            <IconButton
              icon="providers"
              variant="ghost"
              size="large"
              onClick={props.onOpenApiKey}
              aria-label={props.apiKeyLabel()}
            />
          </Tooltip>
          <Tooltip placement={placement()} value={props.feedbackLabel()}>
            <IconButton
              icon="speech-bubble"
              variant="ghost"
              size="large"
              onClick={props.onOpenFeedback}
              aria-label={props.feedbackLabel()}
            />
          </Tooltip>
          <Show when={!props.mobile && railWide()}>
            <div class="flex-1" />
          </Show>
          <Show when={!props.mobile}>
            <TooltipKeybind
              placement={placement()}
              title={props.railToggleLabel()}
              keybind={props.railToggleKeybind() ?? ""}
            >
              <IconButton
                icon={railWide() ? "sidebar-active" : "sidebar"}
                variant="ghost"
                size="large"
                onClick={props.onToggleRail}
                aria-label={props.railToggleLabel()}
              />
            </TooltipKeybind>
          </Show>
        </div>
      </div>

      <div
        ref={(el) => {
          panel = el
        }}
        classList={{ "flex-1 flex h-full min-h-0 min-w-0 overflow-hidden": true, "pointer-events-none": !expanded() }}
        aria-hidden={!expanded()}
      >
        {props.renderPanel()}
      </div>
    </div>
  )
}
