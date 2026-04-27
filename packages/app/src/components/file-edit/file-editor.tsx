import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Compartment, EditorState, type Extension } from "@codemirror/state"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view"
import { indentWithTab } from "@codemirror/commands"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { showToast } from "@opencode-ai/ui/toast"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import type { FileWriteConflict, FileWriteResult } from "@opencode-ai/sdk/v2"
import { detectLanguage, type EditorLanguage } from "./eligibility"
import { useEditorRegistry } from "./editor-registry"
import { ConflictDialog } from "./conflict-dialog"
import { FilePreview, previewKind, type EditorMode } from "./preview"
import { StaleBanner } from "./stale-banner"

type Content = {
  content: string
  hash?: string
}

type Props = {
  path: string
  content: Content
  renderTexPreview?: () => JSX.Element
}

type Loader = () => Promise<Extension>

const loaders: Record<Exclude<EditorLanguage, undefined>, Loader> = {
  markdown: async () => {
    const mod = await import("@codemirror/lang-markdown")
    return mod.markdown()
  },
  python: async () => {
    const mod = await import("@codemirror/lang-python")
    return mod.python()
  },
  javascript: async () => {
    const mod = await import("@codemirror/lang-javascript")
    return mod.javascript({ jsx: true, typescript: true })
  },
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function text(value: unknown) {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (!record(value)) return undefined
  const message = value.message
  if (typeof message === "string") return message
  return undefined
}

function conflict(value: unknown): FileWriteConflict | undefined {
  if (!record(value)) return
  if (value.ok !== false) return
  if (value.reason !== "conflict") return
  if (typeof value.currentContent !== "string") return
  if (typeof value.currentHash !== "string") return
  return {
    ok: false,
    reason: "conflict",
    currentContent: value.currentContent,
    currentHash: value.currentHash,
  }
}

function success(value: unknown): FileWriteResult | undefined {
  if (!record(value)) return
  if (value.ok !== true) return
  if (typeof value.hash !== "string") return
  return { ok: true, hash: value.hash }
}

async function conflictError(value: unknown): Promise<FileWriteConflict | undefined> {
  const issue = conflict(value)
  if (issue) return issue

  if (record(value)) {
    const err = conflict(value.error)
    if (err) return err

    const res = value.response
    if (res instanceof Response && res.status === 409) {
      try {
        return conflict(await res.clone().json())
      } catch {
        return
      }
    }
  }
}

export function FileEditor(props: Props) {
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const registry = useEditorRegistry()
  const sdk = useSDK()

  let host!: HTMLDivElement
  let view: EditorView | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let remove: (() => void) | undefined
  let unlisten: (() => void) | undefined

  const [rev, setRev] = createSignal(0)
  const [base, setBase] = createSignal(props.content.hash ?? "")
  const [saved, setSaved] = createSignal(props.content.content)
  const [saving, setSaving] = createSignal(false)
  const [issue, setIssue] = createSignal<FileWriteConflict | undefined>()
  const [open, setOpen] = createSignal(false)
  const [stale, setStale] = createSignal(false)
  const [banner, setBanner] = createSignal(false)
  const kind = createMemo(() => previewKind(props.path))
  const [mode, setMode] = createSignal<EditorMode>(
    file.editor(props.path)?.mode === "preview" && kind() ? "preview" : "source",
  )

  const draft = () => {
    rev()
    return view?.state.doc.toString() ?? props.content.content
  }
  const dirty = createMemo(() => draft() !== saved())
  const status = createMemo(() => {
    if (issue()) return "conflict"
    if (saving()) return "saving"
    if (stale()) return "stale"
    if (dirty()) return "dirty"
    return "clean"
  })
  const label = createMemo(() => {
    const current = status()
    if (current === "conflict") return language.t("file.editor.status.conflict")
    if (current === "saving") return language.t("file.editor.status.saving")
    if (current === "stale") return language.t("file.editor.status.stale")
    if (current === "dirty") return language.t("file.editor.status.dirty")
    return language.t("file.editor.status.clean")
  })

  const replace = (content: string) => {
    if (!view) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: 0 },
    })
    setRev((value) => value + 1)
  }

  const persist = () => {
    if (!view) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!view) return
      file.setEditor(props.path, {
        mode: mode(),
        cursor: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
        scrollTop: view.scrollDOM.scrollTop,
        scrollLeft: view.scrollDOM.scrollLeft,
      })
    }, 250)
  }

  const change = (next: EditorMode) => {
    if (next === "preview" && !kind()) return
    setMode(next)
    file.setEditor(props.path, {
      ...file.editor(props.path),
      mode: next,
    })
  }

  const reload = async () => {
    await file.load(props.path, { force: true })
    const content = file.get(props.path)?.content
    if (!content || content.type !== "text") return
    replace(content.content)
    setSaved(content.content)
    setBase(content.hash)
    setIssue(undefined)
    setOpen(false)
    setStale(false)
    setBanner(false)
  }

  const save = async (expected = base()) => {
    if (saving()) return { ok: false, reason: "io" as const }

    if (!expected) {
      showToast({
        variant: "error",
        title: language.t("file.editor.save.failed.title"),
        description: language.t("file.editor.save.missingHash"),
      })
      return { ok: false, reason: "io" as const, error: language.t("file.editor.save.missingHash") }
    }

    const start = Date.now()
    setSaving(true)
    const out = await sdk.client.file
      .write({ path: props.path, expectedHash: expected, content: draft() })
      .then((res) => ({ ok: true as const, res }), (err: unknown) => ({ ok: false as const, err }))
    setSaving(false)

    if (!out.ok) {
      const issue = await conflictError(out.err)
      if (issue) {
        setIssue(issue)
        setOpen(true)
        return { ok: false, reason: "conflict" as const }
      }
      showToast({
        variant: "error",
        title: language.t("file.editor.save.failed.title"),
        description: text(out.err),
      })
      return { ok: false, reason: "io" as const, error: text(out.err) }
    }

    const data = out.res.data
    const ok = success(data)
    if (ok) {
      setBase(ok.hash)
      setSaved(draft())
      setIssue(undefined)
      setOpen(false)
      setStale(false)
      setBanner(false)
      if (Date.now() - start > 800) {
        showToast({
          variant: "success",
          title: language.t("file.editor.save.success.title"),
        })
      }
      void file.load(props.path, { force: true })
      return { ok: true as const }
    }

    const issue = conflict(data) ?? (await conflictError(out.res.error)) ?? (await conflictError(out.res))
    if (issue) {
      setIssue(issue)
      setOpen(true)
      return { ok: false, reason: "conflict" as const }
    }

    showToast({
      variant: "error",
      title: language.t("file.editor.save.failed.title"),
      description: text(out.res.error),
    })
    return { ok: false, reason: "io" as const, error: text(out.res.error) }
  }

  const discard = () => {
    replace(saved())
    setIssue(undefined)
    setOpen(false)
    setStale(false)
    setBanner(false)
  }

  const extensions = (): Extension[] => [
    lineNumbers(),
    foldGutter(),
    history(),
    bracketMatching(),
    indentOnInput(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(false),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged && !update.selectionSet) return
      setRev((value) => value + 1)
      persist()
    }),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        stopPropagation: true,
        run: () => {
          void save()
          return true
        },
      },
      indentWithTab,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    lang.of([]),
  ]

  const lang = new Compartment()

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.content.content,
        extensions: extensions(),
      }),
    })
    view.contentDOM.setAttribute("data-action", "file-editor-input")

    requestAnimationFrame(() => {
      if (!view) return
      const state = file.editor(props.path)
      const top = state?.scrollTop ?? file.scrollTop(props.path)
      const left = state?.scrollLeft ?? file.scrollLeft(props.path)
      const cursor = state?.cursor
      if (cursor) {
        const anchor = Math.min(cursor.anchor, view.state.doc.length)
        const head = Math.min(cursor.head, view.state.doc.length)
        view.dispatch({ selection: { anchor, head }, scrollIntoView: true })
      }
      view.scrollDOM.scrollTop = typeof top === "number" ? top : 0
      view.scrollDOM.scrollLeft = typeof left === "number" ? left : 0
    })

    view.scrollDOM.addEventListener("scroll", persist, { passive: true })
    unlisten = () => view?.scrollDOM.removeEventListener("scroll", persist)

    const mode = detectLanguage(props.path)
    if (mode) {
      loaders[mode]()
        .then((ext) => {
          if (!view) return
          view.dispatch({ effects: lang.reconfigure(ext) })
        })
        .catch(() => {})
    }

    remove = registry.register({
      path: props.path,
      isDirty: dirty,
      isSaving: saving,
      status,
      draft,
      baseHash: base,
      save,
      discard,
      markStale: () => {
        if (!dirty()) return
        setStale(true)
        setBanner(true)
      },
      clearStale: () => {
        setStale(false)
        setBanner(false)
      },
    })
  })

  onCleanup(() => {
    if (timer) clearTimeout(timer)
    unlisten?.()
    remove?.()
    view?.destroy()
    view = undefined
  })

  createEffect(() => {
    const hash = props.content.hash
    if (dirty()) return
    if (hash) setBase(hash)
  })

  createEffect(() => {
    if (kind()) return
    if (mode() === "source") return
    change("source")
  })

  createEffect(() => {
    const content = props.content.content
    if (!view) return
    if (dirty()) return
    if (content === saved()) return
    replace(content)
    setSaved(content)
    setIssue(undefined)
    setStale(false)
    setBanner(false)
  })

  createEffect(() => {
    const conflict = issue()
    if (!conflict) return
    if (!open()) return
    dialog.show(
      () => (
        <ConflictDialog
          draft={draft()}
          issue={conflict}
          saving={saving()}
          onCancel={() => {
            setOpen(false)
            dialog.close()
          }}
          onTake={() => {
            replace(conflict.currentContent)
            setSaved(conflict.currentContent)
            setBase(conflict.currentHash)
            setIssue(undefined)
            setOpen(false)
            setStale(false)
            setBanner(false)
            dialog.close()
            void file.load(props.path, { force: true })
          }}
          onKeep={async () => {
            const out = await save(conflict.currentHash)
            if (!out.ok) return
            dialog.close()
          }}
        />
      ),
      () => setOpen(false),
    )
  })

  return (
    <div class="flex h-full min-h-0 flex-col bg-background" data-component="file-editor">
      <div class="flex h-8 items-center justify-between border-b border-border-weaker-base px-3 text-12-regular text-text-weak">
        <span>{label()}</span>
        <div class="flex items-center gap-2">
          <Show when={kind()}>
            <RadioGroup
              size="small"
              options={["source", "preview"] as EditorMode[]}
              current={mode()}
              label={(item) =>
                item === "source" ? language.t("file.editor.mode.source") : language.t("file.editor.mode.preview")
              }
              onSelect={(item) => {
                if (!item) return
                change(item)
              }}
            />
          </Show>
          <Show when={issue()}>
            <Button size="small" variant="secondary" disabled={saving()} onClick={() => setOpen(true)}>
              {language.t("file.editor.conflict.resolve")}
            </Button>
          </Show>
          <Button size="small" variant="ghost" disabled={saving() || !dirty() || !!issue()} onClick={() => void save()}>
            {saving() ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </div>
      <Show when={stale() && banner()}>
        <StaleBanner
          disabled={saving()}
          onKeep={() => setBanner(false)}
          onReload={() => void reload()}
        />
      </Show>
      <div
        ref={(el) => (host = el)}
        class="min-h-0 flex-1 overflow-hidden text-13-regular [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono"
        classList={{ hidden: mode() !== "source" }}
      />
      <Show when={mode() === "preview" && kind()}>
        {(value) => (
          <div class="min-h-0 flex-1">
            <FilePreview
              content={draft()}
              dirty={dirty()}
              kind={value()}
              path={props.path}
              renderTex={props.renderTexPreview}
              saving={saving()}
              onSave={async () => (await save()).ok}
            />
          </div>
        )}
      </Show>
    </div>
  )
}
