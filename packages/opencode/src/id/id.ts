import z from "zod"
import { randomBytes } from "crypto"
import { Identifier as Ordering } from "@opencode-ai/util/identifier"

export namespace Identifier {
  /**
   * Order two IDs by creation time. IDs encode their timestamp modulo 2^48 and
   * therefore wrap every 795 days, so never compare them as plain strings —
   * see `@opencode-ai/util/identifier` for the details and the bound.
   */
  export const compare = Ordering.compare
  export const isBefore = Ordering.isBefore
  export const isAfter = Ordering.isAfter

  const prefixes = {
    event: "evt",
    session: "ses",
    message: "msg",
    permission: "per",
    question: "que",
    user: "usr",
    part: "prt",
    goal: "goal",
    pty: "pty",
    tool: "tool",
    workspace: "wrk",
    entry: "ent",
  } as const

  export function schema(prefix: keyof typeof prefixes) {
    return z.string().startsWith(prefixes[prefix])
  }

  const LENGTH = 26

  // State for monotonic ID generation
  let lastTimestamp = 0
  let counter = 0

  export function ascending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, "ascending", given)
  }

  export function descending(prefix: keyof typeof prefixes, given?: string) {
    return generateID(prefix, "descending", given)
  }

  function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
    if (!given) {
      return create(prefixes[prefix], direction)
    }

    if (!given.startsWith(prefixes[prefix])) {
      throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
    }
    return given
  }

  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let result = ""
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  /**
   * Mints an ID whose first 12 hex characters encode
   * `(timestamp * 0x1000 + counter) mod 2^48`. The value does not fit in 48
   * bits, so it wraps every 795 days. `Identifier.compare` handles that; plain
   * string comparison does not. Do not widen the field to dodge the wrap — the
   * client mints IDs with the same layout (`packages/app/src/utils/id.ts`) and
   * the two must agree byte for byte.
   */
  export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    now = direction === "descending" ? ~now : now

    const timeBytes = Buffer.alloc(6)
    for (let i = 0; i < 6; i++) {
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
  }
}
