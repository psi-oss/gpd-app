import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Database, eq } from "../../src/storage/db"
import { MessageTable } from "../../src/session/session.sql"
import { tmpdir } from "../fixture/fixture"

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

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

describe("session.created event", () => {
  test("should emit session.created event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: SessionNs.Info | undefined

        const unsub = Bus.subscribe(SessionNs.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as SessionNs.Info
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(info.id)
        expect(receivedInfo?.projectID).toBe(info.projectID)
        expect(receivedInfo?.directory).toBe(info.directory)
        expect(receivedInfo?.title).toBe(info.title)

        await remove(info.id)
      },
    })
  })

  test("session.created event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubCreated = Bus.subscribe(SessionNs.Event.Created, () => {
          events.push("created")
        })

        const unsubUpdated = Bus.subscribe(SessionNs.Event.Updated, () => {
          events.push("updated")
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsubCreated()
        unsubUpdated()

        expect(events).toContain("created")
        expect(events).toContain("updated")
        expect(events.indexOf("created")).toBeLessThan(events.indexOf("updated"))

        await remove(info.id)
      },
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await create({})

          const messageID = MessageID.ascending()
          await updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          let received: MessageV2.Part | undefined
          const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            received = event.properties.part
          })

          const tokens = {
            total: 1500,
            input: 500,
            output: 800,
            reasoning: 200,
            cache: { read: 100, write: 50 },
          }

          const partInput = {
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens,
          }

          await updatePart(partInput)
          await new Promise((resolve) => setTimeout(resolve, 100))

          expect(received).toBeDefined()
          expect(received!.type).toBe("step-finish")
          const finish = received as MessageV2.StepFinishPart
          expect(finish.tokens.input).toBe(500)
          expect(finish.tokens.output).toBe(800)
          expect(finish.tokens.reasoning).toBe(200)
          expect(finish.tokens.total).toBe(1500)
          expect(finish.tokens.cache.read).toBe(100)
          expect(finish.tokens.cache.write).toBe(50)
          expect(finish.cost).toBe(0.005)
          expect(received).not.toBe(partInput)

          unsub()
          await remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("Session", () => {
  test("remove works without an instance", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await Instance.provide({
      directory: tmp.path,
      fn: () => create({ title: "remove-without-instance" }),
    })

    await expect(async () => {
      await remove(info.id)
    }).not.toThrow()

    let missing = false
    await get(info.id).catch(() => {
      missing = true
    })

    expect(missing).toBe(true)
  })
})

describe("finalizeOrphanedAssistants", () => {
  test("finalizes mid-stream assistant messages from a previous sidecar", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await create({ title: "orphan-recovery" })

        // Simulate a prior sidecar that wrote a user message + an assistant
        // message that streamed reasoning then died before time.completed.
        const userID = MessageID.ascending()
        await updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
        } as unknown as MessageV2.Info)

        const orphanID = MessageID.ascending()
        const orphan: MessageV2.Assistant = {
          id: orphanID,
          sessionID: session.id,
          parentID: userID,
          role: "assistant",
          time: { created: Date.now() }, // no `completed` — the bug condition
          modelID: "test" as unknown as MessageV2.Assistant["modelID"],
          providerID: "test" as unknown as MessageV2.Assistant["providerID"],
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        }
        await updateMessage(orphan)

        // Sanity-check: row exists, time.completed not set.
        const beforeRow = Database.use((d) =>
          d.select().from(MessageTable).where(eq(MessageTable.id, orphanID)).get(),
        )
        expect(beforeRow).toBeDefined()
        expect((beforeRow!.data as MessageV2.Assistant).time.completed).toBeUndefined()

        // Drive the recovery pass directly (Layer init already ran above
        // and found nothing; this simulates a fresh sidecar starting up
        // against the now-orphaned row).
        const fixedAt = Date.now()
        const count = SessionNs.finalizeOrphanedAssistants(fixedAt)
        expect(count).toBe(1)

        // Wait for projector + bus delivery.
        await new Promise((resolve) => setTimeout(resolve, 50))

        const afterRow = Database.use((d) =>
          d.select().from(MessageTable).where(eq(MessageTable.id, orphanID)).get(),
        )
        const after = afterRow!.data as MessageV2.Assistant
        expect(after.time.completed).toBe(fixedAt)
        expect(after.error?.name).toBe("APIError")
        expect((after.error as MessageV2.APIError).data.isRetryable).toBe(true)

        // Idempotent: a second pass should be a no-op (the row no longer
        // matches the orphan predicate).
        const secondCount = SessionNs.finalizeOrphanedAssistants(fixedAt + 1)
        expect(secondCount).toBe(0)

        // Pre-existing error is preserved, not overwritten.
        const alreadyErroredID = MessageID.ascending()
        const preExistingError = new MessageV2.AbortedError({ message: "user abort" }).toObject()
        await updateMessage({
          ...orphan,
          id: alreadyErroredID,
          time: { created: Date.now() },
          error: preExistingError,
        } satisfies MessageV2.Assistant)
        const thirdCount = SessionNs.finalizeOrphanedAssistants(fixedAt + 2)
        expect(thirdCount).toBe(1)
        const stillAborted = Database.use((d) =>
          d.select().from(MessageTable).where(eq(MessageTable.id, alreadyErroredID)).get(),
        )
        expect((stillAborted!.data as MessageV2.Assistant).error?.name).toBe("MessageAbortedError")
        expect((stillAborted!.data as MessageV2.Assistant).time.completed).toBe(fixedAt + 2)

        await remove(session.id)
      },
    })
  })

  test("leaves completed assistant messages alone", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await create({ title: "no-orphans" })

        const completedID = MessageID.ascending()
        const completedAt = Date.now()
        await updateMessage({
          id: completedID,
          sessionID: session.id,
          parentID: MessageID.ascending(),
          role: "assistant",
          time: { created: completedAt - 1000, completed: completedAt },
          modelID: "test" as unknown as MessageV2.Assistant["modelID"],
          providerID: "test" as unknown as MessageV2.Assistant["providerID"],
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies MessageV2.Assistant)

        const count = SessionNs.finalizeOrphanedAssistants(Date.now())
        expect(count).toBe(0)

        const row = Database.use((d) =>
          d.select().from(MessageTable).where(eq(MessageTable.id, completedID)).get(),
        )
        expect((row!.data as MessageV2.Assistant).time.completed).toBe(completedAt)

        await remove(session.id)
      },
    })
  })
})
