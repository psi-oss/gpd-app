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
      backgroundColor: "rgb(from var(--surface-warning-base) r g b / 0.4)",
    },
    // CodeMirror puts selection rects on `.cm-selectionLayer` which sits
    // BEHIND `.cm-content`. The active-line background (or any other line
    // decoration) is drawn on `.cm-line` inside `.cm-content`, so without
    // an explicit z-index bump the selection within the caret's line
    // disappears under the active-line tint and drag-select inside one
    // line shows nothing visible. Lifting the selection layer above the
    // content makes per-character selection visible across the whole
    // viewport — including within the active line.
    ".cm-selectionLayer": {
      zIndex: "1",
    },
    ".cm-content, .cm-line": {
      position: "relative",
      zIndex: "0",
    },
    ".cm-gutters": {
      backgroundColor: "var(--background-base)",
      borderRight: "1px solid var(--border-weaker-base)",
      color: "var(--text-weak)",
    },
    // Active-line background must be semi-transparent. CodeMirror renders
    // its selection layer beneath line content, so an opaque active-line
    // background hides the selection rectangles for any selection that
    // overlaps the caret's line.
    ".cm-activeLine": {
      backgroundColor: "rgb(from var(--surface-raised-base) r g b / 0.5)",
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
