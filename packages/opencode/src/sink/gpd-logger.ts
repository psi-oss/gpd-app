import { Context, Duration, Effect, Exit, Layer, Scope, Stream } from "effect"
import { createHash } from "node:crypto"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import type { Snapshot } from "@/snapshot"
import { Log } from "@/util/log"
import { GpdLog } from "./schema"
import { GpdLogWriter } from "./jsonl-writer"
import { GpdLogHttp } from "./http-writer"
import { ulid } from "ulid"

export namespace GpdLogger {

  const log = Log.create({ service: "gpd-logger" })
  const enabled =
    process.env["OPENCODE_GPD_LOGS_ENABLED"] === "1" || process.env["OPENCODE_GPD_LOGS_ENABLED"] === "true"

  type QueuedEvent =
    | { kind: "message"; sessionID: SessionID; info: MessageV2.Info }
    | { kind: "part"; sessionID: SessionID; part: MessageV2.Part }
    | { kind: "session"; sessionID: SessionID; info: Session.Info }
    /**
     * Per-file diff slot. The cumulative `Session.Event.Diff` payload is
     * fanned out into one entry per file at watch time (see the
     * `Session.Event.Diff` subscriber). Coalesced under `diff/<file>` so
     * multiple bus events for the same file in a flush window collapse
     * to the latest patch. Materialises into a `session_diff_file` log
     * event.
     */
    | { kind: "diff_file"; sessionID: SessionID; file: Snapshot.FileDiff }
    | { kind: "deleted"; sessionID: SessionID }

  type State = {
    /** Per-session event queue, keyed by coalesce-key within the session. */
    queue: Map<SessionID, Map<string, QueuedEvent>>
    /** Cached root-session ID per session to avoid repeated DB walks. */
    rootCache: Map<SessionID, SessionID>
    /** Tracks sessions we've already written the `session_init` header for. */
    initialized: Set<SessionID>
    /**
     * Per-session map of `file_path → sha256(patch_or_status)` for the
     * files we have already emitted to the proxy. Used to dedupe the
     * cumulative bus diff payload at enqueue time so each (file,
     * content) pair ships at most once per session per content change.
     *
     * Invariant: after each successful enqueue pass over a bus event,
     * this map equals exactly the files present in the most recent
     * cumulative diff (same as the proxy's view, modulo in-flight
     * POSTs). Files dropped from the cumulative diff (e.g. via revert)
     * are removed; if they are later re-modified the new hash differs
     * and we re-emit. See SessionDiffFileEvent in schema.ts for the
     * full rationale.
     */
    lastEmittedDiff: Map<SessionID, Map<string, string>>
    scope: Scope.Closeable
    /** Idempotency latch for `drainPending`. Set true on first drain call. */
    draining: boolean
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    /**
     * Flush all pending queued events synchronously (bounded by
     * `OPENCODE_GPD_SHUTDOWN_TIMEOUT_MS`, default 5000). Called by
     * the SIGTERM/SIGINT handler in `index.ts` and by the Scope
     * finalizer. Idempotent — a second concurrent call is a no-op.
     */
    readonly drainPending: () => Effect.Effect<void>
  }

  /**
   * Maximum concurrent POSTs during drain. LiteLLM tolerates bursts;
   * 8 saturates a typical home connection without proxy-thundering.
   * Realistic session count at quit (~10-20 per docs/LOGGING.md:77)
   * finishes in 2-3 batches inside the 5000ms budget.
   */
  const DRAIN_CONCURRENCY = 8

  /**
   * Default overall wall-clock budget for drainPending, in ms.
   *
   * Was 1500ms — observed that on slow / hotel networks one POST RTT
   * could already eat the budget, so a single drain rarely landed more
   * than the first wave of 8 sessions, and the rest were spilled +
   * deferred to next-boot replay. Not a leak (events still ship), but
   * it costs an extra startup network round-trip and racy "data shows
   * up tomorrow" UX on slow links. 5s tolerates a 600ms RTT × 8 batches
   * comfortably while still feeling instant on quit. Override per-user
   * via OPENCODE_GPD_SHUTDOWN_TIMEOUT_MS (see resolveBudgetMs below).
   */
  const DEFAULT_SHUTDOWN_BUDGET_MS = 5000

  export class Service extends Context.Service<Service, Interface>()("@opencode/GpdLogger") {}

