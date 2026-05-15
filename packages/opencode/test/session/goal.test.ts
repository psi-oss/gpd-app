import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "../../src/session"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import type { SessionID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function get(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.get(id)))
}

function remove(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(id)))
}

function setGoal(sessionID: SessionID, goal: SessionNs.Info["goal"]) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.setGoal({ sessionID, goal })))
}

function clearGoal(sessionID: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.clearGoal(sessionID)))
}

describe("Session goal (RES-932)", () => {
  test("setGoal persists and clearGoal removes it", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await create({})
        try {
          // Initial state — no goal set yet.
          expect((await get(info.id)).goal).toBeUndefined()

          await setGoal(info.id, { text: "Find quantum gravity model", budget: "$50", deadline: "2h" })
          const withGoal = await get(info.id)
          expect(withGoal.goal).toEqual({
            text: "Find quantum gravity model",
            budget: "$50",
            deadline: "2h",
          })

          // Replacing the goal overwrites the prior value rather than merging.
          await setGoal(info.id, { text: "Different goal" })
          const replaced = await get(info.id)
          expect(replaced.goal).toEqual({ text: "Different goal" })

          await clearGoal(info.id)
          expect((await get(info.id)).goal).toBeUndefined()
        } finally {
          await remove(info.id)
        }
      },
    })
  })

  test("goalSystemPrompt renders a system block only when a goal is set", () => {
    expect(SessionNs.goalSystemPrompt(undefined)).toBeUndefined()
    expect(SessionNs.goalSystemPrompt({ text: "   " })).toBeUndefined()

    const minimal = SessionNs.goalSystemPrompt({ text: "Ship the paper" })!
    expect(minimal).toContain("<session-goal>")
    expect(minimal).toContain("Goal: Ship the paper")
    expect(minimal).not.toContain("Target budget")
    expect(minimal).not.toContain("Target finish")

    const full = SessionNs.goalSystemPrompt({ text: "Ship the paper", budget: "$50", deadline: "2026-05-20" })!
    expect(full).toContain("Goal: Ship the paper")
    expect(full).toContain("Target budget: $50")
    expect(full).toContain("Target finish: 2026-05-20")
    expect(full).toMatch(/<\/session-goal>$/)
  })
})
