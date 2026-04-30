import { describe, expect, test } from "bun:test"
import { preprocess } from "./markdown-frontmatter"

describe("markdown frontmatter", () => {
  test("rewrites closed front-matter to a yaml fence and keeps the body", () => {
    const input = "---\nphase: 02\nplan: 01\n---\n\n# Heading\n\nBody text.\n"
    expect(preprocess(input)).toBe("```yaml\nphase: 02\nplan: 01\n```\n\n# Heading\n\nBody text.\n")
  })

  test("rewrites front-matter even when there is no markdown body", () => {
    const input = "---\nphase: 02\n---\n"
    expect(preprocess(input)).toBe("```yaml\nphase: 02\n```")
  })

  test("treats unclosed yaml-shaped content as a yaml document", () => {
    const input = "---\nphase: 02-soundness\nplan: 01\nresearcher_setup: []\n\nconventions:\n  units: \"none\"\n"
    expect(preprocess(input)).toBe(
      "```yaml\nphase: 02-soundness\nplan: 01\nresearcher_setup: []\n\nconventions:\n  units: \"none\"\n\n```",
    )
  })

  test("leaves a real markdown horizontal rule alone when no yaml follows", () => {
    const input = "---\n\nThis is a paragraph after a horizontal rule.\n"
    expect(preprocess(input)).toBe(input)
  })

  test("returns input unchanged when it does not start with ---", () => {
    const input = "# Heading\n\nphase: 02\n"
    expect(preprocess(input)).toBe(input)
  })

  test("handles CRLF line endings", () => {
    const input = "---\r\nphase: 02\r\n---\r\nbody\r\n"
    expect(preprocess(input)).toBe("```yaml\nphase: 02\n```\n\nbody\r\n")
  })
})
