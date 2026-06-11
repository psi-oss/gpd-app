import { BusEvent } from "@/bus/bus-event"
import { Bus } from "../bus"
import { Database, NotFoundError, and, eq, isNull } from "@/storage/db"
import { SyncEvent } from "@/sync"
import { Context, Effect, Layer } from "effect"
import z from "zod"
import { ProjectID } from "../project/schema"
import { GoalID, MessageID, SessionID } from "./schema"
import { SessionGoalTable, SessionTable } from "./session.sql"

export namespace SessionGoal {
  const StatusSchema = z.enum(["active", "paused", "budget_limited", "complete"])
  export type Status = z.infer<typeof StatusSchema>

  const Tokens = z.object({
    used: z.number().int().nonnegative(),
    budget: z.number().int().nonnegative().optional(),
  })

  const Time = z.object({
    used: z.number().int().nonnegative(),
    budgetSeconds: z.number().int().positive().optional(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  })

  const Cost = z.object({
    usedMicroUSD: z.number().int().nonnegative(),
    budgetMicroUSD: z.number().int().positive().optional(),
  })

  export const Info = z
    .object({
      id: GoalID.zod,
      sessionID: SessionID.zod,
      objective: z.string(),
      status: StatusSchema,
      tokens: Tokens,
      time: Time,
      cost: Cost,
    })
    .meta({ ref: "SessionGoal" })
  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    sessionID: SessionID.zod,
    objective: z.string(),
    tokenBudget: z.number().int().positive().optional(),
    timeBudgetSeconds: z.number().int().positive().optional(),
    costBudgetUSD: z.number().positive().optional(),
  })
  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z.object({
    sessionID: SessionID.zod,
    objective: z.string().optional(),
    status: StatusSchema.optional(),
    tokenBudget: z.number().int().positive().nullable().optional(),
    timeBudgetSeconds: z.number().int().positive().nullable().optional(),
    costBudgetUSD: z.number().positive().nullable().optional(),
  })
  export type UpdateInput = z.infer<typeof UpdateInput>

  export const AccountInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    tokens: z.number().int().nonnegative(),
    seconds: z.number().int().nonnegative(),
    costMicroUSD: z.number().int().nonnegative().optional(),
  })
  export type AccountInput = z.infer<typeof AccountInput>

  export const ModelUpdateInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    status: StatusSchema,
  })
  export type ModelUpdateInput = z.infer<typeof ModelUpdateInput>

  export const Event = {
    Updated: SyncEvent.define({
      type: "session.goal.updated",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        goal: Info,
      }),
    }),
    Cleared: SyncEvent.define({
      type: "session.goal.cleared",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
      }),
    }),
  }

  export const BusOnlyEvent = {
    IdleContinue: BusEvent.define(
      "session.goal.idle_continue",
      z.object({
        sessionID: SessionID.zod,
        goal: Info,
      }),
    ),
    // Fired exactly on the active → budget_limited transition inside
    // recordUsage. SessionPrompt subscribes and runs one final wind-down
    // turn (checkpoint via /gpd-pause-work + state summary) so an
    // exhausted goal ends with a recoverable artifact instead of a
    // silent stop — mirrors codex's goal extension, which injects a
    // wrap-up prompt when the token budget exhausts.
    BudgetExhausted: BusEvent.define(
      "session.goal.budget_exhausted",
      z.object({
        sessionID: SessionID.zod,
        goal: Info,
      }),
    ),
  }

  export class GoalError extends Error {}
  type NotFound = InstanceType<typeof NotFoundError>

  export interface Interface {
    readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
    readonly listActive: (input?: { projectID?: ProjectID }) => Effect.Effect<Info[]>
    readonly create: (input: CreateInput) => Effect.Effect<Info, GoalError>
    readonly update: (input: UpdateInput) => Effect.Effect<Info, GoalError | NotFound>
    readonly clear: (sessionID: SessionID) => Effect.Effect<void>
    readonly account: (input: AccountInput) => Effect.Effect<Info | undefined>
    readonly modelUpdate: (input: ModelUpdateInput) => Effect.Effect<Info, GoalError | NotFound>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

  function fromRow(row: typeof SessionGoalTable.$inferSelect): Info {
    return {
      id: row.id,
      sessionID: row.session_id,
      objective: row.objective,
      status: row.status as Status,
      tokens: {
        used: row.tokens_used,
        budget: row.token_budget ?? undefined,
      },
      time: {
        used: row.time_used,
        budgetSeconds: row.time_budget ?? undefined,
        created: row.time_created,
        updated: row.time_updated,
      },
      cost: {
        usedMicroUSD: row.cost_used_micro,
        budgetMicroUSD: row.cost_budget_micro ?? undefined,
      },
    }
  }

  export function toRow(goal: Info): typeof SessionGoalTable.$inferInsert {
    return {
      id: goal.id,
      session_id: goal.sessionID,
      objective: goal.objective,
      status: goal.status,
      token_budget: goal.tokens.budget ?? null,
      tokens_used: goal.tokens.used,
      time_budget: goal.time.budgetSeconds ?? null,
      time_used: goal.time.used,
      cost_budget_micro: goal.cost.budgetMicroUSD ?? null,
      cost_used_micro: goal.cost.usedMicroUSD,
      time_created: goal.time.created,
      time_updated: goal.time.updated,
    }
  }

  function objective(input: string) {
    const text = input.trim()
    if (!text) return Effect.fail(new GoalError("Goal objective is required"))
    if (text.length > 4000) return Effect.fail(new GoalError("Goal objective is too long"))
    return Effect.succeed(text)
  }

  function budget(input: number | null | undefined) {
    if (input !== undefined && input !== null && input <= 0) {
      return Effect.fail(new GoalError("Goal token budget must be positive"))
    }
    return Effect.void
  }

  function timeBudget(input: number | null | undefined) {
    if (input !== undefined && input !== null && input <= 0) {
      return Effect.fail(new GoalError("Goal time budget must be positive"))
    }
    return Effect.void
  }

  function costBudget(input: number | null | undefined) {
    if (input !== undefined && input !== null && input <= 0) {
      return Effect.fail(new GoalError("Goal cost budget must be positive"))
    }
    return Effect.void
  }

  function usdToMicro(usd: number | null | undefined): number | undefined {
    if (usd === undefined || usd === null) return undefined
    return Math.round(usd * 1_000_000)
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const completeAccounting = new Map<
        SessionID,
        {
          messageID: MessageID
          tokens: boolean
          time: boolean
          cost: boolean
        }
      >()
      const budgetAccounting = new Map<
        SessionID,
        {
          messageID?: MessageID
          time: boolean
        }
      >()

      const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
        const row = Database.use((db) =>
          db.select().from(SessionGoalTable).where(eq(SessionGoalTable.session_id, sessionID)).get(),
        )
        return row ? fromRow(row) : undefined
      })

      const listActive = Effect.fn("SessionGoal.listActive")(function* (input?: { projectID?: ProjectID }) {
        const conditions = [eq(SessionGoalTable.status, "active"), isNull(SessionTable.time_archived)]
        if (input?.projectID) conditions.push(eq(SessionTable.project_id, input.projectID))
        const rows = Database.use((db) =>
          db
            .select({
              id: SessionGoalTable.id,
              session_id: SessionGoalTable.session_id,
              objective: SessionGoalTable.objective,
              status: SessionGoalTable.status,
              token_budget: SessionGoalTable.token_budget,
              tokens_used: SessionGoalTable.tokens_used,
              time_budget: SessionGoalTable.time_budget,
              time_used: SessionGoalTable.time_used,
              cost_budget_micro: SessionGoalTable.cost_budget_micro,
              cost_used_micro: SessionGoalTable.cost_used_micro,
              time_created: SessionGoalTable.time_created,
              time_updated: SessionGoalTable.time_updated,
            })
            .from(SessionGoalTable)
            .innerJoin(SessionTable, eq(SessionGoalTable.session_id, SessionTable.id))
            .where(and(...conditions))
            .all(),
        )
        return rows.map(fromRow)
      })

      const emit = Effect.fn("SessionGoal.emit")(function* (goal: Info) {
        yield* Effect.sync(() => SyncEvent.run(Event.Updated, { sessionID: goal.sessionID, goal }))
        return goal
      })

      const create = Effect.fn("SessionGoal.create")(function* (input: CreateInput) {
        const text = yield* objective(input.objective)
        yield* budget(input.tokenBudget)
        yield* timeBudget(input.timeBudgetSeconds)
        yield* costBudget(input.costBudgetUSD)
        if (yield* get(input.sessionID)) return yield* Effect.fail(new GoalError("Goal already exists"))

        return yield* emit({
          id: GoalID.ascending(),
          sessionID: input.sessionID,
          objective: text,
          status: "active",
          tokens: {
            used: 0,
            budget: input.tokenBudget,
          },
          time: {
            used: 0,
            budgetSeconds: input.timeBudgetSeconds,
            created: Date.now(),
            updated: Date.now(),
          },
          cost: {
            usedMicroUSD: 0,
            budgetMicroUSD: usdToMicro(input.costBudgetUSD),
          },
        })
      })

      const update = Effect.fn("SessionGoal.update")(function* (input: UpdateInput) {
        const current = yield* get(input.sessionID)
        if (!current) {
          return yield* Effect.fail(new NotFoundError({ message: `Goal not found: ${input.sessionID}` }))
        }
        const text = input.objective === undefined ? current.objective : yield* objective(input.objective)
        yield* budget(input.tokenBudget)
        yield* timeBudget(input.timeBudgetSeconds)
        yield* costBudget(input.costBudgetUSD)
        const nextTokenBudget =
          input.tokenBudget === undefined ? current.tokens.budget : (input.tokenBudget ?? undefined)
        const nextTimeBudget =
          input.timeBudgetSeconds === undefined ? current.time.budgetSeconds : (input.timeBudgetSeconds ?? undefined)
        const nextCostBudgetMicro =
          input.costBudgetUSD === undefined
            ? current.cost.budgetMicroUSD
            : input.costBudgetUSD === null
              ? undefined
              : usdToMicro(input.costBudgetUSD)
        const nextStatus = input.status ?? current.status
        // A goal restart is either an objective rewrite OR a deliberate
        // complete -> active transition. Both cases mean "start over" — the
        // user's existing usage counters belong to the previous task and
        // should not gate the new one. Without this, /goal --budget=$X
        // <new objective> against a completed goal whose prior cost
        // already exceeded $X would immediately flip the new goal to
        // budget_limited and the route would skip kicking off continueGoal.
        const objectiveChanged = input.objective !== undefined && input.objective !== current.objective
        const restarting =
          objectiveChanged || (current.status === "complete" && (nextStatus === "active" || nextStatus === "budget_limited"))
        const baseTokensUsed = restarting ? 0 : current.tokens.used
        const baseTimeUsed = restarting ? 0 : current.time.used
        const baseCostUsedMicro = restarting ? 0 : current.cost.usedMicroUSD
        const tokensExhausted = nextTokenBudget !== undefined && baseTokensUsed >= nextTokenBudget
        const timeExhausted = nextTimeBudget !== undefined && baseTimeUsed >= nextTimeBudget
        const costExhausted = nextCostBudgetMicro !== undefined && baseCostUsedMicro >= nextCostBudgetMicro
        const exhausted = tokensExhausted || timeExhausted || costExhausted
        const status: Status =
          nextStatus === "active" || nextStatus === "budget_limited"
            ? exhausted
              ? "budget_limited"
              : "active"
            : nextStatus
        const next: Info = {
          ...current,
          objective: text,
          status,
          tokens: {
            used: baseTokensUsed,
            budget: nextTokenBudget,
          },
          time: {
            ...current.time,
            used: baseTimeUsed,
            budgetSeconds: nextTimeBudget,
            updated: Date.now(),
          },
          cost: {
            usedMicroUSD: baseCostUsedMicro,
            budgetMicroUSD: nextCostBudgetMicro,
          },
        }
        if (next.status !== "complete") completeAccounting.delete(input.sessionID)
        if (next.status !== "budget_limited") budgetAccounting.delete(input.sessionID)
        return yield* emit(next)
      })

      const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID) {
        completeAccounting.delete(sessionID)
        budgetAccounting.delete(sessionID)
        yield* Effect.sync(() => SyncEvent.run(Event.Cleared, { sessionID }))
      })

      const account = Effect.fn("SessionGoal.account")(function* (input: AccountInput) {
        const current = yield* get(input.sessionID)
        if (!current) return undefined
        const costMicroUSD = input.costMicroUSD ?? 0
        if (current.status === "complete") {
          const completion = completeAccounting.get(input.sessionID)
          if (!input.messageID || completion?.messageID !== input.messageID) return current
          const tokens = completion.tokens ? 0 : input.tokens
          const seconds = completion.time ? 0 : input.seconds
          const cost = completion.cost ? 0 : costMicroUSD
          if (tokens === 0 && seconds === 0 && cost === 0) return current
          if (input.tokens > 0) completion.tokens = true
          if (input.seconds > 0) completion.time = true
          if (costMicroUSD > 0) completion.cost = true
          if (completion.tokens && completion.time && completion.cost) completeAccounting.delete(input.sessionID)
          return yield* emit({
            ...current,
            tokens: {
              ...current.tokens,
              used: current.tokens.used + tokens,
            },
            time: {
              ...current.time,
              used: current.time.used + seconds,
              updated: Date.now(),
            },
            cost: {
              ...current.cost,
              usedMicroUSD: current.cost.usedMicroUSD + cost,
            },
          })
        }
        if (current.status !== "active") {
          if (current.status !== "budget_limited" || input.tokens !== 0 || input.seconds === 0) return current
          const tracked = budgetAccounting.get(input.sessionID)
          if (!tracked || tracked.time) return current
          if (tracked.messageID !== undefined && input.messageID !== tracked.messageID) return current
          tracked.time = true
          budgetAccounting.delete(input.sessionID)
          return yield* emit({
            ...current,
            time: {
              ...current.time,
              used: current.time.used + input.seconds,
              updated: Date.now(),
            },
          })
        }
        const newTokensUsed = current.tokens.used + input.tokens
        const newTimeUsed = current.time.used + input.seconds
        const newCostUsed = current.cost.usedMicroUSD + costMicroUSD
        const tokensExhausted = current.tokens.budget !== undefined && newTokensUsed >= current.tokens.budget
        const timeExhausted = current.time.budgetSeconds !== undefined && newTimeUsed >= current.time.budgetSeconds
        const costExhausted = current.cost.budgetMicroUSD !== undefined && newCostUsed >= current.cost.budgetMicroUSD
        const exhausted = tokensExhausted || timeExhausted || costExhausted
        const status: Status = exhausted ? "budget_limited" : current.status
        if (status === "budget_limited") {
          if (input.seconds > 0) budgetAccounting.delete(input.sessionID)
          else budgetAccounting.set(input.sessionID, { messageID: input.messageID, time: false })
        }
        const next = yield* emit({
          ...current,
          status,
          tokens: {
            ...current.tokens,
            used: newTokensUsed,
          },
          time: {
            ...current.time,
            used: newTimeUsed,
            updated: Date.now(),
          },
          cost: {
            ...current.cost,
            usedMicroUSD: newCostUsed,
          },
        })
        // `current.status` was "active" here (non-active returns above), so
        // `exhausted` marks exactly the active → budget_limited transition.
        if (exhausted) {
          yield* bus
            .publish(BusOnlyEvent.BudgetExhausted, { sessionID: input.sessionID, goal: next })
            .pipe(Effect.ignore)
        }
        return next
      })

      const modelUpdate = Effect.fn("SessionGoal.modelUpdate")(function* (input: ModelUpdateInput) {
        if (input.status !== "complete") {
          return yield* Effect.fail(new GoalError("Models can only mark goals complete"))
        }
        const goal = yield* update({ sessionID: input.sessionID, status: "complete" })
        if (input.messageID) {
          completeAccounting.set(input.sessionID, {
            messageID: input.messageID,
            tokens: false,
            time: false,
            cost: false,
          })
        }
        return goal
      })

      return Service.of({ get, listActive, create, update, clear, account, modelUpdate })
    }),
  )

  export const defaultLayer = layer
}
