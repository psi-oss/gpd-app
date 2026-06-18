import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"

/**
 * Self-exit if our parent process dies. Tauri on macOS/Linux has no
 * kernel-level parent-death cleanup (Windows is covered at spawn time by
 * JobObject + KillOnDrop in src-tauri/src/cli.rs). When the Tauri parent
 * is killed ungracefully (SIGKILL from Activity Monitor, panic, OOM, or
 * `bun tauri dev` hot-rebuild), RunEvent::Exit never fires, so the async
 * kill channel in the Rust side never runs, and this sidecar survives,
 * pegging CPU indefinitely. Observed in the wild: 4 orphans at 100% CPU
 * for 24+ hours on a dev laptop.
 *
 * Detection: probe the ORIGINAL parent's liveness with `process.kill(pid, 0)`
 * (signal 0 sends nothing — it only validates the target exists; throws
 * ESRCH once the parent is gone). We do NOT compare `process.ppid` against
 * its initial value: bun caches `process.ppid` at startup and never refreshes
 * it after the kernel reparents an orphan, so the old `process.ppid !==
 * initialPpid` check was dead — it stayed equal forever and the watchdog
 * never fired (verified 2026-06-18: kernel reparented an orphaned sidecar to
 * PID 1 while bun's `process.ppid` kept reporting the dead parent's PID; and
 * `process.getppid()` does not exist in bun). Probing the captured parent PID
 * directly sidesteps the stale-ppid cache entirely.
 *
 * PID-reuse caveat: between the parent dying and the next poll the OS could
 * recycle its PID onto an unrelated process, which would read as "alive" for
 * up to one interval. macOS/Linux cycle PIDs through a large space so a
 * collision inside a ~3s window is vanishingly unlikely, and the failure mode
 * is benign (one extra interval of life), so this is an acceptable trade vs.
 * the heavier pipe-FD handshake.
 *
 * Gated to GPD-spawned sidecars via OPENCODE_CLIENT=desktop (set in
 * src-tauri/src/cli.rs when spawning us). Standalone `opencode serve &`
 * users — who may intentionally detach the process past the parent shell
 * — are unaffected. Containers whose entrypoint is opencode start with
 * PPID=1; the `parentPid <= 1` short-circuit skips them too (the
 * container orchestrator owns lifecycle).
 */
/**
 * True if a process with `pid` currently exists. Uses signal 0, which
 * sends nothing and only validates the target: it returns on success,
 * throws ESRCH when the pid is gone, and EPERM when the pid exists but
 * belongs to another user (treated as alive — defensive; never the case
 * for our own parent). Deliberately does NOT consult `process.ppid`,
 * which bun caches at startup and never refreshes after reparenting.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === "EPERM"
  }
}

function startOrphanWatchdog(): void {
  if (process.platform === "win32") return
  if (process.env["OPENCODE_CLIENT"] !== "desktop") return
  // Captured once at startup, while it still reflects the real spawning
  // parent. bun's caching of process.ppid is fine here — we want the
  // spawn-time value and probe THAT pid's liveness from now on.
  const parentPid = process.ppid
  if (!parentPid || parentPid <= 1) return
  setInterval(() => {
    if (!isProcessAlive(parentPid)) {
      console.error(`[orphan-watchdog] parent ${parentPid} is gone, self-exiting`)
      process.exit(0)
    }
  }, 3_000).unref()
}

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    startOrphanWatchdog()
    const opts = await resolveNetworkOptions(args)
    const server = await Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    await new Promise(() => {})
    await server.stop()
  },
})
