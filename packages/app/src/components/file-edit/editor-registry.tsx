import { createRoot, createSignal } from "solid-js"

export type EditorStatus = "clean" | "dirty" | "saving" | "stale" | "conflict"

export type EditorSaveResult =
  | { ok: true }
  | { ok: false; reason: "conflict" | "io"; error?: string }

export interface RegisteredEditor {
  path: string
  isDirty: () => boolean
  isSaving: () => boolean
  status: () => EditorStatus
  draft: () => string
  baseHash: () => string
  save: () => Promise<EditorSaveResult>
  discard: () => void
  markStale: () => void
  clearStale: () => void
}

const editors = new Map<string, RegisteredEditor>()
const [version, setVersion] = createRoot((dispose) => {
  if (import.meta.hot) import.meta.hot.dispose(dispose)
  return createSignal(0)
})

let unload = false

function bump() {
  setVersion((value) => value + 1)
}

function install() {
  if (unload) return
  if (typeof window === "undefined") return
  unload = true
  window.addEventListener("beforeunload", (event) => {
    if (registry.dirty().length === 0) return
    event.preventDefault()
    event.returnValue = ""
  })
}

const registry = {
  register(ed: RegisteredEditor) {
    install()
    editors.set(ed.path, ed)
    bump()
    return () => {
      if (editors.get(ed.path) !== ed) return
      editors.delete(ed.path)
      bump()
    }
  },
  get(path: string) {
    version()
    return editors.get(path)
  },
  dirty() {
    version()
    return Array.from(editors.values()).filter((ed) => ed.isDirty())
  },
}

export function useEditorRegistry() {
  return registry
}
