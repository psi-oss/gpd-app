import path from "path"
import lockfile from "proper-lockfile"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { zod } from "@/util/effect-zod"
import { Global } from "../global"
import { AppFileSystem } from "../filesystem"
import { GpdLogSpill } from "../sink/spill"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new Auth.AuthError({ message, cause })

export namespace Auth {
  export class Oauth extends Schema.Class<Oauth>("OAuth")({
    type: Schema.Literal("oauth"),
    refresh: Schema.String,
    access: Schema.String,
    expires: Schema.Number,
    accountId: Schema.optional(Schema.String),
    enterpriseUrl: Schema.optional(Schema.String),
  }) {}

  export class Api extends Schema.Class<Api>("ApiAuth")({
    type: Schema.Literal("api"),
    key: Schema.String,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }) {}

  export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
    type: Schema.Literal("wellknown"),
    key: Schema.String,
    token: Schema.String,
  }) {}

  const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
  export const Info = Object.assign(_Info, { zod: zod(_Info) })
  export type Info = Schema.Schema.Type<typeof _Info>

  export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }) {}

  export interface Interface {
    readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
    readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
    readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
    readonly remove: (key: string) => Effect.Effect<void, AuthError>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fsys = yield* AppFileSystem.Service
      const decode = Schema.decodeUnknownOption(Info)

      // Shared cross-process advisory lock for every read-modify-write on
      // auth.json. Without it, two writers that race (desktop + CLI,
      // desktop + second window, etc.) each call all() before the other's
      // rename lands, then each overwrite with their stale view → one
      // writer's provider key silently disappears. proper-lockfile
      // creates a sibling `.lock` directory with PID + heartbeat so a
      // kill -9 holder's lock auto-releases within ~10s. Advisory only:
      // other processes must also call acquireLock to participate, which
      // is why the Rust side (removeGpdKey in src-tauri/src/lib.rs) and
      // the uninstall scripts have to take the same lock.
      //
      // Locks the TARGET file (not a sibling sentinel) so a missing
      // file is handled: proper-lockfile auto-creates .<name>.lock
      // alongside it and creates the target via realpath if needed.
      const withAuthLock = <A, E, R>(
        span: string,
        body: () => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | AuthError, R> =>
        Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () =>
              lockfile.lock(file, {
                realpath: false, // file may not exist yet on first-run
                retries: { retries: 20, minTimeout: 50, maxTimeout: 500 },
                stale: 10_000,
              }),
            catch: (cause) => new AuthError({ message: `Auth.${span}: could not acquire auth.json lock`, cause }),
          }),
          () => body(),
          (release) => Effect.promise(() => release().catch(() => undefined)),
        )

      const all = Effect.fn("Auth.all")(function* () {
        // Read path intentionally unlocked — atomic rename from a writer
        // means readers either see the OLD file or the NEW one, never a
        // torn mix. Locking the read would serialise all auth refreshes
        // behind writes for no safety benefit.
        const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
        return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
      })

      const get = Effect.fn("Auth.get")(function* (providerID: string) {
        return (yield* all())[providerID]
      })

      const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
        const norm = key.replace(/\/+$/, "")
        yield* withAuthLock("set", () =>
          Effect.gen(function* () {
            const data = yield* all()
            if (norm !== key) delete data[key]
            delete data[norm + "/"]
            yield* fsys
              .writeJsonAtomic(file, { ...data, [norm]: info }, 0o600)
              .pipe(Effect.mapError(fail("Failed to write auth data")))
          }),
        )
      })

      const remove = Effect.fn("Auth.remove")(function* (key: string) {
        const norm = key.replace(/\/+$/, "")
        yield* withAuthLock("remove", () =>
          Effect.gen(function* () {
            const data = yield* all()
            delete data[key]
            delete data[norm]
            yield* fsys.writeJsonAtomic(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
            // Wipe queued GPD telemetry on consent revocation. Without
            // this, any spill files written between the revocation and
            // the user's next sign-in would replay to the proxy as soon
            // as a fresh key landed in auth.json — i.e. events captured
            // under withdrawn consent would still ship. The peer change
            // in sink/gpd-logger.ts:enqueue prevents new spill, this
            // closes the window for already-queued items.
            //
            // Best-effort: a filesystem failure here must not block the
            // revoke (the on-disk auth.json delete already succeeded
            // above, which is the contractual outcome the caller asked
            // for). The wipe itself is also written to log loudly on
            // unexpected error inside spill.ts.
            if (key === "gpd" || norm === "gpd") {
              yield* Effect.promise(() => GpdLogSpill.wipe()).pipe(
                Effect.orElseSucceed(() => undefined),
              )
            }
          }),
        )
      })

      return Service.of({ get, all, set, remove })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))
}
