// Markdown files used in agentic workflows commonly carry YAML front-matter
// (between two `---` fences) or are entirely YAML with a leading `---\n`.
// Plain marked treats `---` as a thematic break and the YAML lines as
// paragraphs, which collapses structure into a wall of text. We rewrite
// front-matter to a fenced ```yaml block before marked sees it so the YAML
// is rendered as a syntax-highlighted code block and the markdown body
// stays untouched.
//
// As a second pass we escape unknown HTML-like tags in the body. GPD plan
// files lean on custom <objective> / <task> / <verify> / <done> containers
// that DOMPurify silently strips — escaping their `<` and `>` makes them
// render as visible literal markup instead of smushing nested children into
// one paragraph.

import { escapeUnknownTags } from "./markdown-escape-tags"

const KEY_LINE = /^[A-Za-z_][\w.-]*\s*:/

function rewriteFrontmatter(text: string): string {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return text

  // Closed front-matter: --- ... --- followed by markdown body.
  const closed = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (closed) {
    const yaml = "```yaml\n" + closed[1] + "\n```"
    const body = text.slice(closed[0].length).replace(/^(?:\r?\n)+/, "")
    return body.length ? yaml + "\n\n" + body : yaml
  }

  // Unclosed: only treat as YAML when the next non-empty line looks like a
  // YAML key. Avoids hijacking real markdown files that happen to open with
  // a horizontal rule.
  const rest = text.replace(/^---\r?\n/, "")
  const firstLine = rest.split(/\r?\n/).find((l) => l.trim() !== "") ?? ""
  if (!KEY_LINE.test(firstLine)) return text
  return "```yaml\n" + rest + "\n```"
}

export function preprocess(text: string): string {
  return escapeUnknownTags(rewriteFrontmatter(text))
}
