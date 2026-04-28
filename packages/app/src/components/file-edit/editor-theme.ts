import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language"
import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

export const style: Extension = [
  EditorView.theme({
    "&": {
      backgroundColor: "var(--background-base)",
      color: "var(--text-base)",
    },
    ".cm-content": {
      caretColor: "var(--text-strong)",
      padding: "12px 0",
    },
    ".cm-line": {
      padding: "0 12px",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--text-strong)",
    },
    "&.cm-focused": {
      outline: "none",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgb(from var(--surface-warning-base) r g b / 0.35)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--background-base)",
      borderRight: "1px solid var(--border-weaker-base)",
      color: "var(--text-weak)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--surface-raised-base)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--surface-raised-base)",
      color: "var(--text-strong)",
    },
    ".cm-foldGutter span": {
      color: "var(--text-weak)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--surface-raised-stronger-non-alpha)",
      border: "1px solid var(--border-base)",
      color: "var(--text-base)",
    },
    ".cm-ocSearchMatch": {
      backgroundColor: "rgb(from var(--surface-warning-base) r g b / 0.45)",
      outline: "1px solid var(--border-warning-base)",
    },
    ".cm-ocSearchMatchActive": {
      backgroundColor: "rgb(from var(--surface-warning-strong) r g b / 0.55)",
      outline: "1px solid var(--text-strong)",
    },
  }),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
]
