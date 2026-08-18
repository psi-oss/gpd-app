/**
 * Ordering for the time-prefixed identifiers minted by `Identifier.create`
 * (see `packages/opencode/src/id/id.ts` and `packages/app/src/utils/id.ts`).
 *
 * An ID carries its creation time in the 12 hex characters after the prefix,
 * encoded as `(milliseconds * 0x1000 + counter) mod 2^48`. The modulus is not
 * decoration: a current epoch-millisecond timestamp times 0x1000 needs 53
 * bits, so the value genuinely wraps, once every 2^36 milliseconds — 795.4
 * days. The last wrap was 2026-08-14T11:19:55Z, the next is
 * 2028-10-17T20:04:31Z.
 *
 * That makes plain string comparison of two IDs wrong: everything minted after
 * a wrap sorts below everything minted in the 795 days before it. Comparing
 * with wrap-around arithmetic (nearest distance around the ring, the same
 * trick TCP uses for sequence numbers) restores the intended order for any two
 * IDs created less than half a period — 397.7 days — apart.
 *
 * Records that carry their own creation timestamp should be ordered on that
 * instead; it has no such bound. This comparator is for identifiers whose
 * record has no time field of its own, and as a tiebreak.
 */
export namespace Identifier {
  /** Hex characters of encoded time at the start of an ID, after the prefix. */
  const TIME_HEX = 12
  /** Size of the ring the encoded time wraps around: 2^48. */
  const PERIOD = 2 ** (TIME_HEX * 4)
  /** Half the ring. Distances beyond this are read as going the other way. */
  const HALF = PERIOD / 2

  const HEX = /^[0-9a-f]+$/

  /**
   * The encoded time of an ID, or undefined if it is not in the expected
   * `prefix_<12 hex><random>` shape. Values are below 2^48, so they stay exact
   * as doubles.
   */
  export function encodedTime(id: string): number | undefined {
    const separator = id.indexOf("_")
    if (separator === -1) return undefined
    const hex = id.slice(separator + 1, separator + 1 + TIME_HEX)
    if (hex.length !== TIME_HEX || !HEX.test(hex)) return undefined
    return parseInt(hex, 16)
  }

  /**
   * Compares two identifiers in creation order, tolerating the wrap described
   * above. Ascending IDs (messages, parts) compare oldest first; descending
   * IDs (sessions) compare newest first, which is the order they were designed
   * to sort in. IDs that are not time-prefixed fall back to string order so
   * this is always a usable comparator.
   */
  export function compare(a: string, b: string): number {
    const left = encodedTime(a)
    const right = encodedTime(b)
    if (left === undefined || right === undefined) return a < b ? -1 : a > b ? 1 : 0
    const distance = ((((left - right + HALF) % PERIOD) + PERIOD) % PERIOD) - HALF
    if (distance < 0) return -1
    if (distance > 0) return 1
    // Same millisecond and same counter: two processes minted concurrently.
    // Fall back to the random suffix so the order is at least stable.
    return a < b ? -1 : a > b ? 1 : 0
  }

  /** True when `a` was created before `b`. */
  export function isBefore(a: string, b: string): boolean {
    return compare(a, b) < 0
  }

  /** True when `a` was created after `b`. */
  export function isAfter(a: string, b: string): boolean {
    return compare(a, b) > 0
  }
}
