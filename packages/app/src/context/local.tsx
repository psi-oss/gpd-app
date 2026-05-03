import { createSimpleContext } from "@opencode-ai/ui/context"
import { base64Encode } from "@opencode-ai/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

type Saved = {
  project?: State
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()
let lastProjectSelection: State | undefined

const handoffKey = (dir: string, id: string) => `${dir}\n${id}`

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

const stateFrom = (value: unknown): State | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as State
}

export const migrateModelSelection = (value: unknown): Saved => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    project?: State
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") {
    return {
      project: stateFrom(item.project),
      session: item.session,
    }
  }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    project: stateFrom(item.pick[WORKSPACE_KEY]),
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return undefined
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

export const shouldPersistProjectModelSelection = (next: Partial<State>) =>
  hasOwn(next, "model") || hasOwn(next, "variant")

export const applyProjectModelSelection = (current: State | undefined, next: Partial<State>): State | undefined => {
  const result: State = clone(current) ?? {}
  if (hasOwn(next, "model")) {
    if (next.model) result.model = { ...next.model }
    else delete result.model
  }
  if (hasOwn(next, "variant")) result.variant = next.variant ?? null
  if (!result.model) return undefined
  return result
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useSDK()
    const sync = useSync()
    const providers = useProviders()
    const models = useModels()

    const id = createMemo(() => params.id || undefined)
    const list = createMemo(() => sync.data.agent.filter((item) => item.mode !== "subagent" && !item.hidden))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved, , savedReady] = persisted(
      {
        ...Persist.workspace(sdk.directory, "model-selection", ["model-selection.v1"]),
        migrate: migrateModelSelection,
      },
      createStore<Saved>({
        project: undefined,
        session: {},
      }),
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
    })

    const validModel = (model: ModelKey) => {
      const provider = providers.all().find((item) => item.id === model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }

    const pickAgent = (name: string | undefined) => {
      const items = list()
      if (items.length === 0) return undefined
      return items.find((item) => item.name === name) ?? items[0]
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft
      return saved.session[session] ?? handoff.get(handoffKey(sdk.directory, session))
    })

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(sdk.directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
    })

    const configuredModel = () => {
      if (!sync.data.config.model) return
      const [providerID, modelID] = sync.data.config.model.split("/")
      const model = { providerID, modelID }
      if (validModel(model)) return model
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    const defaultModel = () => {
      const defaults = providers.default()
      for (const provider of providers.connected()) {
        const configured = defaults[provider.id]
        if (configured) {
          const model = { providerID: provider.id, modelID: configured }
          if (validModel(model)) return model
        }

        const first = Object.values(provider.models)[0]
        if (!first) continue
        const model = { providerID: provider.id, modelID: first.id }
        if (validModel(model)) return model
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() => configuredModel() ?? recentModel() ?? defaultModel())

    const agent = {
      list,
      current() {
        return pickAgent(scope()?.agent ?? saved.project?.agent ?? store.current)
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          const prev = scope()
          const next = {
            agent: item.name,
            model: item.model ?? prev?.model,
            variant: item.variant ?? prev?.variant,
          } satisfies State
          const session = id()
          if (session) {
            setSaved("session", session, next)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const current = () => {
      const item = firstModel(
        () => scope()?.model,
        () => saved.project?.model,
        () => agent.current()?.model,
        fallback,
      )
      if (!item) return undefined
      return models.find(item)
    }

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return undefined
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = () => scope()?.variant ?? saved.project?.variant

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
      } satisfies State
    }

    const setProjectSelection = (patch: Partial<State>, resolved: State) => {
      if (!shouldPersistProjectModelSelection(patch)) return
      // Initialise the project branch if missing. setSaved("project", obj)
      // (replacing the whole branch) triggers a reactive cascade in the
      // persisted-store wrapper that desynced downstream consumers and
      // forced a full app refresh to recover. Path-based writes
      // (setSaved("project", "model", value)) keep Solid's fine-grained
      // proxy reactivity intact.
      if (!saved.project) {
        const seed: State = {}
        if (hasOwn(patch, "model") && patch.model) seed.model = { ...patch.model }
        else if (hasOwn(patch, "variant") && resolved.model) seed.model = { ...resolved.model }
        if (hasOwn(patch, "variant")) seed.variant = patch.variant ?? null
        if (!seed.model) return
        setSaved("project", seed)
        lastProjectSelection = clone(seed)
        return
      }
      if (hasOwn(patch, "model")) {
        if (patch.model) setSaved("project", "model", { ...patch.model })
        else setSaved("project", "model", undefined)
      }
      if (hasOwn(patch, "variant")) {
        setSaved("project", "variant", patch.variant ?? null)
        if (!saved.project.model && resolved.model) {
          setSaved("project", "model", { ...resolved.model })
        }
      }
      lastProjectSelection = clone(saved.project)
    }

    const write = (next: Partial<State>) => {
      const base = scope() ?? { agent: agent.current()?.name }
      const state = {
        ...base,
        ...next,
        model: next.model ? { ...next.model } : hasOwn(next, "model") ? undefined : base.model,
      } satisfies State

      const session = id()
      // Batch session/draft + project writes so consumers (e.g. firstModel
      // in current()) never see a half-applied state where scope.model is
      // still old but saved.project.model is already new (or vice versa).
      // Without batching, the two setSaved/setStore calls each fire a
      // reactive cascade independently, which made model-switches in a
      // fresh draft only "stick" after a full app reload.
      batch(() => {
        setProjectSelection(next, state)
        if (session) {
          setSaved("session", session, state)
          return
        }
        setStore("draft", state)
      })
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        batch(() => {
          setStore("last", {
            type: "model",
            agent: agent.current()?.name,
            model: item ?? null,
            variant: selected(),
          })
          write({ model: item })
          if (!item) return
          models.setVisibility(item, true)
          if (!options?.recent) return
          models.recent.push(item)
        })
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          return resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          batch(() => {
            const model = current()
            setStore("last", {
              type: "variant",
              agent: agent.current()?.name,
              model: model ? { providerID: model.provider.id, modelID: model.id } : null,
              variant: value ?? null,
            })
            write({ variant: value ?? null })
          })
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk.directory)),
      model,
      agent,
      session: {
        reset() {
          setStore("draft", undefined)
        },
        promote(dir: string, session: string) {
          const next = clone(snapshot())
          if (!next) return

          if (dir === sdk.directory) {
            setSaved("session", session, next)
            setStore("draft", undefined)
            return
          }

          handoff.set(handoffKey(dir, session), next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey }) {
          const session = id()
          if (!session) return
          if (msg.sessionID !== session) return
          if (saved.session[session] !== undefined) return
          if (handoff.has(handoffKey(sdk.directory, session))) return

          setSaved("session", session, {
            agent: msg.agent,
            model: msg.model,
            variant: msg.model.variant ?? null,
          })
        },
      },
    }
    return result
  },
})
