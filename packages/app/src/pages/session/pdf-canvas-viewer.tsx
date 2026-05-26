// IMPORTANT: this import must come first — see pdf-polyfills.ts for why.
import "./pdf-polyfills"
import * as pdfjsLib from "pdfjs-dist"
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url"
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist"
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, untrack } from "solid-js"
import { useLanguage } from "@/context/language"

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Generic PDF canvas viewer with cursor-anchored zoom.
 *
 * Renders the PDF via PDF.js into per-page <canvas> elements in the host
 * DOM (not an iframe). This is what makes trackpad pinch + cursor-anchored
 * zoom possible: events fire on our scroll container, so we can capture
 * `wheel+ctrlKey` (macOS synthesises this from trackpad pinch) and the
 * Safari-specific `gesturestart/change/end` events without the iframe
 * boundary swallowing them.
 *
 * Zoom strategy is two-tier for smooth UX:
 *   - `displayZoom` drives instant CSS sizing of each page wrapper, so the
 *     scroll container's scroll geometry tracks the user's intent in real
 *     time (no flicker, no scrollbar jumps).
 *   - `renderedScale` (per-page) records the resolution the canvas bitmap
 *     was last rendered at. After ~150 ms of zoom stability the visible
 *     pages re-render at the new `displayZoom × DPR` so the bitmap stays
 *     pixel-sharp. Between re-renders the browser interpolates — slightly
 *     soft, never flickery.
 *
 * Consumers supply the PDF bytes (raw Uint8Array, base64 string, or a
 * `data:application/pdf;base64,…` URL) and optionally a controlled zoom
 * value + `onZoomChange` callback for two-way binding with an external
 * toolbar.
 */
export const PDF_ZOOM_MIN = 0.25
export const PDF_ZOOM_MAX = 6
export const PDF_ZOOM_STEP = 0.25
export const PDF_ZOOM_DEFAULT = 1

export const clampZoom = (z: number) => Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, z))

// Debounce window after the last zoom change before re-rendering visible
// page bitmaps at the new resolution. Long enough that an in-progress pinch
// gesture doesn't fire a render per frame, short enough that the user sees
// crisp text again almost as soon as they stop zooming.
const RENDER_DEBOUNCE_MS = 150

// CSS-px per gesture / wheel unit. `Math.exp(-deltaY * WHEEL_ZOOM_RATE)`
// gives the smooth multiplicative zoom curve Figma / Photoshop use.
const WHEEL_ZOOM_RATE = 0.01

// Cap DPR for bitmap rendering. Retina is 2; 3+ blows memory without much
// added perceived sharpness for PDF text.
const MAX_RENDER_DPR = 2

type PageInfo = {
  index: number
  width: number // CSS px at scale 1
  height: number // CSS px at scale 1
}

type PageDom = {
  wrapper: HTMLDivElement
  canvas: HTMLCanvasElement
  renderedScale: number // scale * DPR the canvas bitmap was rendered at
  renderTask?: RenderTask
}

export type PdfSource =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "base64"; base64: string }
  | { kind: "data-url"; url: string }
  | { kind: "loader"; load: () => Promise<Uint8Array> }

export type PdfCanvasViewerProps = {
  source: PdfSource
  /** Stable key for the source — used to refetch when the underlying PDF changes. */
  sourceKey: string
  /** Controlled zoom (1 = 100%). When omitted, viewer manages zoom internally. */
  zoom?: number
  /** Fires when the user drives zoom via wheel/gesture/button. */
  onZoomChange?: (zoom: number) => void
  /** Default zoom when uncontrolled. Defaults to PDF_ZOOM_DEFAULT. */
  defaultZoom?: number
  /** Hide the built-in page nav + zoom strip header. */
  hideHeader?: boolean
  /** Hide just the zoom strip (header still shows page nav). */
  hideZoomControls?: boolean
  /** Extra controls to slot into the header's right-hand cluster. */
  headerTrailing?: () => unknown
  /** Slot before page nav (left-hand). Useful for custom title labels. */
  headerLeading?: () => unknown
  /** Disable trackpad pinch / Cmd+wheel zoom intercept (read-only mode). */
  disableZoomGestures?: boolean
  class?: string
  /** Notified once the document has loaded (page count is known). */
  onLoaded?: (info: { numPages: number }) => void
  /** Notified when the currently-visible page (via IntersectionObserver) changes. */
  onPageChange?: (page: number) => void
}

