import type {
  Agent,
  Config,
  OpencodeClient,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  QuestionRequest,
  Session,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"
import { retry } from "@opencode-ai/util/retry"
import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import { cmp, normalizeAgentList, normalizeProviderList } from "./utils"
import { formatServerError } from "@/utils/server-errors"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: Todo[]
  }
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

/**
 * Resolve once the browser has (probably) painted the current frame, so
 * that deferred work started afterwards doesn't steal the main thread
 * during initial render.
 *
 * The naive implementation is `requestAnimationFrame(() => setTimeout(resolve, 0))`,
 * but rAF is suspended while the document is hidden / occluded / in a
 * background tab. Relying on it alone means `bootstrapGlobal()` — which
 * gates `setGlobalStore("ready", true)` on this promise — can hang
 * indefinitely when the app is launched into a non-visible window
 * (CLI-provisioned auth never gets discovered, welcome/loading UI sticks).
 *
 * Strategy:
 *   1. If the document is not `visible`, resolve via microtask. No paint
 *      is coming; there's nothing to wait for. Bootstrap proceeds and
 *      the UI catches up when the user brings the window forward.
 *   2. Otherwise, race the rAF+setTimeout(0) path against a 500 ms
 *      ceiling so a tab that gets backgrounded mid-bootstrap (or a
 *      browser that silently drops rAF) still completes.
 */
