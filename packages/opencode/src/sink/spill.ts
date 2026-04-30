import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Log } from "@/util/log"

/**
 * On-disk spill buffer for /gpd/log flushes that failed to reach the proxy.
 *
 * Each spill entry is a pre-gzipped request body plus its query params
 * serialized as a sidecar `.meta` file. The replay loop posts them in
 * FIFO order and unlinks on 2xx.
 *
 * Crash safety: writes go to `<ulid>.gz.tmp` + `.meta.tmp` first, then
 * we `fsync` the files and `rename` both into place. A truncated tmp
 * pair is garbage-collected by the replay loop on boot.
 *
 * Budget: total spill dir is capped at `OPENCODE_GPD_LOG_SPILL_MAX_BYTES`
 * (default 1 GiB). When we'd exceed the budget, the oldest files are
 * deleted FIFO. Filenames sort lexicographically == chronologically
 * because they use ULIDs.
 */
export namespace GpdLogSpill {
  const log = Log.create({ service: "gpd-log-spill" })

  export type Meta = {
    sessionID: string
    rootSessionID: string
    seq: string
    contentLength: number
    createdAt: number
  }

  const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024 // 1 GiB

  export function dir(): string {
    return path.join(Global.Path.data, "gpd-log-spill")
  }

  function maxBytes(): number {
    const raw = process.env["OPENCODE_GPD_LOG_SPILL_MAX_BYTES"]
    if (!raw) return DEFAULT_MAX_BYTES
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES
  }

  async function fsyncAndClose(filePath: string): Promise<void> {
    const fh = await fs.open(filePath, "r+")
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
  }

  async function fsyncDir(dirPath: string): Promise<void> {
    try {
      const fh = await fs.open(dirPath, "r")
      try {
        // Node's `fs.Dir.sync` is not universally available; use FileHandle.sync
        // which maps to fsync(2) on the underlying fd. Supported on POSIX.
        await fh.sync().catch(() => undefined)
      } finally {
        await fh.close()
      }
    } catch {
      // Directory fsync is best-effort (no-op on Windows).
    }
  }

  /**
   * Atomically persist one flush to disk. Returns the ULID filename stem.
   *
   * Crash-recovery contract: meta-presence is the commit marker. The gz
   * rename + dir-fsync happens FIRST, then the meta rename + dir-fsync
   * second. Three reasons:
   *
   *   1. A crash AFTER gz rename but BEFORE meta rename leaves an orphan
   *      gz with no meta. `list()` (below) garbage-collects orphan gz
   *      files at boot. We lose that one flush — bounded, no replay
   *      surprise — but never serve half-corrupt data downstream.
   *
   *   2. A crash AFTER both renames but BEFORE the meta dir-fsync is
   *      durable: meta dirent might or might not be visible after
   *      reboot. If it is, the entry replays normally. If it isn't,
   *      the orphan-gz path (#1) kicks in. Either way, no torn read.
   *
   *   3. The PRIOR ordering wrote both renames before any dir-fsync,
   *      relying on POSIX dirent batching to publish them together.
   *      ext4 with `data=ordered` and APFS do NOT guarantee that — a
   *      crash mid-batch could leave gz visible + meta absent without
   *      a fsync barrier between them. We saw zero evidence of data
   *      loss in practice, but the window is real and trivial to
   *      close (one extra fsync per write, ~1 ms on SSD).
   */
  export async function write(ulid: string, meta: Meta, body: Uint8Array): Promise<string> {
    const d = dir()
    await fs.mkdir(d, { recursive: true })

    const base = path.join(d, ulid)
    const gzPath = `${base}.gz`
    const metaPath = `${base}.meta`
    const gzTmp = `${gzPath}.tmp`
    const metaTmp = `${metaPath}.tmp`

    await fs.writeFile(gzTmp, body)
    await fsyncAndClose(gzTmp)
    await fs.writeFile(metaTmp, JSON.stringify(meta))
    await fsyncAndClose(metaTmp)

    // Step 1: publish gz, fsync the directory so the dirent is durable
    // BEFORE the meta dirent lands. After this fsync, an in-progress
    // `list()` would see gz-only and treat it as orphan (correct).
    await fs.rename(gzTmp, gzPath)
    await fsyncDir(d)

    // Step 2: publish meta. Dir-fsync makes the meta dirent durable and
    // commits the entry as a complete flush. From this fsync forward the
    // entry is recoverable across crashes.
    await fs.rename(metaTmp, metaPath)
    await fsyncDir(d)

    await enforceBudget()
    return ulid
  }