  function coalesceKey(evt: QueuedEvent): string {
    switch (evt.kind) {
      case "session":
        return "session"
      case "message":
        return `msg/${evt.info.id}`
      case "part":
        return `part/${evt.part.messageID}/${evt.part.id}`
      case "diff_file":
        // Per-file slot. Two bus events touching the same file within a
        // single flush window collapse to the latest patch; different
        // files queue independently.
        return `diff/${evt.file.file}`
      case "deleted":
        return "deleted"
    }
  }

  /**
   * Hash a single file diff entry for dedup purposes. The patch string
   * already contains the full file content (because `snapshot/index.ts`
   * uses `context: Number.MAX_SAFE_INTEGER`), so `sha256(patch)` is
   * sufficient to detect "did the after-content change". For files
   * with empty patch (binary or deleted), include status + path so
   * transitions like added → deleted produce distinct hashes and we
   * emit a "now deleted" event exactly once.
   */
  function hashFileDiff(fd: Snapshot.FileDiff): string {
    const h = createHash("sha256")
    if (fd.patch && fd.patch.length > 0) {
      h.update(fd.patch)
      return h.digest("hex")
    }
    h.update(fd.status ?? "unknown")
    h.update(":")
    h.update(fd.file)
    h.update(":")
    h.update(String(fd.additions))
    h.update(":")
    h.update(String(fd.deletions))
    return h.digest("hex")
  }

  /** Walk up the parent chain once, memoised per session. */
  function resolveRoot(
    sessions: Session.Interface,
    cache: Map<SessionID, SessionID>,
    sessionID: SessionID,
  ): Effect.Effect<SessionID> {
    const cached = cache.get(sessionID)
    if (cached) return Effect.succeed(cached)
    return Effect.gen(function* () {
      const root = yield* sessions.root(sessionID)
      cache.set(sessionID, root)
      return root
    })
  }

  /** Materialise queued events into GpdLog.Event lines, including session_init on first touch. */
  function materialise(
    sessionID: SessionID,
    rootSessionID: SessionID,
    parentSessionID: SessionID | null,
    sessionInfo: Session.Info | undefined,
    queued: QueuedEvent[],
    initialized: Set<SessionID>,
  ): GpdLog.Event[] {
    const out: GpdLog.Event[] = []
    const now = Date.now()

    if (!initialized.has(sessionID) && sessionInfo) {
      out.push({
        kind: "session_init",
        v: GpdLog.SCHEMA_VERSION,
        ts: now,
        sessionID,
        parentSessionID,
        rootSessionID,
        info: sessionInfo,
      })
      initialized.add(sessionID)
    }

    // Pre-count the per-file diff entries so each event carries an
    // accurate `total`. One `flushID` per materialise call groups all
    // diff_file events from this flush into a logical batch.
    const diffFiles = queued.filter((e): e is Extract<QueuedEvent, { kind: "diff_file" }> => e.kind === "diff_file")
    const flushID = diffFiles.length > 0 ? ulid() : ""
    let diffIdx = 0

    for (const evt of queued) {
      switch (evt.kind) {
        case "message":
          out.push({
            kind: "message_updated",
            v: GpdLog.SCHEMA_VERSION,
            ts: now,
            sessionID: evt.sessionID,
            info: evt.info,
          })
          break
        case "part":
          out.push({
            kind: "part_updated",
            v: GpdLog.SCHEMA_VERSION,
            ts: now,
            sessionID: evt.sessionID,
            part: evt.part,
          })
          break
        case "session":
          // already folded into session_init; no extra line needed.
          break
        case "diff_file":
          out.push({
            kind: "session_diff_file",
            v: GpdLog.SCHEMA_VERSION,
            ts: now,
            sessionID: evt.sessionID,
            file: evt.file,
            flushID,
            idx: diffIdx,
            total: diffFiles.length,
          })
          diffIdx++
          break
        case "deleted":
          out.push({
            kind: "session_deleted",
            v: GpdLog.SCHEMA_VERSION,
            ts: now,
            sessionID: evt.sessionID,
          })
          break
      }
    }

    return out
  }

  // When OPENCODE_GPD_LOG_LOCAL_MIRROR=1, also write events to on-disk
  // JSONL files at ~/.local/share/opencode/gpd-session-logs/ for local
  // debugging. Off by default — production relies on GCS, not local FS.
  const localMirror =
    process.env["OPENCODE_GPD_LOG_LOCAL_MIRROR"] === "1" ||
    process.env["OPENCODE_GPD_LOG_LOCAL_MIRROR"] === "true"

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service

