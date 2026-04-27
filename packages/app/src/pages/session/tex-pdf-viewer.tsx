import { Show, createEffect, createResource, createSignal, on, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

/**
 * Embedded PDF viewer for the TeX Build pane.
 *
 * We use the browser's native PDF renderer via `<iframe>` with a
 * `data:application/pdf;base64,…` URL. Tauri's WebView (WebKit on macOS,
 * WebView2 on Windows) renders PDFs natively, so this works without
 * bundling PDF.js. PDF.js can be swapped in later to gain per-click
 * coordinate capture — for now we surface the SyncTeX forward handler via
 * a small overlay button the user can drop on the page they care about.
 *
 * The iframe is keyed on the PDF path, so switching builds re-creates the
 * element and forces the viewer to forget its scroll position. This is
 * the right default: a new compile usually invalidates the previous view.
 */
export function TexPdfViewer(props: {
  pdfPath: string
  /**
   * Optional SyncTeX callback invoked when the user confirms "jump to
   * current page / coordinates". The builder pane wires this to
   * `synctex_forward`.
   */
  onJumpToSource?: (input: { page: number; x: number; y: number }) => void
  class?: string
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const [dataUrl, { refetch }] = createResource(
    () => props.pdfPath,
    async (path) => {
      const api = platform.tex
      if (!api) return null
      const b64 = await api.readArtifactBase64(path)
      return `data:application/pdf;base64,${b64}`
    },
  )

  // Re-fetch whenever the path changes (e.g. recompile produced a new build).
  createEffect(
    on(
      () => props.pdfPath,
      () => {
        refetch()
      },
      { defer: true },
    ),
  )

  const [page, setPage] = createSignal<number>(1)

  // Track the current page two ways:
  //   1. User clicks the prev/next arrows -> we set the iframe src to
  //      `<url>#page=N` and update our signal.
  //   2. User scrolls inside the iframe -> WebKit's native PDF renderer
  //      auto-updates `iframe.contentWindow.location.hash` to `#page=N`.
  //      No read-back event exists, so poll the hash on a short interval
  //      and resync the header label. Cross-origin reads on data: URL
  //      iframes can throw in some Tauri builds; swallow + give up
  //      gracefully so the manual arrows still work.
  let iframeRef: HTMLIFrameElement | undefined
  let pollHandle: ReturnType<typeof setInterval> | undefined

  const readHashPage = (): number | undefined => {
    const el = iframeRef
    if (!el) return undefined
    try {
      const hash = el.contentWindow?.location.hash ?? ""
      const match = /[#&]page=(\d+)/.exec(hash)
      if (!match) return undefined
      const value = parseInt(match[1], 10)
      return Number.isFinite(value) && value > 0 ? value : undefined
    } catch {
      // Cross-origin block — abandon polling on first throw.
      if (pollHandle) {
        clearInterval(pollHandle)
        pollHandle = undefined
      }
      return undefined
    }
  }

  const startPolling = () => {
    if (pollHandle) return
    pollHandle = setInterval(() => {
      const next = readHashPage()
      if (next === undefined) return
      if (next === page()) return
      setPage(next)
    }, 200)
  }

  const navigateTo = (nextPage: number) => {
    setPage(nextPage)
    const el = iframeRef
    const url = dataUrl()
    if (!el || !url) return
    // Re-point the iframe at `#page=N` to scroll the WebView renderer.
    el.src = `${url}#page=${nextPage}`
  }

  onCleanup(() => {
    if (pollHandle) {
      clearInterval(pollHandle)
      pollHandle = undefined
    }
  })

  return (
    <div
      class={
        "relative h-full w-full flex flex-col bg-background-stronger " + (props.class ?? "")
      }
      data-component="tex-pdf-viewer"
    >
      <div class="flex items-center justify-between shrink-0 px-3 py-2 text-12-regular text-text-weak border-b border-border-weaker-base">
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="px-2 py-0.5 rounded hover:bg-background-weaker-base"
            onClick={() => navigateTo(Math.max(1, page() - 1))}
            aria-label={language.t("tex.pdf.prev")}
          >
            ‹
          </button>
          <span>
            {language.t("tex.pdf.page")} {page()}
          </span>
          <button
            type="button"
            class="px-2 py-0.5 rounded hover:bg-background-weaker-base"
            onClick={() => navigateTo(page() + 1)}
            aria-label={language.t("tex.pdf.next")}
          >
            ›
          </button>
        </div>
        <Show when={props.onJumpToSource}>
          {(handler) => (
            <button
              type="button"
              class="px-2 py-0.5 rounded hover:bg-background-weaker-base"
              title={language.t("tex.pdf.jumpToSource.hint")}
              onClick={() => handler()({ page: page(), x: 50, y: 50 })}
            >
              {language.t("tex.pdf.jumpToSource")}
            </button>
          )}
        </Show>
      </div>

      <div class="flex-1 min-h-0">
        <Show
          when={dataUrl()}
          fallback={
            <div class="h-full flex items-center justify-center text-12-regular text-text-weak">
              {language.t("tex.build.status.compiling")}
            </div>
          }
        >
          {(url) => (
            <iframe
              ref={(el) => {
                iframeRef = el
              }}
              src={url()}
              class="w-full h-full border-0 bg-white"
              title={language.t("tex.pdf.title")}
              onLoad={() => startPolling()}
            />
          )}
        </Show>
      </div>
    </div>
  )
}
