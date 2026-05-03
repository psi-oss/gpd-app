import { describe, expect, test } from "bun:test"
import { MAX_PROMPT_SESSIONS, promptScopeKey, prunePromptCache } from "./prompt"

describe("prompt cache eviction", () => {
  test("does not dispose the active prompt scope when pruning", () => {
    const disposed: string[] = []
    const active = promptScopeKey("/project", "current")
    const cache = new Map<string, { dispose: () => void }>()

    cache.set(active, { dispose: () => disposed.push(active) })
    for (let i = 0; i < MAX_PROMPT_SESSIONS + 2; i++) {
      const key = promptScopeKey("/project", `old-${i}`)
      cache.set(key, { dispose: () => disposed.push(key) })
    }

    prunePromptCache(cache, active)

    expect(cache.has(active)).toBe(true)
    expect(disposed).not.toContain(active)
    expect(cache.size).toBe(MAX_PROMPT_SESSIONS)
  })
})
