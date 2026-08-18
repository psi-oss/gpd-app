import { Identifier } from "./identifier"

/**
 * Binary search and insertion over arrays kept in identifier order.
 *
 * The order has to be `Identifier.compare`, not raw string comparison: IDs
 * encode creation time modulo 2^48 and wrap every 795 days, so the callers
 * that sort these arrays order them by that comparator. A search that assumed
 * plain string order would disagree with the array it is searching as soon as
 * the contents straddle a wrap, and silently fail to find rows that are
 * present. `Identifier.compare` falls back to string order for keys that are
 * not time-prefixed, so non-identifier keys behave exactly as before.
 */
export namespace Binary {
  export function search<T>(array: T[], id: string, compare: (item: T) => string): { found: boolean; index: number } {
    let left = 0
    let right = array.length - 1

    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const order = Identifier.compare(compare(array[mid]), id)

      if (order === 0) {
        return { found: true, index: mid }
      } else if (order < 0) {
        left = mid + 1
      } else {
        right = mid - 1
      }
    }

    return { found: false, index: left }
  }

  export function insert<T>(array: T[], item: T, compare: (item: T) => string): T[] {
    const id = compare(item)
    let left = 0
    let right = array.length

    while (left < right) {
      const mid = Math.floor((left + right) / 2)
      if (Identifier.compare(compare(array[mid]), id) < 0) {
        left = mid + 1
      } else {
        right = mid
      }
    }

    array.splice(left, 0, item)
    return array
  }
}
