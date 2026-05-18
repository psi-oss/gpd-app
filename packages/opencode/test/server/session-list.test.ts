import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage/db"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("session.list", () => {
  test("filters by directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await svc.create({})

        await using other = await tmpdir({ git: true })
        const second = await Instance.provide({
          directory: other.path,
          fn: async () => svc.create({}),
        })

        const sessions = [...svc.list({ directory: tmp.path })]
        const ids = sessions.map((s) => s.id)

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      },
    })
  })

  test("filters root sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await svc.create({ title: "root-session" })
        const child = await svc.create({ title: "child-session", parentID: root.id })

        const sessions = [...svc.list({ roots: true })]
        const ids = sessions.map((s) => s.id)

        expect(ids).toContain(root.id)
        expect(ids).not.toContain(child.id)
      },
    })
  })

  test("filters by start time", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "new-session" })
        const futureStart = Date.now() + 86400000

        const sessions = [...svc.list({ start: futureStart })]
        expect(sessions.length).toBe(0)
      },
    })
  })

  test("filters by search term", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "unique-search-term-abc" })
        await svc.create({ title: "other-session-xyz" })

        const sessions = [...svc.list({ search: "unique-search" })]
        const titles = sessions.map((s) => s.title)

        expect(titles).toContain("unique-search-term-abc")
        expect(titles).not.toContain("other-session-xyz")
      },
    })
  })

  test("respects limit parameter", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await svc.create({ title: "session-1" })
        await svc.create({ title: "session-2" })
        await svc.create({ title: "session-3" })

        const sessions = [...svc.list({ limit: 2 })]
        expect(sessions.length).toBe(2)
      },
    })
  })

  test("excludes archived sessions by default", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const active = await svc.create({ title: "active-session" })
        const archived = await svc.create({ title: "archived-session" })

        Database.use((db) =>
          db.update(SessionTable).set({ time_archived: Date.now() }).where(eq(SessionTable.id, archived.id)).run(),
        )

        const sessions = [...svc.list()]
        const ids = sessions.map((s) => s.id)
        expect(ids).toContain(active.id)
        expect(ids).not.toContain(archived.id)
      },
    })
  })

  test("archived sessions do not consume limit slots", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const s1 = await svc.create({ title: "session-1" })
        const s2 = await svc.create({ title: "session-2" })
        const archived = await svc.create({ title: "archived-session" })

        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ time_archived: Date.now(), time_updated: Date.now() + 1000 })
            .where(eq(SessionTable.id, archived.id))
            .run(),
        )

        const sessions = [...svc.list({ limit: 2 })]
        const ids = sessions.map((s) => s.id)
        expect(sessions.length).toBe(2)
        expect(ids).toContain(s1.id)
        expect(ids).toContain(s2.id)
        expect(ids).not.toContain(archived.id)
      },
    })
  })

  test("includes archived sessions when archived option is true", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const active = await svc.create({ title: "active-session" })
        const archived = await svc.create({ title: "archived-session" })

        Database.use((db) =>
          db.update(SessionTable).set({ time_archived: Date.now() }).where(eq(SessionTable.id, archived.id)).run(),
        )

        const sessions = [...svc.list({ archived: true })]
        const ids = sessions.map((s) => s.id)
        expect(ids).toContain(active.id)
        expect(ids).toContain(archived.id)
      },
    })
  })
})
