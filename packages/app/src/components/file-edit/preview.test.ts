import { describe, expect, test } from "bun:test"
import { parseBib, parseJson, previewKind } from "./preview"

describe("file editor preview helpers", () => {
  test("detects preview kinds by extension", () => {
    expect(previewKind("README.md")).toBe("markdown")
    expect(previewKind("data.json")).toBe("json")
    expect(previewKind("refs.bib")).toBe("bib")
    expect(previewKind("paper.tex")).toBe("tex")
    expect(previewKind("plan.yaml")).toBe("yaml")
    expect(previewKind("plan.yml")).toBe("yaml")
    expect(previewKind("src/app.ts")).toBeUndefined()
  })

  test("parses valid JSON and rejects invalid JSON", () => {
    expect(parseJson(`{"a":1,"b":[true,null]}`).ok).toBe(true)
    const out = parseJson(`{"a":`)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.length).toBeGreaterThan(0)
  })

  test("parses BibTeX entries with nested braces", () => {
    const entries = parseBib(`
@article{einstein1905,
  title = {On {Electrodynamics} of Moving Bodies},
  author = {Einstein, Albert}
}
`)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.type).toBe("article")
    expect(entries[0]?.key).toBe("einstein1905")
    expect(entries[0]?.body).toContain("Electrodynamics")
  })
})