  /**
   * Drop oldest-first until total on-disk bytes ≤ budget.
   */
  async function enforceBudget(): Promise<void> {
    const limit = maxBytes()
    const entries = await list()
    let total = entries.reduce((acc, e) => acc + e.size, 0)
    if (total <= limit) return

    // Sorted oldest-first by name (ULIDs are monotonic).
    for (const e of entries) {
      if (total <= limit) break
      await remove(e.ulid).catch(() => undefined)
      total -= e.size
      log.warn("dropped spill entry under budget pressure", { ulid: e.ulid, bytes: e.size })
    }
  }

  export type Entry = { ulid: string; size: number; meta: Meta }

  /**
   * List spill entries oldest-first, skipping orphaned tmp / meta-only
   * pairs (crash-safety: a half-written pair is garbage).
   */
  export async function list(): Promise<Entry[]> {
    const d = dir()
    let names: string[]
    try {
      names = await fs.readdir(d)
    } catch (e: any) {
      if (e?.code === "ENOENT") return []
      throw e
    }

    const gzSet = new Set<string>()
    const metaSet = new Set<string>()
    for (const n of names) {
      if (n.endsWith(".gz") && !n.endsWith(".gz.tmp")) gzSet.add(n.slice(0, -3))
      else if (n.endsWith(".meta") && !n.endsWith(".meta.tmp")) metaSet.add(n.slice(0, -5))
    }

    const valid: Entry[] = []
    for (const ulid of gzSet) {
      if (!metaSet.has(ulid)) continue
      const gzPath = path.join(d, `${ulid}.gz`)
      const metaPath = path.join(d, `${ulid}.meta`)
      try {
        const [stat, metaTxt] = await Promise.all([fs.stat(gzPath), fs.readFile(metaPath, "utf8")])
        const meta = JSON.parse(metaTxt) as Meta
        valid.push({ ulid, size: stat.size, meta })
      } catch (e) {
        log.warn("skipping malformed spill entry", { ulid, error: (e as Error).message })
      }
    }

    // Garbage-collect .tmp leftovers from crashes.
    for (const n of names) {
      if (n.endsWith(".tmp")) {
        await fs.unlink(path.join(d, n)).catch(() => undefined)
      }
    }
    // Orphan .gz without .meta (or vice versa) from partial writes.
    for (const ulid of gzSet) {
      if (!metaSet.has(ulid)) await fs.unlink(path.join(d, `${ulid}.gz`)).catch(() => undefined)
    }
    for (const ulid of metaSet) {
      if (!gzSet.has(ulid)) await fs.unlink(path.join(d, `${ulid}.meta`)).catch(() => undefined)
    }

    // Lexicographic == chronological for ULIDs.
    valid.sort((a, b) => (a.ulid < b.ulid ? -1 : a.ulid > b.ulid ? 1 : 0))
    return valid
  }

  /**
   * Read the gzipped body for a spill entry.
   */
  export async function readBody(ulid: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(path.join(dir(), `${ulid}.gz`)))
  }

  /**
   * Delete both files for a spill entry (ignore missing).
   */
  export async function remove(ulid: string): Promise<void> {
    const d = dir()
    await Promise.all([
      fs.unlink(path.join(d, `${ulid}.gz`)).catch(() => undefined),
      fs.unlink(path.join(d, `${ulid}.meta`)).catch(() => undefined),
    ])
  }

  /**
   * Drop every entry in the spill dir. Used by Auth.remove("gpd") to
   * close a privacy-regression window: without this, queued events
   * captured BETWEEN a consent revocation and the next sign-in would
   * replay to the proxy as soon as the user re-pasted a key — i.e.
   * post-revoke buffered events would still ship, defeating the user's
   * withdrawal.
   *
   * Best-effort: a stat / unlink failure does not throw, the caller's
   * revoke flow must succeed even if the spill dir is unreadable. Future
   * writes will be re-gated upstream by the auth-presence check in
   * gpd-logger.ts:enqueue, so a stale entry here cannot reappear without
   * a fresh sign-in.
   */
  export async function wipe(): Promise<void> {
    const d = dir()
    let names: string[]
    try {
      names = await fs.readdir(d)
    } catch (e: any) {
      if (e?.code === "ENOENT") return
      log.warn("wipe: readdir failed", { error: (e as Error).message })
      return
    }
    await Promise.all(
      names.map((n) => fs.unlink(path.join(d, n)).catch(() => undefined)),
    )
    await fsyncDir(d).catch(() => undefined)
  }
}
