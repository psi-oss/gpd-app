import { Match, Show, Switch, createMemo, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useFile } from "@/context/file"
import { usePlatform } from "@/context/platform"
import {
  TexPdfViewer,
  PDF_ZOOM_MIN,
  PDF_ZOOM_MAX,
  PDF_ZOOM_STEP,
  PDF_ZOOM_DEFAULT,
  clampZoom as clampPdfZoom,
} from "./tex-pdf-viewer"
import { TexErrorList } from "./tex-error-list"
import { useTexCompiler, type TexCompilerHandle } from "./use-tex-compiler"
import type { TexCompileResult, TexDiagnostic } from "@/context/platform"

/**
 * The Build pane, shown in the side panel when the active file is a
 * `.tex` source. Orchestrates:
 *
 *   - Compile / Recompile buttons
 *   - Compiler detection + "no compiler" CTA
 *   - PDF preview (iframe)
 *   - Error / warning list with clickable line numbers
 *   - "Open log externally" action
 *
 * The hook state is owned here so recompiles on the same tab are cheap
 * (no remount). We deliberately do NOT auto-compile — Plan B requires
 * explicit user action to avoid TikZ compile storms on every keystroke.
 */
export function TexBuildPane(props: {
  /**
   * Absolute path to the currently-active `.tex` source file. The pane
   * tracks state keyed by this path.
   */
  texFile: string
  /** Focus a line in the editor in response to a clicked diagnostic. */
  onNavigateSource?: (file: string, line: number) => void
  /** When `true`, the parent has hidden the source editor and the Build pane
   * fills the entire tab.  The toggle button flips between states. */
  maximized?: boolean
  onToggleMaximized?: () => void
}) {
  const language = useLanguage()
  const sdk = useSDK()
  const file = useFile()
  const platform = usePlatform()

  const tex = useTexCompiler()

  const absTexFile = createMemo(() => toAbsolute(props.texFile, sdk.directory))
  const entry = createMemo(() => tex.current(absTexFile()))
  const compiler = createMemo(() => tex.state.compiler)
  const running = createMemo(() => tex.state.running)
  const progress = createMemo(() => tex.state.progress)

  const statusKey = createMemo(() => {
    if (running()) return "tex.build.status.compiling"
    const e = entry()
    if (!e) return "tex.build.status.ready"
    switch (e.result.status) {
      case "success":
      case "success_with_warnings":
        return "tex.build.status.ready"
      case "error":
        return "tex.build.status.error"
      case "no_compiler":
        return "tex.error.noCompiler"
      default:
        return "tex.build.status.ready"
    }
  })

  const doCompile = async () => {
    try {
      const result = await tex.compile({
        texFile: absTexFile(),
      })
      handleResult(result)
    } catch (e) {
      showToast({
        variant: "error",
        title: language.t("tex.error.compileFailed"),
        description: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const handleResult = (result: TexCompileResult) => {
    if (result.status === "no_compiler") {
      showToast({
        variant: "error",
        title: language.t("tex.error.noCompiler"),
        description: language.t("tex.error.noCompiler.description"),
      })
      return
    }
    if (result.status === "error") {
      showToast({
        variant: "error",
        title: language.t("tex.error.compileFailed"),
        description: result.errors[0]?.message ?? "",
      })
    }
  }

  const onDiagnosticClick = (diag: TexDiagnostic) => {
    if (diag.line === null) return
    const target = diag.file ?? props.texFile
    props.onNavigateSource?.(target, diag.line)
  }

  const openLog = async () => {
    const e = entry()
    if (!e?.result.logPath) return
    try {
      await platform.openPath?.(e.result.logPath)
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("toast.file.openFailed.title"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const installTectonic = async () => {
    if (!platform.installTectonic) return
    try {
      await platform.installTectonic()
      await tex.refreshCompiler()
      showToast({
        variant: "success",
        title: language.t("settings.dependencies.tectonic.installed"),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("settings.dependencies.tectonic.failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      })
    }
  }

  const recompileDisabled = () => running()
  const hasPdf = () => !!entry()?.result.pdfPath

  // RES-1132: zoom controls live in the build-pane toolbar (next to
  // Re-render / Show log) rather than inside the embedded PDF viewer's
  // own header. The viewer is a controlled consumer — it accepts the
  // zoom value via a prop and suppresses its inline −/N%/+ strip so we
  // don't show two sets of zoom controls in the same pane. Standalone
  // artifact-viewer usage (where TexPdfViewer is mounted on its own)
  // is unaffected: it falls back to its internal zoom signal whenever
  // the `zoom` prop is omitted.
  const [pdfZoom, setPdfZoom] = createSignal(PDF_ZOOM_DEFAULT)
  const zoomIn = () => setPdfZoom((z) => clampPdfZoom(z + PDF_ZOOM_STEP))
  const zoomOut = () => setPdfZoom((z) => clampPdfZoom(z - PDF_ZOOM_STEP))
  const zoomReset = () => setPdfZoom(PDF_ZOOM_DEFAULT)

  // Errors panel height (px) when a PDF is rendered above. Default sized so
  // the user sees a couple of error rows without dominating the pane; a
  // ResizeHandle at the top of the panel lets them drag it taller/shorter.
  const [errorsHeight, setErrorsHeight] = createSignal(220)
  // Whether the errors/warnings panel is collapsed to just its header bar.
  // hyperref / pdflatex emit cosmetic warnings on most documents (e.g.
  // math in section titles → "Token not allowed in a PDF string"), and a
  // permanent ~2-row strip at the bottom of the preview is annoying when
  // the user knows the warning is benign. Collapsing keeps the row counts
  // visible without consuming pane real estate.
  const [errorsCollapsed, setErrorsCollapsed] = createSignal(false)
  const ERRORS_HEADER_PX = 32

  return (
    <div class="flex flex-col h-full overflow-hidden" data-component="tex-build-pane">
      <div class="flex items-center justify-between shrink-0 px-3 py-2 border-b border-border-weaker-base">
        <div class="flex items-center gap-2 text-12-regular">
          <div class="text-text-weak">{language.t("tex.build.title")}</div>
          <StatusIndicator statusKey={statusKey()} running={running()} />
          <Show when={running() ? progress() : null}>
            {(p) => (
              <span class="text-text-weaker">{Math.max(0, Math.floor(p().percent))}%</span>
            )}
          </Show>
        </div>
        <div class="flex items-center gap-1.5">
          <Show when={hasPdf()}>
            <div class="flex items-center gap-1 mr-1 text-12-regular text-text-weak">
              <button
                type="button"
                class="px-2 py-0.5 rounded hover:bg-background-weaker-base disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={zoomOut}
                disabled={pdfZoom() <= PDF_ZOOM_MIN + 1e-6}
                aria-label={language.t("tex.pdf.zoomOut")}
                title={language.t("tex.pdf.zoomOut")}
              >
                −
              </button>
              <button
                type="button"
                class="px-2 py-0.5 rounded hover:bg-background-weaker-base tabular-nums min-w-[3.5em] text-center"
                onClick={zoomReset}
                aria-label={language.t("tex.pdf.zoomReset")}
                title={language.t("tex.pdf.zoomReset")}
              >
                {Math.round(pdfZoom() * 100)}%
              </button>
              <button
                type="button"
                class="px-2 py-0.5 rounded hover:bg-background-weaker-base disabled:opacity-40 disabled:hover:bg-transparent"
                onClick={zoomIn}
                disabled={pdfZoom() >= PDF_ZOOM_MAX - 1e-6}
                aria-label={language.t("tex.pdf.zoomIn")}
                title={language.t("tex.pdf.zoomIn")}
              >
                +
              </button>
            </div>
          </Show>
          <Show when={entry()}>
            <Button
              size="small"
              variant="primary"
              disabled={recompileDisabled()}
              onClick={() => void doCompile()}
            >
              {language.t("tex.build.recompile")}
            </Button>
          </Show>
          <Show when={entry()?.result.logPath}>
            <Button size="small" variant="secondary" onClick={() => void openLog()}>
              {language.t("tex.build.showLog")}
            </Button>
          </Show>
          <Show when={props.onToggleMaximized}>
            <Button
              size="small"
              variant="secondary"
              onClick={() => props.onToggleMaximized?.()}
              title={props.maximized ? language.t("tex.build.restoreSource") : language.t("tex.build.maximize")}
            >
              {props.maximized ? language.t("tex.build.restoreSource") : language.t("tex.build.maximize")}
            </Button>
          </Show>
        </div>
      </div>

      <Switch>
        <Match when={compiler() === null && tex.compilerLoaded() === false}>
          <div class="flex-1 flex items-center justify-center text-12-regular text-text-weak">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        </Match>

        <Match when={compiler()?.kind === "none"}>
          <NoCompilerCta
            onInstall={installTectonic}
            canInstall={!!platform.installTectonic}
          />
        </Match>

        <Match when={!entry()}>
          <IdleState onCompile={() => void doCompile()} />
        </Match>

        <Match when={entry()}>
          {(e) => {
            const errorCount = () => e().result.errors.length
            const warningCount = () => e().result.warnings.length
            const hasDiagnostics = () => errorCount() + warningCount() > 0
            const summaryText = () => {
              if (errorCount() === 0 && warningCount() === 0) {
                return language.t("tex.error.none")
              }
              const parts: string[] = []
              if (errorCount() > 0) {
                parts.push(`${language.t("tex.error.errors")} (${errorCount()})`)
              }
              if (warningCount() > 0) {
                parts.push(`${language.t("tex.error.warnings")} (${warningCount()})`)
              }
              return parts.join(" · ")
            }
            return (
              <div class="flex-1 min-h-0 flex flex-col">
                <Show when={hasPdf()}>
                  <div class="flex-1 min-h-0">
                    <TexPdfViewer pdfPath={e().result.pdfPath!} zoom={pdfZoom()} />
                  </div>
                  <Show when={!errorsCollapsed()}>
                    <ResizeHandle
                      direction="vertical"
                      edge="start"
                      size={errorsHeight()}
                      min={48}
                      max={2000}
                      onResize={setErrorsHeight}
                      class="cursor-row-resize"
                    />
                  </Show>
                </Show>
                <div
                  class="shrink-0 border-t border-border-weaker-base flex flex-col overflow-hidden"
                  style={
                    hasPdf()
                      ? errorsCollapsed()
                        ? { height: `${ERRORS_HEADER_PX}px` }
                        : { height: `${errorsHeight()}px` }
                      : { "max-height": "100%" }
                  }
                >
                  <button
                    type="button"
                    class="shrink-0 flex items-center justify-between gap-2 px-3 text-12-regular text-text-weak hover:bg-background-weaker-base cursor-pointer text-left"
                    style={{ height: `${ERRORS_HEADER_PX}px` }}
                    onClick={() => setErrorsCollapsed(!errorsCollapsed())}
                    aria-expanded={!errorsCollapsed()}
                    title={
                      errorsCollapsed()
                        ? language.t("tex.build.diagnostics.expand")
                        : language.t("tex.build.diagnostics.collapse")
                    }
                  >
                    <span
                      class="truncate"
                      classList={{
                        "text-text-error": errorCount() > 0,
                      }}
                    >
                      {summaryText()}
                    </span>
                    <Icon
                      name="chevron-down"
                      size="small"
                      class={errorsCollapsed() ? "rotate-180" : ""}
                    />
                  </button>
                  <Show when={!errorsCollapsed()}>
                    <div class="flex-1 min-h-0 overflow-auto">
                      <Show when={hasDiagnostics()}>
                        <TexErrorList
                          errors={e().result.errors}
                          warnings={e().result.warnings}
                          onNavigate={(diag) => {
                            onDiagnosticClick(diag)
                            // Also ensure the file is opened in the tab bar.
                            if (diag.file) file.load(diag.file).catch(() => {})
                          }}
                        />
                      </Show>
                    </div>
                  </Show>
                </div>
              </div>
            )
          }}
        </Match>
      </Switch>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusIndicator(props: { statusKey: string; running: boolean }) {
  const language = useLanguage()
  const colorClass = () => {
    if (props.running) return "bg-background-accent"
    if (props.statusKey === "tex.build.status.error") return "bg-text-error"
    if (props.statusKey === "tex.error.noCompiler") return "bg-text-error"
    return "bg-text-weak"
  }
  return (
    <span class="flex items-center gap-1.5">
      <span class={"inline-block w-1.5 h-1.5 rounded-full " + colorClass()} aria-hidden />
      <span>{language.t(props.statusKey as never)}</span>
    </span>
  )
}

function NoCompilerCta(props: { onInstall: () => Promise<void>; canInstall: boolean }) {
  const language = useLanguage()
  return (
    <div class="flex-1 flex items-center justify-center p-6 text-center">
      <div class="flex flex-col items-center gap-3 max-w-80">
        <div class="text-13-medium">{language.t("tex.error.noCompiler")}</div>
        <div class="text-12-regular text-text-weak whitespace-pre-line">
          {language.t("tex.error.noCompiler.description")}
        </div>
        <Show when={props.canInstall}>
          <Button size="small" variant="primary" onClick={() => void props.onInstall()}>
            {language.t("tex.error.installTectonic")}
          </Button>
        </Show>
      </div>
    </div>
  )
}

function IdleState(props: { onCompile: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex-1 flex items-center justify-center p-6 text-center">
      <div class="flex flex-col items-center gap-3">
        <div class="text-13-medium">{language.t("tex.build.title")}</div>
        <div class="text-12-regular text-text-weak">
          {language.t("tex.build.history.empty")}
        </div>
        <Button size="small" variant="primary" onClick={props.onCompile}>
          {language.t("tex.build.compile")}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The Rust compile command needs an absolute filesystem path. The file
 * context stores paths relative to the project root, so we must re-join
 * them here. `directory` is always an absolute path on desktop.
 */
function toAbsolute(path: string, directory: string): string {
  if (!directory) return path
  if (isAbsolute(path)) return path
  const dir = directory.replace(/[\\/]+$/, "")
  const rel = path.replace(/^[\\/]+/, "")
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/"
  return `${dir}${sep}${rel}`
}

function isAbsolute(p: string): boolean {
  if (!p) return false
  if (p.startsWith("/")) return true
  // Windows: `C:\foo` or `C:/foo`
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (p.startsWith("\\\\")) return true
  return false
}

export type { TexCompilerHandle }
