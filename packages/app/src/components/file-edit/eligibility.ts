/**
 * Detect a CodeMirror language preset from a file path. Returns `undefined`
 * for unknown extensions so the editor falls back to plain text.
 */
export type EditorLanguage = "markdown" | "python" | "javascript" | undefined

export function detectLanguage(path: string | undefined): EditorLanguage {
  if (!path) return undefined
  const lower = path.toLowerCase()
  if (lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".markdown")) return "markdown"
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return "python"
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "javascript"
  }
  return undefined
}
