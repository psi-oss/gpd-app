import { describe, expect, test } from "bun:test"
import { detectLanguage } from "./eligibility"

describe("detectLanguage", () => {
  test("returns markdown for .md, .mdx, .markdown", () => {
    expect(detectLanguage("README.md")).toBe("markdown")
    expect(detectLanguage("doc.MDX")).toBe("markdown")
    expect(detectLanguage("notes.markdown")).toBe("markdown")
  })

  test("returns python for .py and .pyi", () => {
    expect(detectLanguage("script.py")).toBe("python")
    expect(detectLanguage("stubs.pyi")).toBe("python")
  })

  test("returns javascript for js/ts and friends", () => {
    expect(detectLanguage("a.js")).toBe("javascript")
    expect(detectLanguage("a.jsx")).toBe("javascript")
    expect(detectLanguage("a.ts")).toBe("javascript")
    expect(detectLanguage("a.tsx")).toBe("javascript")
    expect(detectLanguage("a.mjs")).toBe("javascript")
    expect(detectLanguage("a.cjs")).toBe("javascript")
    expect(detectLanguage("a.mts")).toBe("javascript")
    expect(detectLanguage("a.cts")).toBe("javascript")
  })

  test("returns undefined for unknown / missing", () => {
    expect(detectLanguage(undefined)).toBeUndefined()
    expect(detectLanguage("README")).toBeUndefined()
    expect(detectLanguage("a.rs")).toBeUndefined()
  })
})
