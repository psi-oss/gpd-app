import { afterEach, describe, expect, test } from "bun:test"
import {
  clearPaperArtifactSession,
  isAutoOpened,
  isUserClosed,
  listAutoOpened,
  markAutoOpened,
  markUserClosed,
  subscribePaperArtifactWatcher,
} from "./paper-artifact-watcher"

type Listener = (evt: { details: { type: string; properties?: unknown } }) => void

function makeSDK(opts: {
  manifest?: string | undefined
  readDelays?: number[]
  readFailures?: number
}) {
  let listener: Listener | undefined
  let readCalls = 0
  let failures = opts.readFailures ?? 0
  const delays = opts.readDelays ?? []

  return {
    sdk: {
      client: {
        file: {
          read: async (_req: { path: string }) => {
            const idx = readCalls
            readCalls += 1
            const delay = delays[idx] ?? 0
            if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay))
            if (failures > 0) {
              failures -= 1
              return { data: { content: "{" } }
            }
            return { data: { content: opts.manifest } }
          },
        },
      },
      event: {
        listen: (handler: Listener) => {
          listener = handler
          return () => {
            listener = undefined
          }
        },
      },
    },
    emit: (evt: Parameters<Listener>[0]) => listener?.(evt),
    readCalls: () => readCalls,
  }
}

const TEX_MANIFEST = JSON.stringify({
  artifacts: [
    { artifact_id: "tex-paper", category: "tex", path: "foo.tex" },
    { artifact_id: "pdf-foo", category: "pdf", path: "foo.pdf" },
  ],
})

afterEach(() => {
  clearPaperArtifactSession("test-session")
  clearPaperArtifactSession("other-session")
})