export function waitForPaint() {
  return new Promise<void>((resolve) => {
    // SSR / non-browser — yield once and return.
    if (typeof requestAnimationFrame !== "function") {
      Promise.resolve().then(() => resolve())
      return
    }

    // Hidden tab / backgrounded Tauri window: rAF may never fire. Don't
    // gate bootstrap on a paint that isn't coming. A microtask is
    // enough to let the current synchronous work flush.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      Promise.resolve().then(() => resolve())
      return
    }

    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }

    // Ultimate safety net. If rAF is dropped or suspended between the
    // visibility check above and the callback firing (the browser can
    // minimize the window here), release bootstrap after 500 ms.
    const timer = setTimeout(finish, 500)
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

const providerRev = new Map<string, number>()

export function clearProviderRev(directory: string) {
  providerRev.delete(directory)
}

type BootstrapTask = {
  name: string
  run: () => Promise<unknown>
}

type BootstrapFailureRecord = {
  stage: string
  directory?: string
  task?: string
  message: string
  stack?: string
  causeMessage?: string
  causeStack?: string
  time: number
}

class BootstrapTaskError extends Error {
  readonly task: string
  readonly cause: unknown

  constructor(task: string, cause: unknown) {
    super(`${task}: ${errorMessage(cause)}`)
    this.name = "BootstrapTaskError"
    this.task = task
    this.cause = cause
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function stackOf(error: unknown) {
  return error instanceof Error ? error.stack : undefined
}

function taskName(error: unknown) {
  return error instanceof BootstrapTaskError ? error.task : undefined
}

function taskCause(error: unknown) {
  return error instanceof BootstrapTaskError ? error.cause : undefined
}

function recordBootstrapFailure(stage: string, directory: string | undefined, error: unknown) {
  const cause = taskCause(error)
  const record: BootstrapFailureRecord = {
    stage,
    directory,
    task: taskName(error),
    message: errorMessage(error),
    stack: stackOf(error),
    causeMessage: cause === undefined ? undefined : errorMessage(cause),
    causeStack: stackOf(cause),
    time: Date.now(),
  }

  console.error("[gpd] bootstrap failure", record, error)

  if (!import.meta.env.DEV || typeof window === "undefined") return
  const target = window as typeof window & { __gpdBootstrapFailures?: BootstrapFailureRecord[] }
  const failures = target.__gpdBootstrapFailures ?? []
  failures.push(record)
  target.__gpdBootstrapFailures = failures.slice(-50)
}

function task(name: string, run: () => Promise<unknown>): BootstrapTask {
  return { name, run }
}

function runAll(list: BootstrapTask[]) {
  return Promise.allSettled(
    list.map((item) =>
      item.run().catch((err) => {
        throw new BootstrapTaskError(item.name, err)
      }),
    ),
  )
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export async function bootstrapGlobal(input: {
  globalSDK: OpencodeClient
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
}) {
  const fast = [
    task("global.config.get", () =>
      retry(() =>
        input.globalSDK.global.config.get().then((x) => {
          input.setGlobalStore("config", x.data!)
        }),
      ),
    ),
    task("global.provider.list", () =>
      retry(() =>
        input.globalSDK.provider.list().then((x) => {
          input.setGlobalStore("provider", normalizeProviderList(x.data!))
        }),
      ),
    ),
  ]

  const slow = [
    task("global.path.get", () =>
      retry(() =>
        input.globalSDK.path.get().then((x) => {
          input.setGlobalStore("path", x.data!)
        }),
      ),
    ),
    task("global.project.list", () =>
      retry(() =>
        input.globalSDK.project.list().then((x) => {
          const projects = (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
          input.setGlobalStore("project", projects)
        }),
      ),
    ),
  ]
  await runAll(fast)
  // showErrors({
  //   errors: errors(await runAll(fast)),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
  await waitForPaint()
  await runAll(slow)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
  input.setGlobalStore("ready", true)
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => cmp(item.id, session.id) >= 0)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  sdk: OpencodeClient
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.sdk.session.get({ sessionID })).then((x) => {
        const session = x.data
        if (!session?.id) return
        mergeSession(input.setStore, session)
      }),
    ),
  ).then(() => undefined)
}

function agentKey(agent: Agent) {
  return [
    agent.name,
    agent.description ?? "",
    agent.mode,
    agent.native ? "1" : "0",
    agent.hidden ? "1" : "0",
    agent.color ?? "",
    agent.model?.providerID ?? "",
    agent.model?.modelID ?? "",
    agent.variant ?? "",
  ].join("\u0000")
}

function sameAgents(a: Agent[], b: Agent[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (agentKey(a[i]!) !== agentKey(b[i]!)) return false
  }
  return true
}

function setAgents(input: { store: Store<State>; setStore: SetStoreFunction<State> }, agents: Agent[]) {
  if (sameAgents(input.store.agent, agents)) return
  input.setStore("agent", agents)
}

async function loadAgents(input: { sdk: OpencodeClient; store: Store<State>; setStore: SetStoreFunction<State> }) {
  const response = await input.sdk.app.agents().catch((err) => {
    throw new Error(`fetch agents: ${errorMessage(err)}`, { cause: err })
  })
  const agents = (() => {
    try {
      return normalizeAgentList(response.data)
    } catch (err) {
      throw new Error(`normalize agents: ${errorMessage(err)}`, { cause: err })
    }
  })()
  try {
    setAgents(input, agents)
  } catch (err) {
    if (sameAgents(input.store.agent, agents)) {
      console.warn("[gpd] agent metadata stored after subscriber cleanup error", err)
      return
    }
    throw new Error(`store agents: ${errorMessage(err)}`, { cause: err })
  }
}

export async function bootstrapDirectory(input: {
  directory: string
  sdk: OpencodeClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: ProviderListResponse
  }
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (input.store.provider.all.length === 0 && input.global.provider.all.length > 0) {
    input.setStore("provider", input.global.provider)
  }
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", input.global.config)
  }
  // Mark provider ready immediately if we already have providers (seeded from global or prior load).
  // Only reset to false when there are genuinely no providers available yet.
  if (input.store.provider.all.length > 0) {
    input.setStore("provider_ready", true)
  } else if (loading) {
    input.setStore("provider_ready", false)
  }
  input.setStore("mcp_ready", false)
  input.setStore("mcp", {})
  input.setStore("lsp_ready", false)
  input.setStore("lsp", [])
  if (loading) input.setStore("status", "partial")

  const fast = [
    task("app.agents", () =>
      retry(() => loadAgents(input)),
    ),
    task("config.get", () => retry(() => input.sdk.config.get().then((x) => input.setStore("config", x.data!)))),
    task("session.status", () =>
      retry(() => input.sdk.session.status().then((x) => input.setStore("session_status", x.data!))),
    ),
  ]

  const slow = [
    task("project.current", () =>
      seededProject
        ? Promise.resolve()
        : retry(() => input.sdk.project.current()).then((x) => input.setStore("project", x.data!.id)),
    ),
    task("path.get", () =>
      seededPath
        ? Promise.resolve()
        : retry(() =>
            input.sdk.path.get().then((x) => {
              input.setStore("path", x.data!)
              const next = projectID(x.data?.directory ?? input.directory, input.global.project)
              if (next) input.setStore("project", next)
            }),
          ),
    ),
    task("vcs.get", () =>
      retry(() =>
        input.sdk.vcs.get().then((x) => {
          const next = x.data ?? input.store.vcs
          input.setStore("vcs", next)
          if (next) input.vcsCache.setStore("value", next)
        }),
      ),
    ),
    task("command.list", () =>
      retry(() => input.sdk.command.list().then((x) => input.setStore("command", x.data ?? []))),
    ),
    task("permission.list", () =>
      retry(() =>
        input.sdk.permission.list().then((x) => {
          const ids = (x.data ?? []).map((perm) => perm?.sessionID).filter((id): id is string => !!id)
          const grouped = groupBySession(
            (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
          )
          return warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk }).then(() =>
            batch(() => {
              for (const sessionID of Object.keys(input.store.permission)) {
                if (grouped[sessionID]) continue
                input.setStore("permission", sessionID, [])
              }
              for (const [sessionID, permissions] of Object.entries(grouped)) {
                input.setStore(
                  "permission",
                  sessionID,
                  reconcile(
                    permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  ),
                )
              }
            }),
          )
        }),
      ),
    ),
    task("question.list", () =>
      retry(() =>
        input.sdk.question.list().then((x) => {
          const ids = (x.data ?? []).map((question) => question?.sessionID).filter((id): id is string => !!id)
          const grouped = groupBySession((x.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID))
          return warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk }).then(() =>
            batch(() => {
              for (const sessionID of Object.keys(input.store.question)) {
                if (grouped[sessionID]) continue
                input.setStore("question", sessionID, [])
              }
              for (const [sessionID, questions] of Object.entries(grouped)) {
                input.setStore(
                  "question",
                  sessionID,
                  reconcile(
                    questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  ),
                )
              }
            }),
          )
        }),
      ),
    ),
    task("session.list", () => Promise.resolve(input.loadSessions(input.directory))),
    task("mcp.status", () =>
      retry(() =>
        input.sdk.mcp.status().then((x) => {
          const status = x.data!
          input.setStore("mcp", status)
          // REQUIRED servers must be connected for core GPD workflows.
          // OPTIONAL servers provide graceful degradation — their failure does not block chat.
          const required = ["gpd-state", "gpd-skills", "gpd-verification", "gpd-conventions"]
          const optional = ["gpd-protocols", "gpd-errors", "gpd-patterns", "gpd-arxiv"]
          // Server schema uses `status` field (see packages/opencode/src/mcp/index.ts
          // `MCPStatus` discriminated union). Reading `state` was silently always
          // undefined, producing false "not connected" warnings on every boot.
          const mcpStatus = status as Record<string, { status?: string }>
          const requiredReady = required.every(
            (name) => !(name in mcpStatus) || mcpStatus[name]?.status === "connected",
          )
          input.setStore("mcp_ready", requiredReady)
          // Log optional server failures without blocking.
          for (const name of optional) {
            const s = mcpStatus[name]
            if (s && s.status !== "connected") {
              console.warn(`Optional MCP server "${name}" not connected (status: ${s.status}); proceeding without it`)
            }
          }
        }),
      ),
    ),
  ]

  const errs = errors(await runAll(fast))
  if (errs.length > 0) {
    for (const err of errs) {
      recordBootstrapFailure("directory.fast", input.directory, err)
    }
    const project = getFilename(input.directory)
    showToast({
      variant: "error",
      title: input.translate("toast.project.reloadFailed.title", { project }),
      description: formatServerError(errs[0], input.translate),
    })
  }

  await waitForPaint()
  const slowErrs = errors(await runAll(slow))
  if (slowErrs.length > 0) {
    for (const err of slowErrs) {
      recordBootstrapFailure("directory.slow", input.directory, err)
    }
    const project = getFilename(input.directory)
    showToast({
      variant: "error",
      title: input.translate("toast.project.reloadFailed.title", { project }),
      description: formatServerError(slowErrs[0], input.translate),
    })
  }

  if (loading && errs.length === 0 && slowErrs.length === 0) input.setStore("status", "complete")

  const rev = (providerRev.get(input.directory) ?? 0) + 1
  providerRev.set(input.directory, rev)
  void retry(() => input.sdk.provider.list())
    .then((x) => {
      if (providerRev.get(input.directory) !== rev) return
      input.setStore("provider", normalizeProviderList(x.data!))
      input.setStore("provider_ready", true)
    })
    .catch((err) => {
      if (providerRev.get(input.directory) !== rev) return
      recordBootstrapFailure("directory.provider", input.directory, err)
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(err, input.translate),
      })
    })
}
