import { describe, expect, test } from "bun:test"
import { parseGoalInput } from "../../../src/cli/cmd/tui/component/dialog-session-goal"

describe("parseGoalInput (RES-932)", () => {
  test("empty or whitespace-only input returns null", () => {
    expect(parseGoalInput("")).toBeNull()
    expect(parseGoalInput("   ")).toBeNull()
  })

  test("plain text becomes the goal text with no budget/deadline", () => {
    expect(parseGoalInput("Find quantum gravity")).toEqual({ text: "Find quantum gravity" })
  })

  test("--budget and --time flags are extracted regardless of position", () => {
    expect(parseGoalInput("Ship paper --budget=$50 --time=2h")).toEqual({
      text: "Ship paper",
      budget: "$50",
      deadline: "2h",
    })
    expect(parseGoalInput("--time=2026-05-20 Wrap up draft --budget=20")).toEqual({
      text: "Wrap up draft",
      budget: "20",
      deadline: "2026-05-20",
    })
  })

  test("quoted flag values are unwrapped", () => {
    expect(parseGoalInput('Plan trip --time="next week" --budget="$1,000"')).toEqual({
      text: "Plan trip",
      budget: "$1,000",
      deadline: "next week",
    })
  })

  test("input that only contains flags (no goal text) clears the goal", () => {
    // No description text left after stripping flags — treat as clear.
    expect(parseGoalInput("--budget=$50 --time=2h")).toBeNull()
  })
})
