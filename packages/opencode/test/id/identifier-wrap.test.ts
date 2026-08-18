import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

// 2026-08-14T11:19:55.136Z — the instant the encoded time field last wrapped
// past 2^48. Everything minted after it has a smaller hex prefix than
// everything minted in the 795 days before it.
const WRAP = 1786706395136

const hex = (id: string) => id.slice(id.indexOf("_") + 1, id.indexOf("_") + 13)

describe("id.identifier wraparound", () => {
  test("the encoded time field really does wrap, and string order lies about it", () => {
    const before = Identifier.create("msg", "ascending", WRAP - 1000)
    const after = Identifier.create("msg", "ascending", WRAP + 1000)

    // This is the defect that broke every pre-2026-08-14 chat: the newer ID
    // sorts below the older one. The encoding is allowed to wrap; reading it
    // as a plain string is not.
    expect(after < before).toBe(true)
    expect(parseInt(hex(after), 16)).toBeLessThan(parseInt(hex(before), 16))
  })

  test("compare puts the newer id after the older one across a wrap", () => {
    const before = Identifier.create("msg", "ascending", WRAP - 1000)
    const after = Identifier.create("msg", "ascending", WRAP + 1000)

    expect(Identifier.compare(before, after)).toBeLessThan(0)
    expect(Identifier.compare(after, before)).toBeGreaterThan(0)
    expect(Identifier.isBefore(before, after)).toBe(true)
    expect(Identifier.isAfter(after, before)).toBe(true)
  })

  test("sorting a set that straddles a wrap yields creation order", () => {
    const times = [WRAP - 90 * 86_400_000, WRAP - 1000, WRAP + 1000, WRAP + 90 * 86_400_000]
    const ids = times.map((t) => Identifier.create("msg", "ascending", t))

    expect([...ids].reverse().sort(Identifier.compare)).toEqual(ids)
    // Sorted as plain strings the two post-wrap ids come out in front.
    expect([...ids].sort()).not.toEqual(ids)
  })

  test("compare is correct away from a wrap too", () => {
    const a = Identifier.create("msg", "ascending", WRAP + 1000)
    const b = Identifier.create("msg", "ascending", WRAP + 2000)
    expect(Identifier.compare(a, b)).toBeLessThan(0)
    expect(a < b).toBe(true)
  })

  test("descending ids keep sorting newest-first across a wrap", () => {
    const older = Identifier.create("ses", "descending", WRAP - 1000)
    const newer = Identifier.create("ses", "descending", WRAP + 1000)

    // Descending ids are minted so that the newest sorts first.
    expect(Identifier.compare(newer, older)).toBeLessThan(0)
  })

  test("ids minted in the same millisecond stay in mint order", () => {
    const first = Identifier.create("msg", "ascending", WRAP + 5000)
    const second = Identifier.create("msg", "ascending", WRAP + 5000)
    expect(Identifier.compare(first, second)).toBeLessThan(0)
  })

  test("compare falls back to string order for ids without a time prefix", () => {
    expect(Identifier.compare("msg_001", "msg_002")).toBeLessThan(0)
    expect(Identifier.compare("msg_002", "msg_001")).toBeGreaterThan(0)
    expect(Identifier.compare("msg_001", "msg_001")).toBe(0)
  })
})
