import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { isProcessAlive } from "../../src/cli/cmd/serve"

describe("orphan-watchdog parent liveness probe", () => {
  test("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  test("reports a reaped pid as dead (the case the old process.ppid check missed)", async () => {
    // Spawn a trivial process, let it exit, reap it, then probe its pid.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
    const pid = child.pid!
    await new Promise<void>((resolve) => child.on("exit", () => resolve()))
    // Give the OS a tick to fully reap before probing.
    await new Promise((r) => setTimeout(r, 50))
    expect(isProcessAlive(pid)).toBe(false)
  })

  test("a never-allocated pid reads as dead", () => {
    // Well above any live pid on macOS/Linux in practice.
    expect(isProcessAlive(0x7fffffff)).toBe(false)
  })
})
