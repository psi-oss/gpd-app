import { showToast } from "@opencode-ai/ui/toast"
import { Show, createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import {
  PDF_ZOOM_DEFAULT,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  PDF_ZOOM_STEP,
  PdfCanvasViewer,
  clampZoom,
} from "./pdf-canvas-viewer"

export { PDF_ZOOM_DEFAULT, PDF_ZOOM_MAX, PDF_ZOOM_MIN, PDF_ZOOM_STEP, clampZoom }

/**
 * TeX-build PDF viewer.
 *
 * Thin wrapper around the generic {@link PdfCanvasViewer} that loads bytes
 * via the platform's `tex.readArtifactBase64` API (the path must live
 * under the GPD `.tex-builds` cache) and adds two TeX-specific affordances
 * in the toolbar's trailing slot:
 *   - Save PDF (copies the cached artifact to a user-chosen location via
 *     `platform.tex.saveArtifactToPath`).
 *   - Jump to source (SyncTeX forward, when `onJumpToSource` is provided).
 *
 * All zoom + page nav UX (including trackpad pinch with cursor anchoring,
 * Cmd+wheel, and the +/-/% buttons) lives in `PdfCanvasViewer`.
 */
export function TexPdfViewer(props: {
  pdfPath: string
  onJumpToSource?: (input: { page: number; x: number; y: number }) => void
  class?: string
  zoom?: number
  hideZoomControls?: boolean
  onZoomChange?: (zoom: number) => void
  /**
   * Bust the PDF.js document cache when a recompile produced new bytes
   * at the same path. The TeX compiler writes to a deterministic
   * `<out_dir>/<root>.pdf` location, so `pdfPath` stays stable across
   * recompiles and `createResource` keyed only on the path would skip
   * the refetch — leaving the viewer showing the previous build.
   * The parent passes the entry's `completedAt` timestamp here.
   */
  reloadToken?: number | string
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const [currentPage, setCurrentPage] = createSignal(1)

  const loadBytes = async (): Promise<Uint8Array> => {
    const api = platform.tex
    if (!api) throw new Error("TeX platform API unavailable")
    const b64 = await api.readArtifactBase64(props.pdfPath)
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  const savePdf = async () => {
    const api = platform.tex
    if (!api?.saveArtifactToPath || !platform.saveFilePickerDialog) {
      showToast({ title: language.t("tex.pdf.save.toast.error") })
      return
    }
    const src = props.pdfPath
    const filename = src.split(/[\\/]/).pop() || "document.pdf"
    const dest = await platform.saveFilePickerDialog({
      title: language.t("tex.pdf.save"),
      defaultPath: filename,
    })
    if (!dest) return
    try {
      await api.saveArtifactToPath({ src, dest })
      showToast({ title: language.t("tex.pdf.save.toast.success"), description: dest })
    } catch (err) {
      showToast({
        title: language.t("tex.pdf.save.toast.error"),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Force a full PdfCanvasViewer re-mount whenever the underlying PDF path
  // OR the reloadToken changes. Solid's `<Show keyed>` recreates its child
  // on identity change of the `when` value, which is the most reliable way
  // to bust pdfjs's createResource cache + drop any stale page DOM /
  // IntersectionObserver bookkeeping. Earlier attempts to pass a "v1#v2"
  // composite sourceKey alone weren't enough: the createResource source
  // signal didn't always pick up prop changes through this wrapper, so
  // recompiles produced a blank canvas with status="Ready". Remounting on
  // a stable scope key fixes that deterministically.
  const scopeKey = createMemo(() => `${props.pdfPath}#${props.reloadToken ?? ""}`)

  return (
    <Show when={scopeKey()} keyed>
      {(key) => (
        <PdfCanvasViewer
          source={{ kind: "loader", load: loadBytes }}
          sourceKey={key}
          class={props.class}
          zoom={props.zoom}
          hideZoomControls={props.hideZoomControls}
          onZoomChange={props.onZoomChange}
          onPageChange={setCurrentPage}
          headerTrailing={() => (
            <>
              <button
                type="button"
                class="px-2 py-0.5 rounded hover:bg-background-weaker-base disabled:opacity-40 disabled:hover:bg-transparent"
                title={language.t("tex.pdf.save")}
                aria-label={language.t("tex.pdf.save")}
                onClick={savePdf}
              >
                {language.t("tex.pdf.save")}
              </button>
              <Show when={props.onJumpToSource}>
                {(handler) => (
                  <button
                    type="button"
                    class="px-2 py-0.5 rounded hover:bg-background-weaker-base"
                    title={language.t("tex.pdf.jumpToSource.hint")}
                    onClick={() => handler()({ page: currentPage(), x: 50, y: 50 })}
                  >
                    {language.t("tex.pdf.jumpToSource")}
                  </button>
                )}
              </Show>
            </>
          )}
        />
      )}
    </Show>
  )
}