const decodeBase64ToBytes = (b64: string): Uint8Array => {
  const clean = b64.replace(/^data:[^;]+;base64,/, "")
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const sourceToBytes = async (source: PdfSource): Promise<Uint8Array> => {
  switch (source.kind) {
    case "bytes":
      return source.bytes
    case "base64":
      return decodeBase64ToBytes(source.base64)
    case "data-url":
      return decodeBase64ToBytes(source.url)
    case "loader":
      return await source.load()
  }
}

export function PdfCanvasViewer(props: PdfCanvasViewerProps) {
  const language = useLanguage()

  // ─── Document loading ────────────────────────────────────────────────
  const [doc] = createResource<PDFDocumentProxy | null, string>(
    () => props.sourceKey,
    async () => {
      const bytes = await sourceToBytes(props.source)
      // getDocument transfers the buffer; slice so a subsequent refetch
      // (recompile / new artifact) doesn't see a detached ArrayBuffer.
      // cMapUrl / standardFontDataUrl serve pdfjs the character maps and
      // standard PDF fonts. Without them the renderer substitutes ASCII
      // fallbacks for math symbols (∂→@), accented characters (ö→o), and
      // ligatures (fi→" "). The `/pdfjs/` prefix is served from
      // pdfjs-dist's own `cmaps/` and `standard_fonts/` directories by
      // the `opencode-desktop:pdfjs-assets` plugin in `packages/app/vite.js`.
      //
      // URLs MUST be absolute. pdfjs's worker resolves relative URLs
      // against the worker's own location (under `node_modules/...` in
      // dev), not against the page origin, so a relative `/pdfjs/...`
      // string never reaches the static asset middleware.
      // We pin `pdfjs-dist@5.4.624`: 5.5+ adopted
      // `Map.prototype.getOrInsertComputed` (TC39 upsert proposal)
      // which the Tauri WKWebView lacks AND introduced a second WebKit
      // regression in the Type 1 → CFF font-conversion path that
      // breaks ligatures + math symbols + accents on Tectonic /
      // pdflatex output (Computer Modern). 5.4.624 renders our
      // manuscripts correctly with default config. Refs:
      // mozilla/pdf.js#20143, #16836.
      const doc = await pdfjsLib.getDocument({
        data: bytes.slice().buffer as ArrayBuffer,
      }).promise
      props.onLoaded?.({ numPages: doc.numPages })
      return doc
    },
  )

  // ─── Page metadata (intrinsic size at scale=1) ───────────────────────
  const [pages, setPages] = createSignal<PageInfo[]>([])
  createEffect(() => {
    const d = doc()
    if (!d) {
      setPages([])
      return
    }
    let cancelled = false
    ;(async () => {
      const items: PageInfo[] = []
      for (let i = 1; i <= d.numPages; i++) {
        const p = await d.getPage(i)
        const v = p.getViewport({ scale: 1 })
        items.push({ index: i, width: v.width, height: v.height })
      }
      if (!cancelled) setPages(items)
    })()
    onCleanup(() => {
      cancelled = true
    })
  })

  // ─── Zoom state ──────────────────────────────────────────────────────
  // Authoritative state lives here. When a parent controls zoom via
  // `props.zoom`, an effect mirrors prop changes into this signal. The
  // wheel→emit→parent→prop loop is broken by the `clamped === displayZoom`
  // short-circuit in that effect (see below).
  const initialZoom = clampZoom(props.zoom ?? props.defaultZoom ?? PDF_ZOOM_DEFAULT)
  const [displayZoom, setDisplayZoom] = createSignal(initialZoom)

  // Container width tracked reactively so symmetric padding (and
  // anything else that depends on container size) updates on resize.
  const [containerWidth, setContainerWidth] = createSignal(0)

  // Horizontal padding that centers a single page when it's narrower
  // than the scroll container, falling back to a small fixed inset once
  // it overflows. Continuous in zoom so applyZoomAroundPoint's anchor
  // math doesn't see a discontinuity.
  const PAGE_PAD_MIN = 8
  const pagePadding = createMemo(() => {
    const pp = pages()
    if (pp.length === 0) return PAGE_PAD_MIN
    // Widest intrinsic page; in practice all pages of a paper are the same.
    let widest = 0
    for (const p of pp) if (p.width > widest) widest = p.width
    const renderedW = widest * displayZoom()
    const cw = containerWidth()
    if (cw === 0) return PAGE_PAD_MIN
    return Math.max(PAGE_PAD_MIN, Math.floor((cw - renderedW) / 2))
  })

  let scrollRef: HTMLDivElement | undefined

  // Sync external `props.zoom` into internal `displayZoom`. The
  // `clamped === displayZoom` short-circuit breaks the
  // wheel→emit→parent→prop loop: by the time the prop change echoes back
  // in, `displayZoom` already equals it. No isLocalDrive flag needed —
  // an earlier such flag silently dropped fast successive prop changes
  // (e.g. rapid toolbar button clicks) because all hit the effect inside
  // a single synchronous flush window.
  createEffect(
    on(
      () => props.zoom,
      (next) => {
        if (next == null) return
        const clamped = clampZoom(next)
        if (clamped === untrack(displayZoom)) return
        // External zoom change (toolbar button). Anchor at viewport center.
        const container = scrollRef
        if (container) {
          const rect = container.getBoundingClientRect()
          applyZoomAroundPoint(clamped, rect.left + rect.width / 2, rect.top + rect.height / 2, /*emit*/ false)
        } else {
          setDisplayZoom(clamped)
        }
      },
      { defer: true },
    ),
  )

  const emitZoom = (z: number) => {
    props.onZoomChange?.(z)
  }

  // ─── Page DOM bookkeeping ────────────────────────────────────────────
  const pageDom = new Map<number, PageDom>()

  const setRefs = (idx: number, wrapper: HTMLDivElement, canvas: HTMLCanvasElement) => {
    const existing = pageDom.get(idx)
    if (existing) {
      existing.wrapper = wrapper
      existing.canvas = canvas
    } else {
      pageDom.set(idx, { wrapper, canvas, renderedScale: 0 })
    }
    // Solid runs ref callbacks BEFORE applying style/attribute props on the
    // same element. At this moment the wrapper has not been sized/positioned,
    // so getBoundingClientRect() returns 0×0 — `queueRenderIfVisible` would
    // see visible=false and bail (and the IntersectionObserver fired with
    // the zero-rect doesn't fire a second callback for the post-layout
    // size on WebKit). Defer one rAF so layout has committed the styled
    // width/height before the visibility test runs.
    requestAnimationFrame(() => {
      queueRenderIfVisible(idx)
    })
  }

  const observer = createMemo<IntersectionObserver | null>((prev) => {
    if (prev) prev.disconnect()
    const root = scrollRef
    if (!root || pages().length === 0) return null
    return new IntersectionObserver(
      (entries) => {
        let best: { idx: number; ratio: number } | undefined
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const idx = Number((entry.target as HTMLElement).dataset.page)
          if (!Number.isFinite(idx)) continue
          if (!best || entry.intersectionRatio > best.ratio) {
            best = { idx, ratio: entry.intersectionRatio }
          }
          queueRender(idx, displayZoom())
        }
        if (best) setPage(best.idx)
      },
      {
        root,
        rootMargin: "200px 0px 200px 0px",
        threshold: [0, 0.1, 0.5, 0.9, 1],
      },
    )
  })

  createEffect(() => {
    const obs = observer()
    if (!obs) return
    for (const dom of pageDom.values()) obs.observe(dom.wrapper)
    onCleanup(() => obs.disconnect())
  })

  // ─── Canvas rendering ────────────────────────────────────────────────
  const renderPending = new Set<number>()
  let renderDebounce: ReturnType<typeof setTimeout> | undefined

  const queueRender = (idx: number, targetZoom: number) => {
    const dom = pageDom.get(idx)
    if (!dom) return
    const targetScale = targetZoom * Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR)
    if (Math.abs(dom.renderedScale - targetScale) / Math.max(targetScale, 0.0001) < 0.01) return
    renderPending.add(idx)
    if (renderDebounce) clearTimeout(renderDebounce)
    renderDebounce = setTimeout(flushRenders, RENDER_DEBOUNCE_MS)
  }

  const queueRenderIfVisible = (idx: number) => {
    const dom = pageDom.get(idx)
    const root = scrollRef
    if (!dom || !root) return
    const rect = dom.wrapper.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const visible = rect.bottom > rootRect.top - 200 && rect.top < rootRect.bottom + 200
    if (visible) queueRender(idx, displayZoom())
  }

  const flushRenders = async () => {
    renderDebounce = undefined
    const d = doc()
    if (!d) return
    const z = displayZoom()
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_RENDER_DPR)
    const targetScale = z * dpr
    const ids = [...renderPending]
    renderPending.clear()
    for (const idx of ids) {
      const dom = pageDom.get(idx)
      if (!dom) continue
      if (dom.renderTask) {
        try {
          dom.renderTask.cancel()
        } catch {
          // ignore
        }
      }
      try {
        const page = await d.getPage(idx)
        const viewport = page.getViewport({ scale: targetScale })
        const canvas = dom.canvas
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        // PDF.js v5: pass the canvas directly. Passing `canvasContext`
        // alongside is deprecated and (per the v5 API docs) requires
        // `canvas: null` to take effect — otherwise the rendered output
        // is silently dropped onto the wrong target.
        const task = page.render({ canvas, viewport })
        dom.renderTask = task
        try {
          await task.promise
          dom.renderedScale = targetScale
        } catch (err) {
          if ((err as any)?.name !== "RenderingCancelledException") {
            // eslint-disable-next-line no-console
            console.warn(`pdf render failed for page ${idx}`, err)
          }
        } finally {
          dom.renderTask = undefined
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`pdf getPage failed for page ${idx}`, err)
      }
    }
  }

  createEffect(
    on(displayZoom, (z) => {
      for (const idx of pageDom.keys()) queueRender(idx, z)
    }),
  )

  // ─── Cursor-anchored zoom math ───────────────────────────────────────
  // Pick the visible page whose rect contains the cursor (or the
  // best-overlapping one) to use as the zoom anchor. We anchor in
  // *content-relative* coordinates (fraction of page width/height under
  // cursor) so the math is robust to layout changes that the scroll
  // container doesn't see — e.g. the symmetric `pagePadding` shrinking
  // as `displayZoom` grows. Anchoring via raw `scrollLeft + mx` (as the
  // previous implementation did) assumes the wrapper's left position
  // is a linear function of zoom; with continuous-but-not-linear
  // padding it isn't, so cursor anchoring drifted across the
  // narrow→wide transition and produced visible "snaps" on `+` clicks.
  const pickAnchorWrapper = (clientX: number, clientY: number): HTMLDivElement | undefined => {
    let best: { dom: HTMLDivElement; dist: number } | undefined
    for (const dom of pageDom.values()) {
      const r = dom.wrapper.getBoundingClientRect()
      // Inside?
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return dom.wrapper
      }
      // Otherwise minimise distance to the wrapper's vertical span — most
      // useful when the cursor sits in the gap between pages.
      const dy =
        clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0
      const dx =
        clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
      const dist = dx + dy
      if (!best || dist < best.dist) best = { dom: dom.wrapper, dist }
    }
    return best?.dom
  }

  const applyZoomAroundPoint = (newZoom: number, clientX: number, clientY: number, emit: boolean) => {
    const container = scrollRef
    if (!container) {
      setDisplayZoom(clampZoom(newZoom))
      if (emit) emitZoom(clampZoom(newZoom))
      return
    }
    const clamped = clampZoom(newZoom)
    const oldZoom = untrack(displayZoom)
    if (clamped === oldZoom) return
    const anchor = pickAnchorWrapper(clientX, clientY)
    if (!anchor) {
      setDisplayZoom(clamped)
      if (emit) emitZoom(clamped)
      return
    }
    const oldRect = anchor.getBoundingClientRect()
    const fx = oldRect.width > 0 ? (clientX - oldRect.left) / oldRect.width : 0.5
    const fy = oldRect.height > 0 ? (clientY - oldRect.top) / oldRect.height : 0.5
    setDisplayZoom(clamped)
    if (emit) emitZoom(clamped)
    // Solid commits style.width/height synchronously on the page wrappers,
    // but the browser doesn't flush layout until after this microtask
    // returns. One rAF lands BEFORE the post-layout repaint on
    // WebKit/Chromium, so the rect we'd read would still be stale.
    // Wait two rAFs and read forcibly-up-to-date layout.
    requestAnimationFrame(() => {
      // Force layout commit before measuring.
      void container.scrollHeight
      requestAnimationFrame(() => {
        const newRect = anchor.getBoundingClientRect()
        const cRect = container.getBoundingClientRect()
        const newTargetX = newRect.left + fx * newRect.width
        const newTargetY = newRect.top + fy * newRect.height
        container.scrollLeft += newTargetX - clientX
        container.scrollTop += newTargetY - clientY
      })
    })
  }

  // ─── Wheel handler ────────────────────────────────────────────────────
  let inGesture = false

  const onWheel = (e: WheelEvent) => {
    if (props.disableZoomGestures) return
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    if (inGesture) return
    const oldZoom = untrack(displayZoom)
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_RATE)
    const newZoom = clampZoom(oldZoom * factor)
    if (newZoom === oldZoom) return
    applyZoomAroundPoint(newZoom, e.clientX, e.clientY, /*emit*/ true)
  }

  // ─── macOS Safari gesture events ─────────────────────────────────────
  let gestureBaseZoom = PDF_ZOOM_DEFAULT
  let gestureAnchor = { x: 0, y: 0 }

  const onGestureStart = (e: Event) => {
    if (props.disableZoomGestures) return
    e.preventDefault()
    inGesture = true
    gestureBaseZoom = untrack(displayZoom)
    const ge = e as unknown as { clientX: number; clientY: number }
    gestureAnchor = { x: ge.clientX, y: ge.clientY }
  }
  const onGestureChange = (e: Event) => {
    if (props.disableZoomGestures) return
    e.preventDefault()
    const ge = e as unknown as { scale: number }
    const newZoom = clampZoom(gestureBaseZoom * ge.scale)
    applyZoomAroundPoint(newZoom, gestureAnchor.x, gestureAnchor.y, /*emit*/ true)
  }
  const onGestureEnd = (e: Event) => {
    if (props.disableZoomGestures) return
    e.preventDefault()
    inGesture = false
  }

  const attachZoomListeners = (el: HTMLDivElement) => {
    el.addEventListener("wheel", onWheel, { passive: false })
    el.addEventListener("gesturestart" as any, onGestureStart, { passive: false } as any)
    el.addEventListener("gesturechange" as any, onGestureChange, { passive: false } as any)
    el.addEventListener("gestureend" as any, onGestureEnd, { passive: false } as any)
    onCleanup(() => {
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("gesturestart" as any, onGestureStart as any)
      el.removeEventListener("gesturechange" as any, onGestureChange as any)
      el.removeEventListener("gestureend" as any, onGestureEnd as any)
    })
  }

  // ─── Native macOS pinch via window CustomEvent ───────────────────────
  // WebKit on shipping macOS does NOT deliver trackpad pinch to web JS
  // (gesturestart never fires; pinch is not synthesised to wheel+ctrlKey
  // like Chrome does internally). The Rust side installs an
  // `NSMagnificationGestureRecognizer` on the WKWebView and emits a
  // `gpd:pinch` Tauri event for each gesture frame; the desktop entry
  // point at `packages/desktop/src/index.tsx` re-dispatches that as a
  // `window` CustomEvent so this platform-agnostic component doesn't
  // need a `@tauri-apps/api` dependency. The payload's `x` / `y` are in
  // CSS px from the WKWebView's top-left, identical to what `clientX` /
  // `clientY` would be on a DOM event.
  type PinchPayload = {
    phase: "began" | "changed" | "ended" | "cancelled"
    magnification: number
    x: number
    y: number
  }
  let pinchBaseZoom = PDF_ZOOM_DEFAULT
  let pinchAnchor = { x: 0, y: 0 }
  const onPinch = (ev: Event) => {
    if (props.disableZoomGestures) return
    const detail = (ev as CustomEvent<PinchPayload>).detail
    if (!detail) return
    const container = scrollRef
    if (!container) return
    const rect = container.getBoundingClientRect()
    const inside =
      detail.x >= rect.left && detail.x <= rect.right && detail.y >= rect.top && detail.y <= rect.bottom
    if (!inside) return
    if (detail.phase === "began") {
      inGesture = true
      pinchBaseZoom = untrack(displayZoom)
      pinchAnchor = { x: detail.x, y: detail.y }
      return
    }
    if (detail.phase === "ended" || detail.phase === "cancelled") {
      inGesture = false
      return
    }
    const newZoom = clampZoom(pinchBaseZoom * (1 + detail.magnification))
    applyZoomAroundPoint(newZoom, pinchAnchor.x, pinchAnchor.y, /*emit*/ true)
  }
  window.addEventListener("gpd:pinch", onPinch as EventListener)
  onCleanup(() => window.removeEventListener("gpd:pinch", onPinch as EventListener))

  // ─── Page navigation ─────────────────────────────────────────────────
  const [page, setPageInternal] = createSignal<number>(1)
  const setPage = (n: number) => {
    if (untrack(page) === n) return
    setPageInternal(n)
    props.onPageChange?.(n)
  }

  const navigateTo = (nextPage: number) => {
    const target = Math.max(1, Math.min(pages().length || 1, nextPage))
    setPage(target)
    const dom = pageDom.get(target)
    const container = scrollRef
    if (!dom || !container) return
    // `wrapper.offsetTop` is relative to the nearest positioned ancestor,
    // not the scroll container. Our outer root has `position: relative`
    // and sits OUTSIDE the scroller (header + scroller are siblings), so
    // offsetTop would include the header height — scroll target ends up
    // either off by ~36px or, worse, doesn't match the scroller's own
    // coordinate space at all. Use bounding-rect deltas instead: that
    // gives the page wrapper's position in the scroller's current
    // coordinate space, which we then translate into a scrollTop by
    // adding the scroller's existing scrollTop.
    const wrapperTop = dom.wrapper.getBoundingClientRect().top
    const containerTop = container.getBoundingClientRect().top
    const target_y = container.scrollTop + (wrapperTop - containerTop) - 8
    container.scrollTo({ top: target_y, behavior: "smooth" })
  }

  // ─── Uncontrolled-mode zoom strip handlers ───────────────────────────
  const zoomFromCenter = (next: number) => {
    const container = scrollRef
    if (!container) {
      setDisplayZoom(clampZoom(next))
      emitZoom(clampZoom(next))
      return
    }
    const rect = container.getBoundingClientRect()
    applyZoomAroundPoint(next, rect.left + rect.width / 2, rect.top + rect.height / 2, /*emit*/ true)
  }
  const zoomIn = () => zoomFromCenter(untrack(displayZoom) + PDF_ZOOM_STEP)
  const zoomOut = () => zoomFromCenter(untrack(displayZoom) - PDF_ZOOM_STEP)
  const zoomReset = () => zoomFromCenter(PDF_ZOOM_DEFAULT)
  const showZoomStrip = () => props.zoom === undefined && !props.hideZoomControls

  // Clean up doc and any in-flight render tasks on unmount / source change.
  onCleanup(() => {
    if (renderDebounce) clearTimeout(renderDebounce)
    for (const dom of pageDom.values()) {
      try {
        dom.renderTask?.cancel()
      } catch {
        // ignore
      }
    }
    pageDom.clear()
  })
  createEffect(
    on(
      () => props.sourceKey,
      () => {
        pageDom.clear()
        setPage(1)
        if (scrollRef) {
          scrollRef.scrollTop = 0
          scrollRef.scrollLeft = 0
        }
      },
      { defer: true },
    ),
  )

  return (
    <div class={"relative h-full w-full min-w-0 flex flex-col bg-background-stronger overflow-hidden " + (props.class ?? "")}>
      <Show when={!props.hideHeader}>
        <div class="flex items-center justify-between shrink-0 px-3 py-2 text-12-regular text-text-weak border-b border-border-weaker-base">
          <div class="flex items-center gap-2">
            {props.headerLeading?.() as any}
            <button
              type="button"
              class="px-2 py-0.5 rounded hover:bg-background-weaker-base"
              onClick={() => navigateTo(page() - 1)}
              aria-label={language.t("tex.pdf.prev")}
            >
              ‹
            </button>
            <span>
              {language.t("tex.pdf.page")} {page()}
              <Show when={pages().length > 0}> / {pages().length}</Show>
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
          <div class="flex items-center gap-2">
            <Show when={showZoomStrip()}>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="px-2 py-0.5 rounded hover:bg-background-weaker-base disabled:opacity-40 disabled:hover:bg-transparent"
                  onClick={zoomOut}
                  disabled={displayZoom() <= PDF_ZOOM_MIN + 1e-6}
                  aria-label={language.t("tex.pdf.zoomOut")}
                  title={language.t("tex.pdf.zoomOut")}
                >
                  −
                </button>
                <button
                  type="button"
                  class="px-2 py-0.5 rounded hover:bg-background-weaker-base text-12-regular tabular-nums min-w-[3.5em] text-center"
                  onClick={zoomReset}
                  aria-label={language.t("tex.pdf.zoomReset")}
                  title={language.t("tex.pdf.zoomReset")}
                >
                  {Math.round(displayZoom() * 100)}%
                </button>
                <button
                  type="button"
                  class="px-2 py-0.5 rounded hover:bg-background-weaker-base disabled:opacity-40 disabled:hover:bg-transparent"
                  onClick={zoomIn}
                  disabled={displayZoom() >= PDF_ZOOM_MAX - 1e-6}
                  aria-label={language.t("tex.pdf.zoomIn")}
                  title={language.t("tex.pdf.zoomIn")}
                >
                  +
                </button>
              </div>
            </Show>
            {props.headerTrailing?.() as any}
          </div>
        </div>
      </Show>

      <div
        class="flex-1 min-h-0 overflow-auto"
        ref={(el) => {
          scrollRef = el
          attachZoomListeners(el)
          setContainerWidth(el.clientWidth)
          const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth))
          ro.observe(el)
          onCleanup(() => ro.disconnect())
        }}
        data-component="pdf-canvas-viewer-scroll"
      >
        <Show
          when={pages().length > 0}
          fallback={
            <div class="h-full flex items-center justify-center text-12-regular text-text-weak">
              <Show when={doc.error} fallback={language.t("tex.pdf.loading")}>
                {language.t("tex.pdf.error")}
              </Show>
            </div>
          }
        >
          <div
            class="flex flex-col gap-2 py-2 items-start"
            style={{
              // Visual centering when content is narrower than the
              // scroll container, switching smoothly to flush-left when
              // it overflows.
              //
              // `align-items: safe center` was tried first, but it flips
              // discretely from `center` to `start` when content width
              // crosses the container width. That made `+` zoom clicks
              // appear to *snap* — applyZoomAroundPoint's world-coord
              // math assumes the wrapper's left position scales linearly
              // with displayZoom, but the alignment flip introduces a
              // ~(container-page)/2 jump exactly at the crossover.
              //
              // Symmetric horizontal padding sized to `max(8, (container
              // - page)/2)` is continuous (stays at the floor of 8 once
              // page ≥ container) so the wrapper's left position is a
              // smooth function of zoom and the cursor-anchor stays put.
              "padding-left": `${pagePadding()}px`,
              "padding-right": `${pagePadding()}px`,
            }}
          >
            <For each={pages()}>
              {(p) => {
                // Register the page in `pageDom` from whichever ref callback
                // fires LAST — Solid runs parent ref before child ref, but
                // we don't want to depend on that ordering (and we don't
                // want a queueMicrotask gap during which a Next-click could
                // see an empty pageDom and silently no-op).
                let wrapper: HTMLDivElement | undefined
                let canvas: HTMLCanvasElement | undefined
                const tryRegister = () => {
                  if (wrapper && canvas) setRefs(p.index, wrapper, canvas)
                }
                return (
                  <div
                    ref={(el) => {
                      wrapper = el
                      tryRegister()
                      const obs = observer()
                      if (obs) obs.observe(el)
                    }}
                    data-page={p.index}
                    class="bg-white shadow-sm"
                    style={{
                      width: `${p.width * displayZoom()}px`,
                      height: `${p.height * displayZoom()}px`,
                    }}
                  >
                    <canvas
                      ref={(el) => {
                        canvas = el
                        tryRegister()
                      }}
                      style={{ width: "100%", height: "100%", display: "block" }}
                    />
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
