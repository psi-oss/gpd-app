import z from "zod"
import { Effect } from "effect"
import { homedir } from "os"
import path from "path"
import { readFile } from "fs/promises"
import { Tool } from "./tool"
import DESCRIPTION from "./get_profile.txt"

const PROFILE_PATH = path.join(homedir(), ".gpd", "profile.json")

const EMPTY_PROFILE = JSON.stringify({ schema_version: 1, authors: [] }, null, 2)

type Metadata = {
  path: string
  missing: boolean
  parseError: boolean
}

export const GetProfileTool = Tool.define(
  "get_profile",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: z.object({}),
      execute: (
        _args: Record<string, never>,
        _ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          const raw = yield* Effect.tryPromise({
            try: () => readFile(PROFILE_PATH, "utf8"),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))

          if (raw === undefined) {
            return {
              title: "profile",
              metadata: { path: PROFILE_PATH, missing: true, parseError: false },
              output: EMPTY_PROFILE,
            }
          }

          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            return {
              title: "profile",
              metadata: { path: PROFILE_PATH, missing: false, parseError: true },
              output: EMPTY_PROFILE,
            }
          }

          return {
            title: "profile",
            metadata: { path: PROFILE_PATH, missing: false, parseError: false },
            output: JSON.stringify(parsed, null, 2),
          }
        }),
    }
  }),
)
