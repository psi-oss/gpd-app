import { describe, expect, test } from "bun:test"
import { deleteProjectMetadata } from "./dialog-confirm-delete-project"

describe("deleteProjectMetadata", () => {
  test("skips the server for local projects without an id", async () => {
    let calls = 0
    await deleteProjectMetadata({
      project: { worktree: "/tmp/local", expanded: true },
      deleteProject: async () => {
        calls++
      },
    })
    expect(calls).toBe(0)
  })

  test("skips the server for the global project", async () => {
    let calls = 0
    await deleteProjectMetadata({
      project: { id: "global", worktree: "/", expanded: true },
      deleteProject: async () => {
        calls++
      },
    })
    expect(calls).toBe(0)
  })

  test("deletes persisted projects from the server", async () => {
    const calls: Array<{ projectID: string; directory: string }> = []
    await deleteProjectMetadata({
      project: { id: "abc", worktree: "/tmp/project", expanded: true },
      deleteProject: async (input) => {
        calls.push(input)
      },
    })
    expect(calls).toEqual([{ projectID: "abc", directory: "/tmp/project" }])
  })

  test("treats NotFoundError as already deleted", async () => {
    await expect(
      deleteProjectMetadata({
        project: { id: "abc", worktree: "/tmp/project", expanded: true },
        deleteProject: async () => {
          throw { name: "NotFoundError", message: "Project not found: abc" }
        },
      }),
    ).resolves.toBeUndefined()
  })

  test("rethrows non-404 failures", async () => {
    const error = new Error("network down")
    await expect(
      deleteProjectMetadata({
        project: { id: "abc", worktree: "/tmp/project", expanded: true },
        deleteProject: async () => {
          throw error
        },
      }),
    ).rejects.toBe(error)
  })
})