      function enqueue(sessionID: SessionID, evt: QueuedEvent): Effect.Effect<void> {
        return Effect.gen(function* () {
          if (!enabled) return
          // Auth-presence gate: drop events when the user has no GPD key
          // in auth.json. The downstream writer would spill them to disk
          // (http-writer.ts:64-68), and the replay loop would drain them
          // to the proxy the moment a key reappears — including events
          // captured during a revoked-consent window. That re-delivery
          // is the privacy regression we're closing here.
          //
          // No spill, no event, no buffered post-revoke leak. The peer
          // change in auth/index.ts:remove wipes any pre-existing spill
          // on consent revocation; this gate prevents fresh accumulation
          // before a sign-in or after a revoke.
          //
          // Auth read should never error in practice (file is
          // read-locked, pure JSON parse). If it does, treat it the same
          // as "no key" — fail-closed for the privacy property.
          const info = yield* auth
            .get(GpdLogHttp.GPD_PROVIDER_ID)
            .pipe(Effect.orElseSucceed(() => undefined))
          if (!info || info.type !== "api") return
          const s = yield* InstanceState.get(state)
          const k = coalesceKey(evt)
          const existing = s.queue.get(sessionID)
          if (existing) {
            existing.set(k, evt)
            return
          }
          const m = new Map<string, QueuedEvent>()
          m.set(k, evt)
          s.queue.set(sessionID, m)
          yield* flush(sessionID).pipe(
            Effect.delay(1000),
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("gpd-logger flush failed", { sessionID, cause })),
            ),
            Effect.forkIn(s.scope),
          )
        })
      }

      // `signal` (optional): threaded into GpdLogHttp.post for drain calls,
      // so an aborted POST hits the writer's existing network-catch branch
      // and spills the body to disk for next-boot replay. Normal
      // debounced-enqueue flushes pass undefined.
      const flush = Effect.fn("GpdLogger.flush")(function* (sessionID: SessionID, signal?: AbortSignal) {
        if (!enabled) return
        const s = yield* InstanceState.get(state)
        const queued = s.queue.get(sessionID)
        if (!queued) return
        s.queue.delete(sessionID)

        const root = yield* resolveRoot(sessions, s.rootCache, sessionID)

        // Pull session info once per flush for parent/init data.
        const sessionInfo = yield* sessions
          .get(sessionID)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined as Session.Info | undefined)))
        const parentSessionID = (sessionInfo?.parentID ?? null) as SessionID | null

        const events = materialise(
          sessionID,
          root,
          parentSessionID,
          sessionInfo,
          Array.from(queued.values()),
          s.initialized,
        )
        if (events.length === 0) return

        // Primary sink: POST gzipped NDJSON to LiteLLM's /gpd/log. On
        // failure the http-writer spills the request body to disk and the
        // background replayer retries it.
        yield* Effect.promise(() =>
          GpdLogHttp.post(auth, { sessionID, rootSessionID: root, events }, { signal }),
        )

        // Optional: mirror to local JSONL for dev ergonomics (off by default).
        if (localMirror) {
          yield* Effect.promise(() => GpdLogWriter.append(root, events)).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.warn("local mirror write failed", { cause })),
            ),
          )
        }
      })

      /**
       * Resolve the wall-clock budget for drain. `OPENCODE_GPD_SHUTDOWN_TIMEOUT_MS`
       * override, falls back to `DEFAULT_SHUTDOWN_BUDGET_MS`.
       */
      function resolveBudgetMs(): number {
        const raw = process.env["OPENCODE_GPD_SHUTDOWN_TIMEOUT_MS"]
        if (!raw) return DEFAULT_SHUTDOWN_BUDGET_MS
        const n = parseInt(raw, 10)
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHUTDOWN_BUDGET_MS
      }

      /**
       * Drain implementation that operates on an explicit State reference
       * and posts directly through GpdLogHttp (as a plain Promise) rather
       * than going through the `flush()` Effect.
       *
       * Rationale: `flush()` calls `InstanceState.get(state)`, `sessions.get`,
       * and `sessions.root` — all of which require active Instance context.
       * At Scope finalization (process exit) there is no Instance in
       * context, so an Effect-based drain would fail. This variant reads
       * from `cache` (captured in the init closure at layer-build time,
       * doesn't move) and from `auth` (Auth.Service handle from outer
       * closure, doesn't require Instance).
       *
       * Trade-off: `session_init` events can only be emitted for sessions
       * already in `cache.initialized` — we don't have a way to fetch
       * `sessionInfo` without Instance. Uninitialized-session drains skip
       * the session_init line; materialise() handles that gracefully
       * (see the `if (!initialized.has(sessionID) && sessionInfo)` guard).
       * This matches today's silent-drop behavior for those events, but
       * any non-init events (message/part/diff/deleted) still land.
       *
       * Contract:
       *   - Idempotent: `draining` latch prevents double-runs.
       *   - Bounded: AbortController aborts in-flight fetches after
       *     `budgetMs`. The writer's network-catch branch spills on
       *     AbortError, so nothing leaks past the deadline.
       *   - Atomic per-session: each queued Map is consumed (deleted)
       *     before the POST. Partial completion leaves the queue empty —
       *     uncovered work is on disk for next-boot replay.
       */
      const drainState = (cache: State): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          if (!enabled) return
          if (cache.draining) return
          cache.draining = true

          const ids = Array.from(cache.queue.keys())
          if (ids.length === 0) return

          const budgetMs = resolveBudgetMs()

          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), budgetMs)
          if (typeof (timer as any).unref === "function") (timer as any).unref()

          // Materialise each session's payload synchronously. Done up
          // front so the queue is empty before any POST races with a
          // concurrent enqueue (no possible one anyway — we're single-threaded).
          type Payload = { sessionID: SessionID; rootSessionID: SessionID; events: GpdLog.Event[] }
          const payloads: Payload[] = []
          for (const [sessionID, queued] of cache.queue) {
            // Best-effort root: use cached value if present, otherwise
            // treat this session as its own root. A misattributed root
            // during shutdown drain is acceptable — it's recoverable
            // from raw GCS by the compactor.
            const root = cache.rootCache.get(sessionID) ?? sessionID
            const events = materialise(
              sessionID,
              root,
              null,
              undefined,
              Array.from(queued.values()),
              cache.initialized,
            )
            if (events.length > 0) {
              payloads.push({ sessionID, rootSessionID: root, events })
            }
          }
          cache.queue.clear()

          if (payloads.length === 0) {
            clearTimeout(timer)
            return
          }

          log.info("drainPending started", { sessions: payloads.length, budgetMs })

          // Fire POSTs with bounded concurrency. Each GpdLogHttp.post
          // self-spills on network / AbortError via its own catch branch
          // at http-writer.ts:85-89 — no double-spill from drain.
          yield* Effect.promise(async () => {
            let cursor = 0
            const worker = async () => {
              while (cursor < payloads.length) {
                const i = cursor++
                const p = payloads[i]
                await GpdLogHttp.post(auth, p, { signal: ctrl.signal }).catch((err) => {
                  log.warn("drainPending post failed", { sessionID: p.sessionID, err: String(err) })
                })
              }
            }
            const workers = Array.from(
              { length: Math.min(DRAIN_CONCURRENCY, payloads.length) },
              () => worker(),
            )
            await Promise.allSettled(workers)
          })

          clearTimeout(timer)
          log.info("drainPending finished")
        })

      /**
       * Interface-level drain. Resolves state via `InstanceState.get` and
       * delegates to `drainState`. Call through
       * `Service.use(svc => svc.drainPending())` from a context that has
       * Instance provided (e.g. inside an active command execution).
       */
      const drainPending: Interface["drainPending"] = () =>
        Effect.gen(function* () {
          if (!enabled) return
          const s = yield* InstanceState.get(state)
          yield* drainState(s)
        })

      const state: InstanceState<State> = yield* InstanceState.make<State>(
        Effect.fn("GpdLogger.state")(function* (_ctx) {
          const cache: State = {
            queue: new Map(),
            rootCache: new Map(),
            initialized: new Set(),
            lastEmittedDiff: new Map(),
            scope: yield* Scope.make(),
            draining: false,
          }

          yield* Effect.addFinalizer(() =>
            // Drain pending events BEFORE closing the scope. The scope close
            // cancels in-flight forked flush fibers; without draining first
            // the last 1s debounce window is silently dropped. Uses
            // drainState with `cache` from closure — drainPending requires
            // Instance context which is unavailable at finalizer time.
            drainState(cache).pipe(
              Effect.andThen(Scope.close(cache.scope, Exit.void)),
              Effect.andThen(
                Effect.sync(() => {
                  cache.queue.clear()
                  cache.rootCache.clear()
                  cache.initialized.clear()
                }),
              ),
            ),
          )

          if (!enabled) return cache

          const watch = <D extends { type: string }>(
            def: D,
            fn: (evt: { properties: any }) => Effect.Effect<void, unknown>,
          ) =>
            bus.subscribe(def as never).pipe(
              Stream.runForEach((evt) =>
                fn(evt).pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => log.error("gpd-logger subscriber failed", { type: def.type, cause })),
                  ),
                ),
              ),
              Effect.forkScoped,
            )

          yield* watch(Session.Event.Updated, (evt) =>
            Effect.gen(function* () {
              const info = yield* sessions.get(evt.properties.sessionID)
              yield* enqueue(info.id, { kind: "session", sessionID: info.id, info })
            }),
          )
          yield* watch(MessageV2.Event.Updated, (evt) =>
            enqueue(evt.properties.info.sessionID, {
              kind: "message",
              sessionID: evt.properties.info.sessionID,
              info: evt.properties.info,
            }),
          )
          yield* watch(MessageV2.Event.PartUpdated, (evt) =>
            enqueue(evt.properties.part.sessionID, {
              kind: "part",
              sessionID: evt.properties.part.sessionID,
              part: evt.properties.part,
            }),
          )
          yield* watch(Session.Event.Diff, (evt) =>
            Effect.gen(function* () {
              const sid = evt.properties.sessionID as SessionID
              const s = yield* InstanceState.get(state)
              // Compute per-file hashes for the new cumulative diff,
              // then enqueue only files whose hash differs from what
              // we have already shipped for this session. This is the
              // single dedup point that turns the O(N²) cumulative
              // bandwidth into O(N) per-file emissions.
              const prev = s.lastEmittedDiff.get(sid) ?? new Map<string, string>()
              const next = new Map<string, string>()
              const cumulative = (evt.properties.diff ?? []) as Snapshot.FileDiff[]
              for (const fd of cumulative) {
                const h = hashFileDiff(fd)
                next.set(fd.file, h)
                if (prev.get(fd.file) === h) continue
                yield* enqueue(sid, { kind: "diff_file", sessionID: sid, file: fd })
              }
              // Replace (don't merge): files dropped from the cumulative
              // diff (e.g. via revert) leave the map so a future
              // re-modification re-emits.
              s.lastEmittedDiff.set(sid, next)
            }),
          )
          yield* watch(Session.Event.Deleted, (evt) =>
            Effect.gen(function* () {
              const sid = evt.properties.sessionID as SessionID
              const s = yield* InstanceState.get(state)
              // Free per-session diff bookkeeping. Without this, a
              // long-running sidecar accumulates an entry per dead
              // session forever.
              s.lastEmittedDiff.delete(sid)
              yield* enqueue(sid, {
                kind: "deleted",
                sessionID: sid,
              })
            }),
          )

          return cache
        }),
      )

      const replayTick = Effect.gen(function* () {
        const result: { posted: number; remaining: number } = yield* Effect.promise(() =>
          GpdLogHttp.replay(auth).catch(() => ({ posted: 0, remaining: 0 })),
        )
        if (result.posted > 0) log.info("replay drained spill", result)
        // Empty spill → re-check slowly; busy spill → retry sooner.
        const delay = result.remaining === 0 ? "60 seconds" : "30 seconds"
        yield* Effect.sleep(delay)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => log.warn("replay tick errored", { cause })),
        ),
      )

      const init: Interface["init"] = () =>
        Effect.gen(function* () {
          if (!enabled) return
          const s = yield* InstanceState.get(state)
          log.info("initialized", { localMirror })

          // Boot replay + periodic retry loop. Stays on a forked fiber so
          // the init promise resolves immediately.
          yield* Effect.forever(replayTick).pipe(Effect.forkIn(s.scope))
        })

      return Service.of({ init, drainPending })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer
      .pipe(Layer.provide(Auth.defaultLayer))
      .pipe(Layer.provide(Bus.layer))
      .pipe(Layer.provide(Session.defaultLayer)),
  )
}
