import { describe, expect, test } from "bun:test"
import { ranges } from "./editor-search"

describe("editor search", () => {
  test("returns case-insensitive ranges", () => {
    expect(ranges("alpha ALPHA beta", "alpha")).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
    ])
  })

  test("ignores blank queries", () => {
    expect(ranges("alpha", " ")).toEqual([])
  })
})
