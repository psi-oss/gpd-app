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
 * a wrap sorts below everything minted in the 795 days before it.
 *
 * `compare` fixes that by unwrapping each ID onto a window centred on the
 * current time, so IDs from either side of a wrap land in the right order. The
 * window is one full period wide — 397.7 days either side of now — and IDs
 * outside it sort against the rest arbitrarily but *consistently*: the
 * comparison is a real total order, so it is always safe to hand to `sort` or
 * a binary search. (Comparing pairwise ring distance instead would be neither.)
 *
 * Records that carry their own creation timestamp should be ordered on that,
 * since it has no window at all. This comparator is for identifiers whose
 * record has no time field of its own, for keyed lookups that have only the
 * ID, and as a tiebreak.
 */
export namespace Identifier {
  /** Hex characters of encoded time at the start of an ID, after the prefix. */
  const TIME_HEX = 12
  /** Size of the ring the encoded time wraps around: 2^48. */
  const PERIOD = 2 ** (TIME_HEX * 4)
  /** Half the ring — how far either side of now the window reaches. */
  const HALF = PERIOD / 2
  /** Sub-millisecond counter slots reserved in the encoded value. */
  const COUNTER_SPACE = 0x1000

  const HEX = /^[0-9a-f]+$/

  const modulo = (value: number) => ((value % PERIOD) + PERIOD) % PERIOD

  // Start of the window, fixed on first use. Holding it still for the life of
  // the process is what makes `compare` a stable total order — a window that
  // slid while a sort was running could order the same pair two different ways.
  let windowStart: number | undefined
  const origin = () => (windowStart ??= modulo(Date.now() * COUNTER_SPACE - HALF))

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
   * Position of an ID within the current window: 0 at the far edge, rising
   * with creation time. Undefined for IDs that are not time-prefixed.
   */
  function position(id: string): number | undefined {
    const encoded = encodedTime(id)
    if (encoded === undefined) return undefined
    return modulo(encoded - origin())
  }

  /**
   * Compares two identifiers in creation order across a wrap. Ascending IDs
   * (messages, parts) compare oldest first; descending IDs (sessions) compare
   * newest first, which is the order they were designed to sort in. IDs that
   * are not time-prefixed fall back to string order, so this is always a
   * usable comparator.
   */
  export function compare(a: string, b: string): number {
    const left = position(a)
    const right = position(b)
    if (left === undefined || right === undefined) return a < b ? -1 : a > b ? 1 : 0
    if (left !== right) return left < right ? -1 : 1
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
