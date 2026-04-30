import { describe, expect, test } from "bun:test"
import { escapeUnknownTags } from "./markdown-escape-tags"

describe("escape unknown HTML tags", () => {
  test("escapes custom tags so DOMPurify can't strip them silently", () => {
    expect(escapeUnknownTags("<objective>do the thing</objective>")).toBe(
      "&lt;objective&gt;do the thing&lt;/objective&gt;",
    )
  })

  test("escapes nested plan-style containers without smushing children", () => {
    const input =
      "<task type=\"auto\">\n  <name>Task 1</name>\n  <verify>check it</verify>\n</task>"
    const out = escapeUnknownTags(input)
    expect(out).toContain("&lt;task type=\"auto\"&gt;")
    expect(out).toContain("&lt;name&gt;Task 1&lt;/name&gt;")
    expect(out).toContain("&lt;verify&gt;check it&lt;/verify&gt;")
    expect(out).toContain("&lt;/task&gt;")
  })

  test("preserves standard inline HTML used in real markdown", () => {
    const input = "see <details><summary>more</summary>body <sub>2</sub></details>"
    expect(escapeUnknownTags(input)).toBe(input)
  })

  test("does not touch tags inside fenced code blocks", () => {
    const input = "```xml\n<task>foo</task>\n```"
    expect(escapeUnknownTags(input)).toBe(input)
  })

  test("does not touch tags inside tilde-fenced code blocks", () => {
    const input = "~~~xml\n<task>foo</task>\n~~~"
    expect(escapeUnknownTags(input)).toBe(input)
  })

  test("does not touch tags inside inline code spans", () => {
    const input = "use the `<task>` tag"
    expect(escapeUnknownTags(input)).toBe(input)
  })

  test("escapes tags around code spans without touching the span itself", () => {
    const input = "<verify>use `<task>` here</verify>"
    expect(escapeUnknownTags(input)).toBe(
      "&lt;verify&gt;use `<task>` here&lt;/verify&gt;",
    )
  })

  test("preserves MathML tags so KaTeX output keeps rendering", () => {
    const input = "<math><mrow><mi>x</mi><mo>=</mo><mn>1</mn></mrow></math>"
    expect(escapeUnknownTags(input)).toBe(input)
  })
})