describe("paper-artifact-watcher", () => {
  test("opens the tex tab when manifest write event arrives", async () => {
    const opened: string[] = []
    const fixture = makeSDK({ manifest: TEX_MANIFEST })
    const stop = subscribePaperArtifactWatcher({
      sdk: fixture.sdk,
      sessionKey: () => "test-session",
      normalize: (input) => input,
      pathToTab: (p) => `file://${p}`,
      openTab: (tab) => {
        opened.push(tab)
      },
    })

    fixture.emit({
      details: {
        type: "file.watcher.updated",
        properties: { file: "GPD/publication/foo/manuscript/ARTIFACT-MANIFEST.json", event: "add" },
      },
    })
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(opened).toEqual(["file://GPD/publication/foo/manuscript/foo.tex"])
    expect(isAutoOpened("test-session", "file://GPD/publication/foo/manuscript/foo.tex")).toBe(true)
    stop()
  })

  test("does not re-open after a subsequent manifest write in the same session", async () => {
    const opened: string[] = []
    const fixture = makeSDK({ manifest: TEX_MANIFEST })
    const stop = subscribePaperArtifactWatcher({
      sdk: fixture.sdk,
      sessionKey: () => "test-session",
      normalize: (input) => input,
      pathToTab: (p) => `file://${p}`,
      openTab: (tab) => {
        opened.push(tab)
      },
    })

    fixture.emit({
      details: {
        type: "file.watcher.updated",
        properties: { file: "GPD/publication/foo/manuscript/ARTIFACT-MANIFEST.json", event: "add" },
      },
    })
    await new Promise<void>((r) => setTimeout(r, 10))
    fixture.emit({
      details: {
        type: "file.watcher.updated",
        properties: { file: "GPD/publication/foo/manuscript/ARTIFACT-MANIFEST.json", event: "change" },
      },
    })
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(opened).toEqual(["file://GPD/publication/foo/manuscript/foo.tex"])
    stop()
  })

  test("respects sticky user-close", async () => {
    const opened: string[] = []
    const tab = "file://GPD/publication/foo/manuscript/foo.tex"
    markUserClosed("test-session", tab)
    const fixture = makeSDK({ manifest: TEX_MANIFEST })
    const stop = subscribePaperArtifactWatcher({
      sdk: fixture.sdk,
      sessionKey: () => "test-session",
      normalize: (input) => input,
      pathToTab: (p) => `file://${p}`,
      openTab: (t) => {
        opened.push(t)
      },
    })

    fixture.emit({
      details: {
        type: "file.watcher.updated",
        properties: { file: "GPD/publication/foo/manuscript/ARTIFACT-MANIFEST.json", event: "change" },
      },
    })
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(opened).toEqual([])
    expect(isUserClosed("test-session", tab)).toBe(true)
    expect(isAutoOpened("test-session", tab)).toBe(false)
    stop()
  })

  test("ignores non-manifest paths", async () => {
    const opened: string[] = []
    const fixture = makeSDK({ manifest: TEX_MANIFEST })
    const stop = subscribePaperArtifactWatcher({
      sdk: fixture.sdk,
      sessionKey: () => "test-session",
      normalize: (input) => input,
      pathToTab: (p) => `file://${p}`,
      openTab: (t) => {
        opened.push(t)
      },
    })

    fixture.emit({
      details: {
        type: "file.watcher.updated",
        properties: { file: "src/foo.ts", event: "change" },
      },
    })
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(opened).toEqual([])
    expect(fixture.readCalls()).toBe(0)
    stop()
  })

  test("ignores unlink events for the manifest", async () => {
    const opened: string[] = []
    const fixture = makeSDK({ manifest: TEX_MANIFEST })
    const stop = subscribePaperArtifactWatcher({
      sdk: fixture.sdk,
      sessionKey: () => "test-session",
      normalize: (input) => input,
      pathToTab: (p) => `file://${p}`,
      openTab: (t) => {
        opened.push(t)
      },
    })

    fixture.emit({
      details: {
        type: "file.watcher.updated",
        properties: { file: "GPD/publication/foo/manuscript/ARTIFACT-MANIFEST.json", event: "unlink" },
      },
    })
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(opened).toEqual([])
    stop()
  })

  test("retries once on partial-write JSON parse failure", async () => {
    const opened: string[] = []
    const fixture = makeSDK({ manifest: TEX_MANIFEST, readFailures: 1 })
    const stop = subscribePaperArtifactWatcher({
      sdk: fixture.sdk,
      sessionKey: () => "test-session",
      normalize: (input) => input,
      pathToTab: (p) => `file://${p}`,
      openTab: (t) => {
        opened.push(t)
      },
    })

    fixture.emit({
      details: {
        type: "file.watcher.updated",
        properties: { file: "GPD/publication/foo/manuscript/ARTIFACT-MANIFEST.json", event: "change" },
      },
    })
    await new Promise<void>((r) => setTimeout(r, 200))

    expect(opened).toEqual(["file://GPD/publication/foo/manuscript/foo.tex"])
    expect(fixture.readCalls()).toBe(2)
    stop()
  })

  test("listAutoOpened reflects markAutoOpened", () => {
    expect(listAutoOpened("test-session")).toEqual([])
    markAutoOpened("test-session", "file://a.tex")
    markAutoOpened("test-session", "file://b.tex")
    expect(listAutoOpened("test-session")).toEqual(["file://a.tex", "file://b.tex"])
    expect(listAutoOpened("other-session")).toEqual([])
  })

  test("clearPaperArtifactSession wipes both sets for the given session", () => {
    markAutoOpened("test-session", "file://a.tex")
    markUserClosed("test-session", "file://b.tex")
    markAutoOpened("other-session", "file://x.tex")

    clearPaperArtifactSession("test-session")

    expect(listAutoOpened("test-session")).toEqual([])
    expect(isUserClosed("test-session", "file://b.tex")).toBe(false)
    expect(listAutoOpened("other-session")).toEqual(["file://x.tex"])
  })

  test("handles manifest without a tex artifact", async () => {
    const opened: string[] = []
    const fixture = makeSDK({ manifest: JSON.stringify({ artifacts: [{ category: "pdf", path: "foo.pdf" }] }) })
    const stop = subscribePaperArtifactWatcher({
      sdk: fixture.sdk,
      sessionKey: () => "test-session",
      normalize: (input) => input,
      pathToTab: (p) => `file://${p}`,
      openTab: (t) => {
        opened.push(t)
      },
    })

    fixture.emit({
      details: {
        type: "file.watcher.updated",
        properties: { file: "GPD/publication/foo/manuscript/ARTIFACT-MANIFEST.json", event: "add" },
      },
    })
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(opened).toEqual([])
    stop()
  })

  test("handles top-level manifest with no parent directory", async () => {
    const opened: string[] = []
    const fixture = makeSDK({ manifest: TEX_MANIFEST })
    const stop = subscribePaperArtifactWatcher({
      sdk: fixture.sdk,
      sessionKey: () => "test-session",
      normalize: (input) => input,
      pathToTab: (p) => `file://${p}`,
      openTab: (t) => {
        opened.push(t)
      },
    })

    fixture.emit({
      details: {
        type: "file.watcher.updated",
        properties: { file: "ARTIFACT-MANIFEST.json", event: "add" },
      },
    })
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(opened).toEqual(["file://foo.tex"])
    stop()
  })
})
