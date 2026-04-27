import { For, Match, Show, Switch, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Markdown } from "@opencode-ai/ui/markdown"
import { useLanguage } from "@/context/language"

export type EditorMode = "source" | "preview"
export type PreviewKind = "markdown" | "json" | "bib" | "tex"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function previewKind(path: string | undefined): PreviewKind | undefined {
  if (!path) return
  const lower = path.toLowerCase()
  if (lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".markdown")) return "markdown"
  if (lower.endsWith(".json")) return "json"
  if (lower.endsWith(".bib") || lower.endsWith(".bibtex")) return "bib"
  if (lower.endsWith(".tex")) return "tex"
}

function json(value: unknown): value is Json {
  if (value === null) return true
  if (typeof value === "string") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "boolean") return true
  if (Array.isArray(value)) return value.every(json)
  if (typeof value !== "object") return false
  return Object.values(value as Record<string, unknown>).every(json)
}

export function parseJson(text: string) {
  try {
    const value = JSON.parse(text) as unknown
    if (!json(value)) return { ok: false as const, error: "Unsupported JSON value" }
    return { ok: true as const, value }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}

export function parseBib(text: string) {
  const out: Array<{ type: string; key: string; body: string }> = []
  let at = text.indexOf("@")

  while (at >= 0) {
    const name = /^[A-Za-z]+/.exec(text.slice(at + 1))?.[0]
    if (!name) {
      at = text.indexOf("@", at + 1)
      continue
    }

    const open = text.indexOf("{", at + name.length + 1)
    const paren = text.indexOf("(", at + name.length + 1)
    const start = open >= 0 && (paren < 0 || open < paren) ? open : paren
    if (start < 0) break

    const close = text[start] === "{" ? "}" : ")"
    let depth = 0
    let end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === text[start]) depth++
      if (text[i] === close) depth--
      if (depth !== 0) continue
      end = i
      break
    }
    if (end < 0) break

    const inner = text.slice(start + 1, end)
    const comma = inner.indexOf(",")
    if (comma >= 0) {
      out.push({
        type: name.toLowerCase(),
        key: inner.slice(0, comma).trim(),
        body: inner.slice(comma + 1).trim(),
      })
    }
    at = text.indexOf("@", end + 1)
  }

  return out
}

function JsonNode(props: { name?: string; value: Json; depth?: number }) {
  const depth = () => props.depth ?? 0
  const tag = () => (Array.isArray(props.value) ? `Array(${props.value.length})` : "Object")

  if (props.value === null || typeof props.value !== "object") {
    return (
      <div class="py-0.5 font-mono text-12-regular">
        <Show when={props.name}>
          <span class="text-text-weak">{props.name}: </span>
        </Show>
        <span>{JSON.stringify(props.value)}</span>
      </div>
    )
  }

  const list = () => {
    const value = props.value
    if (Array.isArray(value)) return value.map((item, i) => [String(i), item] as const)
    return Object.entries(value as { [key: string]: Json })
  }

  return (
    <details open={depth() < 2} class="py-0.5">
      <summary class="cursor-default font-mono text-12-regular text-text-weak">
        <Show when={props.name}>
          <span>{props.name}: </span>
        </Show>
        {tag()}
      </summary>
      <div class="ml-4 border-l border-border-weaker-base pl-3">
        <For each={list()}>{([name, value]) => <JsonNode name={name} value={value} depth={depth() + 1} />}</For>
      </div>
    </details>
  )
}

function BibPreview(props: { content: string }) {
  const language = useLanguage()
  const entries = () => parseBib(props.content)

  return (
    <Show
      when={entries().length > 0}
      fallback={
        <div class="p-4 text-13-regular text-text-weak">
          {language.t("file.editor.preview.bib.empty")}
          <pre class="mt-3 overflow-auto rounded bg-surface-inset-base p-3 font-mono text-xs text-text">
            {props.content}
          </pre>
        </div>
      }
    >
      <div class="space-y-3 p-4">
        <For each={entries()}>
          {(entry) => (
            <article class="rounded border border-border-weaker-base bg-surface-base p-3">
              <div class="flex items-center gap-2 font-mono text-12-medium">
                <span class="rounded bg-surface-inset-base px-1.5 py-0.5 text-text-weak">@{entry.type}</span>
                <span>{entry.key || "(no key)"}</span>
              </div>
              <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-text-weak">
                {entry.body}
              </pre>
            </article>
          )}
        </For>
      </div>
    </Show>
  )
}

export function FilePreview(props: {
  content: string
  dirty: boolean
  kind: PreviewKind
  path: string
  renderTex?: () => JSX.Element
  saving?: boolean
  onSave?: () => Promise<boolean>
}) {
  const language = useLanguage()
  const parsed = () => parseJson(props.content)
  const data = () => {
    const out = parsed()
    if (!out.ok) return
    return out
  }
  const error = () => {
    const out = parsed()
    if (out.ok) return ""
    return out.error
  }

  return (
    <div class="h-full min-h-0 overflow-auto bg-background">
      <Switch>
        <Match when={props.kind === "markdown"}>
          <Markdown text={props.content} class="p-6 text-13-regular" />
        </Match>
        <Match when={props.kind === "json"}>
          <div class="p-4">
            <Show
              when={data()}
              fallback={
                <>
                <div class="rounded border border-border-warning-base bg-surface-warning-weak p-3 text-12-regular text-text-on-warning-strong">
                  {language.t("file.editor.preview.json.invalid", { error: error() })}
                </div>
                <pre class="mt-3 overflow-auto rounded bg-surface-inset-base p-3 font-mono text-xs">
                  {props.content}
                </pre>
                </>
              }
            >
              {(out) => <JsonNode value={out().value} />}
            </Show>
          </div>
        </Match>
        <Match when={props.kind === "bib"}>
          <BibPreview content={props.content} />
        </Match>
        <Match when={props.kind === "tex"}>
          <Show
            when={!props.dirty}
            fallback={
              <div class="flex h-full items-center justify-center p-6">
                <div class="max-w-md rounded border border-border-warning-base bg-surface-warning-weak p-4 text-13-regular text-text-on-warning-strong">
                  <div class="font-medium">{language.t("file.editor.preview.tex.unsaved.title")}</div>
                  <p class="mt-1 text-text-on-warning-base">
                    {language.t("file.editor.preview.tex.unsaved.description")}
                  </p>
                  <Show when={props.onSave}>
                    <Button
                      class="mt-3"
                      size="small"
                      variant="secondary"
                      disabled={props.saving}
                      onClick={() => void props.onSave?.()}
                    >
                      {props.saving ? language.t("common.saving") : language.t("common.save")}
                    </Button>
                  </Show>
                </div>
              </div>
            }
          >
            <Show
              when={props.renderTex}
              fallback={<div class="p-4 text-13-regular text-text-weak">{language.t("file.editor.preview.unavailable")}</div>}
            >
              {(render) => render()()}
            </Show>
          </Show>
        </Match>
      </Switch>
    </div>
  )
}
