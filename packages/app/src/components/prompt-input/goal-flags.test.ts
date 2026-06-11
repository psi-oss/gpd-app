import { describe, expect, test } from "bun:test"
import { parseDuration, parseGoalFlags } from "./goal-flags"

describe("parseDuration", () => {
  test("parses compound durations", () => {
    expect(parseDuration("30m")).toBe(1800)
    expect(parseDuration("2h")).toBe(7200)
    expect(parseDuration("1h30m")).toBe(5400)
    expect(parseDuration("120s")).toBe(120)
    expect(parseDuration("1h30m45s")).toBe(5445)
  })

  test("rejects garbage", () => {
    expect(parseDuration("")).toBeUndefined()
    expect(parseDuration("30")).toBeUndefined()
    expect(parseDuration("m30")).toBeUndefined()
  })
})

describe("parseGoalFlags", () => {
  test("parses dash-form flags anywhere in the objective", () => {
    const { cleanArg, flags } = parseGoalFlags("--budget=$50 win the feynman prize --time=30m")
    expect(flags.costBudgetUSD).toBe(50)
    expect(flags.timeBudgetSeconds).toBe(1800)
    expect(cleanArg).toBe("win the feynman prize")
  })

  test("parses em-dash flags produced by macOS smart-dash substitution", () => {
    // Typed `--budget=$50 --time=30m`; macOS rewrote each `--` to `—`.
    const { cleanArg, flags } = parseGoalFlags("win the feynman prize —budget=$50 —time=30m")
    expect(flags.costBudgetUSD).toBe(50)
    expect(flags.timeBudgetSeconds).toBe(1800)
    expect(cleanArg).toBe("win the feynman prize")
  })

  test("parses en-dash flags", () => {
    const { cleanArg, flags } = parseGoalFlags("–budget=$2.50 do the thing")
    expect(flags.costBudgetUSD).toBe(2.5)
    expect(cleanArg).toBe("do the thing")
  })

  test("mixed dash forms in one objective all parse and strip", () => {
    const { cleanArg, flags } = parseGoalFlags("--budget=$1 objective —time=1h30m")
    expect(flags.costBudgetUSD).toBe(1)
    expect(flags.timeBudgetSeconds).toBe(5400)
    expect(cleanArg).toBe("objective")
  })

  test("em-dash used as prose punctuation is left alone", () => {
    const { cleanArg, flags } = parseGoalFlags("derive the result — carefully — without shortcuts")
    expect(flags.costBudgetUSD).toBeUndefined()
    expect(flags.timeBudgetSeconds).toBeUndefined()
    expect(cleanArg).toBe("derive the result — carefully — without shortcuts")
  })

  test("throws on malformed values regardless of dash form", () => {
    expect(() => parseGoalFlags("—budget=$0 x")).toThrow()
    expect(() => parseGoalFlags("—time=banana x")).toThrow()
    expect(() => parseGoalFlags("--budget=nope x")).toThrow()
  })
})
