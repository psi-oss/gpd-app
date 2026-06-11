import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { Session } from "../../src/session"
import { SessionGoal } from "../../src/session/goal"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const layer = Layer.mergeAll(Session.defaultLayer, Layer.provide(SessionGoal.defaultLayer, Bus.layer), Bus.layer)
const runtime = ManagedRuntime.make(layer)

function effect<A, E>(value: Effect.Effect<A, E, Session.Service | SessionGoal.Service | Bus.Service>): Promise<A> {
  return runtime.runPromise(value as never) as Promise<A>
}

function runIn<A>(directory: string, fn: () => Promise<A>): Promise<A> {
  return Instance.provide({ directory, fn }) as Promise<A>
}

async function run<A>(fn: (directory: string) => Promise<A>): Promise<A> {
  await using tmp = await tmpdir({ git: true })
  return await runIn(tmp.path, () => fn(tmp.path))
}

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

afterAll(async () => {
  await runtime.dispose()
})

describe("SessionGoal budgets", () => {
  test("create accepts and persists timeBudgetSeconds + costBudgetUSD", async () => {
    const goal = await run(async () => {
      const session = await effect(Session.Service.use((svc) => svc.create({ title: "budget-create" })))
      return effect(
        SessionGoal.Service.use((svc) =>
          svc.create({
            sessionID: session.id,
            objective: "ship a thing",
            tokenBudget: 1000,
            timeBudgetSeconds: 600,
            costBudgetUSD: 0.5,
          }),
        ),
      )
    })

    expect(goal.tokens.budget).toBe(1000)
    expect(goal.time.budgetSeconds).toBe(600)
    expect(goal.cost.budgetMicroUSD).toBe(500_000)
    expect(goal.cost.usedMicroUSD).toBe(0)
  })

  test("flips to budget_limited when time budget exhausts", async () => {
    const result = await run(async () => {
      const session = await effect(Session.Service.use((svc) => svc.create({ title: "budget-time" })))
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.create({ sessionID: session.id, objective: "watch time", timeBudgetSeconds: 5 }),
        ),
      )
      return effect(
        SessionGoal.Service.use((svc) =>
          svc.account({ sessionID: session.id, tokens: 0, seconds: 5, costMicroUSD: 0 }),
        ),
      )
    })

    expect(result?.status).toBe("budget_limited")
    expect(result?.time.used).toBe(5)
  })

  test("flips to budget_limited when cost budget exhausts (in micros)", async () => {
    const result = await run(async () => {
      const session = await effect(Session.Service.use((svc) => svc.create({ title: "budget-cost" })))
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.create({ sessionID: session.id, objective: "watch cost", costBudgetUSD: 0.5 }),
        ),
      )
      return effect(
        SessionGoal.Service.use((svc) =>
          svc.account({ sessionID: session.id, tokens: 0, seconds: 0, costMicroUSD: 500_000 }),
        ),
      )
    })

    expect(result?.status).toBe("budget_limited")
    expect(result?.cost.usedMicroUSD).toBe(500_000)
  })

  test("publishes BudgetExhausted exactly on the active → budget_limited flip", async () => {
    const events: string[] = []
    const result = await run(async () => {
      const session = await effect(Session.Service.use((svc) => svc.create({ title: "budget-event" })))
      await effect(
        Bus.Service.use((bus) =>
          bus.subscribeCallback(SessionGoal.BusOnlyEvent.BudgetExhausted, (event) => {
            events.push(`${event.properties.sessionID}:${event.properties.goal.status}`)
          }),
        ),
      )
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.create({ sessionID: session.id, objective: "watch event", costBudgetUSD: 0.5 }),
        ),
      )
      // under budget: no event
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.account({ sessionID: session.id, tokens: 0, seconds: 0, costMicroUSD: 100_000 }),
        ),
      )
      // exhausts: one event
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.account({ sessionID: session.id, tokens: 0, seconds: 0, costMicroUSD: 400_000 }),
        ),
      )
      // already budget_limited: accounting continues but no second event
      await effect(
        SessionGoal.Service.use((svc) => svc.account({ sessionID: session.id, tokens: 0, seconds: 1, costMicroUSD: 0 })),
      )
      return { sessionID: session.id }
    })

    expect(events).toEqual([`${result.sessionID}:budget_limited`])
  })

  test("OR-of-three: any one budget exhausting flips status", async () => {
    await run(async () => {
      // Token-only budget
      const tokenSession = await effect(Session.Service.use((svc) => svc.create({ title: "or-tokens" })))
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.create({ sessionID: tokenSession.id, objective: "t", tokenBudget: 3 }),
        ),
      )
      const t = await effect(
        SessionGoal.Service.use((svc) =>
          svc.account({ sessionID: tokenSession.id, tokens: 3, seconds: 0, costMicroUSD: 0 }),
        ),
      )
      expect(t?.status).toBe("budget_limited")

      // Time-only budget
      const timeSession = await effect(Session.Service.use((svc) => svc.create({ title: "or-time" })))
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.create({ sessionID: timeSession.id, objective: "T", timeBudgetSeconds: 5 }),
        ),
      )
      const time = await effect(
        SessionGoal.Service.use((svc) =>
          svc.account({ sessionID: timeSession.id, tokens: 0, seconds: 5, costMicroUSD: 0 }),
        ),
      )
      expect(time?.status).toBe("budget_limited")

      // Cost-only budget
      const costSession = await effect(Session.Service.use((svc) => svc.create({ title: "or-cost" })))
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.create({ sessionID: costSession.id, objective: "$", costBudgetUSD: 0.1 }),
        ),
      )
      const c = await effect(
        SessionGoal.Service.use((svc) =>
          svc.account({ sessionID: costSession.id, tokens: 0, seconds: 0, costMicroUSD: 100_000 }),
        ),
      )
      expect(c?.status).toBe("budget_limited")
    })
  })

  test("accounts cost from step-finish part cost field", async () => {
    const goal = await run(async (directory) => {
      const session = await effect(Session.Service.use((svc) => svc.create({ title: "cost-step-finish" })))
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.create({ sessionID: session.id, objective: "track cost", costBudgetUSD: 1 }),
        ),
      )
      const messageID = MessageID.ascending()
      await effect(
        Session.Service.use((svc) =>
          svc.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "assistant",
            mode: "build",
            agent: "build",
            path: { cwd: directory, root: directory },
            parentID: MessageID.ascending(),
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test",
            providerID: "test",
            time: { created: Date.now() },
          } as MessageV2.Assistant),
        ),
      )
      // step-finish carries cost=0.75 USD → 750000 micros
      await effect(
        Session.Service.use((svc) =>
          svc.updatePart({
            id: PartID.ascending(),
            messageID,
            sessionID: session.id,
            type: "step-finish",
            reason: "stop",
            cost: 0.75,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          } as MessageV2.Part),
        ),
      )
      return effect(SessionGoal.Service.use((svc) => svc.get(session.id)))
    })

    expect(goal?.cost.usedMicroUSD).toBe(750_000)
    expect(goal?.status).toBe("active")
  })

  test("lowering time/cost budgets recomputes budget_limited", async () => {
    const result = await run(async () => {
      const session = await effect(Session.Service.use((svc) => svc.create({ title: "lower-budgets" })))
      await effect(
        SessionGoal.Service.use((svc) => svc.create({ sessionID: session.id, objective: "fill then lower" })),
      )
      await effect(
        SessionGoal.Service.use((svc) =>
          svc.account({ sessionID: session.id, tokens: 0, seconds: 10, costMicroUSD: 200_000 }),
        ),
      )
      const lowerTime = await effect(
        SessionGoal.Service.use((svc) => svc.update({ sessionID: session.id, timeBudgetSeconds: 5 })),
      )
      const clearTime = await effect(
        SessionGoal.Service.use((svc) => svc.update({ sessionID: session.id, timeBudgetSeconds: null })),
      )
      const lowerCost = await effect(
        SessionGoal.Service.use((svc) => svc.update({ sessionID: session.id, costBudgetUSD: 0.1 })),
      )
      const clearCost = await effect(
        SessionGoal.Service.use((svc) => svc.update({ sessionID: session.id, costBudgetUSD: null })),
      )
      return { lowerTime, clearTime, lowerCost, clearCost }
    })

    expect(result.lowerTime.status).toBe("budget_limited")
    expect(result.lowerTime.time.budgetSeconds).toBe(5)
    expect(result.clearTime.status).toBe("active")
    expect(result.clearTime.time.budgetSeconds).toBeUndefined()
    expect(result.lowerCost.status).toBe("budget_limited")
    expect(result.lowerCost.cost.budgetMicroUSD).toBe(100_000)
    expect(result.clearCost.status).toBe("active")
    expect(result.clearCost.cost.budgetMicroUSD).toBeUndefined()
  })

  test("validates time and cost budgets must be positive", async () => {
    const session = await run(async () => effect(Session.Service.use((svc) => svc.create({ title: "validate" }))))

    const tryCreate = (input: { timeBudgetSeconds?: number; costBudgetUSD?: number }) =>
      runIn(session.directory, () =>
        effect(
          SessionGoal.Service.use((svc) => svc.create({ sessionID: session.id, objective: "v", ...input })),
        ),
      )

    let error: unknown
    try {
      await tryCreate({ timeBudgetSeconds: 0 })
    } catch (e) {
      error = e
    }
    expect(error instanceof Error ? error.message : String(error)).toContain("time budget")

    error = undefined
    try {
      await tryCreate({ costBudgetUSD: -1 })
    } catch (e) {
      error = e
    }
    expect(error instanceof Error ? error.message : String(error)).toContain("cost budget")
  })
})
