import type { Session } from "@/session"
import type { MessageV2 } from "@/session/message-v2"
import type { Snapshot } from "@/snapshot"

export namespace GpdLog {
  export const SCHEMA_VERSION = 1 as const

  export type Event =
    | SessionInitEvent
    | MessageUpdatedEvent
    | PartUpdatedEvent
    | SessionDiffEvent
    | SessionDiffFileEvent
    | SessionDeletedEvent
    | SessionCloseEvent

  export type SessionInitEvent = {
    kind: "session_init"
    v: typeof SCHEMA_VERSION
    ts: number
    sessionID: string
    parentSessionID: string | null
    rootSessionID: string
    info: Session.Info
  }

  export type MessageUpdatedEvent = {
    kind: "message_updated"
    v: typeof SCHEMA_VERSION
    ts: number
    sessionID: string
    info: MessageV2.Info
  }

  export type PartUpdatedEvent = {
    kind: "part_updated"
    v: typeof SCHEMA_VERSION
    ts: number
    sessionID: string
    part: MessageV2.Part
    /** Placeholder for tool outputs spilled to tool-results/<sha>.txt. */
    spilledBlobSha?: string
  }

  /**
   * Cumulative diff for a session. Kept for back-compat with historical
   * GCS objects (every session before 2026-05-07 emitted this kind). New
   * sessions emit `session_diff_file` instead — see SessionDiffFileEvent.
   *
   * Decoders should branch on `kind`:
   *   - `session_diff`         → cumulative `diff: FileDiff[]`, last-wins per session
   *   - `session_diff_file`    → per-file delta, accumulate by `(sessionID, file)`
   */
  export type SessionDiffEvent = {
    kind: "session_diff"
    v: typeof SCHEMA_VERSION
    ts: number
    sessionID: string
    diff: Snapshot.FileDiff[]
  }

  /**
   * Per-file diff event. Replaces `session_diff` for sessions emitted on
   * or after 2026-05-07. Two reasons:
   *
   * 1. **Row-size cap**. The cumulative form re-serialised every changed
   *    file's full-context patch on every emit. Sergio's overnight
   *    phase-3 run produced 47 single jsonl rows ≥100 MB (largest 129 MB,
   *    949 file entries) which broke BigQuery's `sessions_external` query
   *    (100 MB single-row JSON parser cap). Per-file events cap each row
   *    at one file's patch — bounded by the existing 2 MB file-content
   *    cap at `snapshot/index.ts:36` ⇒ ~5 MB max per row with full
   *    `MAX_SAFE_INTEGER` context, well under BQ's limit.
   *
   * 2. **Quadratic bandwidth**. The cumulative form re-emitted every
   *    previously-changed file on every turn, so an N-message session
   *    that touches N distinct files spent O(N²) bytes on session_diff
   *    alone. Per-file events combined with the sink-level
   *    `lastEmittedDiff` hash filter (gpd-logger.ts) emit each file
   *    exactly once per content change ⇒ O(N) bandwidth.
   *
   * Reconstructing the cumulative diff from per-file events: group by
   * `(sessionID, file.file)`, take the latest `ts` per group. Files
   * absent from any event were never modified in the session.
   *
   * `flushID` groups files emitted in the same flush window (one ULID
   * per flush). `idx` is the 0-based position within that flush; `total`
   * is the file count. Useful for analytics queries that want
   * "files-modified-per-turn" without walking the bus event boundary.
   */
  export type SessionDiffFileEvent = {
    kind: "session_diff_file"
    v: typeof SCHEMA_VERSION
    ts: number
    sessionID: string
    file: Snapshot.FileDiff
    flushID: string
    idx: number
    total: number
  }

  export type SessionDeletedEvent = {
    kind: "session_deleted"
    v: typeof SCHEMA_VERSION
    ts: number
    sessionID: string
  }

  export type SessionCloseEvent = {
    kind: "session_close"
    v: typeof SCHEMA_VERSION
    ts: number
    sessionID: string
    reason: "flush" | "delete" | "shutdown"
  }

  /** Threshold above which tool-part output text is spilled to a side file. */
  export const SPILL_BYTES_THRESHOLD = 32 * 1024
}
