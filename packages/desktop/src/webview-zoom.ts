// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import { invoke } from "@tauri-apps/api/core"
import { type as ostype } from "@tauri-apps/plugin-os"
import { createRoot, createSignal } from "solid-js"

const OS_NAME = ostype()

const [webviewZoom, setWebviewZoom] = createRoot((dispose) => {
  if (import.meta.hot) import.meta.hot.dispose(dispose)
  return createSignal(1)
})

const MAX_ZOOM_LEVEL = 10
const MIN_ZOOM_LEVEL = 0.2

const clamp = (value: number) => Math.min(Math.max(value, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL)

const applyZoom = (next: number) => {
  setWebviewZoom(next)
  invoke("plugin:webview|set_webview_zoom", {
    value: next,
  })
}

const handleKeyDown = (event: KeyboardEvent) => {
  if (!(OS_NAME === "macos" ? event.metaKey : event.ctrlKey)) return

  let newZoom = webviewZoom()

  if (event.key === "-") newZoom -= 0.2
  if (event.key === "=" || event.key === "+") newZoom += 0.2
  if (event.key === "0") newZoom = 1

  applyZoom(clamp(newZoom))
}

window.addEventListener("keydown", handleKeyDown)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener("keydown", handleKeyDown)
  })
}

export { webviewZoom }
