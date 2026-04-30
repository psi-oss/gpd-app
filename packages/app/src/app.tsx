import "@/index.css"

if (typeof window !== "undefined" && !(window as any).__gpdDebugHooked) {
  ;(window as any).__gpdDebugHooked = true
  window.addEventListener("unhandledrejection", (e) => {
    const r: any = e.reason
    // eslint-disable-next-line no-console
    console.error("[gpd-dbg] unhandledrejection name=", r?.name, "msg=", r?.message, "\nFULL STACK:\n", r?.stack, "\ncause=", r?.cause)
  })
  window.addEventListener("error", (e) => {
    // eslint-disable-next-line no-console
    console.error("[gpd-dbg] window.error msg=", e.message, "file=", e.filename, ":", e.lineno, "error.stack=", (e.error as any)?.stack)
  })
}
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { type Duration, Effect } from "effect"
import {
  type Component,
  createMemo,
  createResource,
  createEffect,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { GlobalSDKProvider, useGlobalSDK } from "@/context/global-sdk"
import { GlobalSyncProvider, useGlobalSync } from "@/context/global-sync"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import DirectoryLayout from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { WelcomeScreen } from "./components/welcome-screen"
import {
  CURRENT_TOS_VERSION,
  TOS_ACCEPTED_VERSION_STORAGE_KEY,
} from "./components/tos-content"
import { TosUpgradeGate } from "./components/tos-upgrade-gate"
import { usePlatform } from "./context/platform"
import { useCheckServerHealth } from "./utils/server-health"

const HomeRoute = lazy(() => import("@/pages/home"))
const loadSession = () => import("@/pages/session")
const Session = lazy(loadSession)
const Loading = () => <div class="size-full" />

if (typeof location === "object" && /\/session(?:\/|$)/.test(location.pathname)) {
  void loadSession()
}

const SessionRoute = () => (
  <SessionProviders>
    <Session />
  </SessionProviders>
)

const SessionIndexRoute = () => <Navigate href="session" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient()
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function AppShellProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <HighlightsProvider>
                  <Layout>{props.children}</Layout>
                </HighlightsProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      <Suspense fallback={<Loading />}>
        {props.appChildren}
        {props.children}
      </Suspense>
    </AppShellProviders>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary fallback={(error) => <ErrorPage error={error} />}>
              <QueryProvider>
                <DialogProvider>
                  <MarkedProvider>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </MarkedProvider>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

const effectMinDuration =
  (duration: Duration.Input) =>
  <A, E, R>(e: Effect.Effect<A, E, R>) =>
    Effect.all([e, Effect.sleep(duration)], { concurrency: "unbounded" }).pipe(Effect.map((v) => v[0]))

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )

  return (
    <Show
      when={checkMode() === "blocking" ? !startupHealthCheck.loading : startupHealthCheck.state !== "pending"}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show
        when={startupHealthCheck()}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

function SetupGate(props: ParentProps) {
  const globalSDK = useGlobalSDK()
  // WHY the extra hook: we need to know whether the "gpd" provider
  // already has an auth entry in opencode's auth.json. See the
  // createEffect below for the full story.
  //
  // NOTE: we access globalSync.data.provider.connected directly rather
  // than going through useProviders(). useProviders() calls useParams()
  // under the hood (a SolidJS Router primitive), and SetupGate renders
  // OUTSIDE the <Router> so that primitive throws with
  //   "Error: <A> and 'use' router primitives can be only used inside a Route"
  // This was a regression reported by a user on 2026-04-21 after the
  // SetupGate fix landed (see git blame for context).
  const globalSync = useGlobalSync()

  // ─── API key detection ────────────────────────────────────────────────
  //
  // Previously we decided "does the user have a key?" by checking ONE
  // source: a localStorage flag set the last time the user entered a key
  // in the GUI welcome screen. That flag is *only* set by this component
  // on a successful `handleApiKeySaved`. It's NOT set if the key was
  // already provisioned out-of-band, e.g. by the CLI installer writing
  // directly to opencode's auth.json (`gpd auth login gpd`).
  //
  // Result: users who ran the install script and entered their PSI key
  // there would still be greeted with the welcome screen on first launch,
  // asking for the same key they just entered — a confusing UX that
  // triggered this fix (see user report on 2026-04-20).
  //
  // New behavior:
  //  1. Seed hasKey() from localStorage for the fast path (no flash of
  //     welcome on subsequent launches by a user who already onboarded
  //     via the GUI).
  //  2. Once globalSync reports ready AND the provider list is populated,
  //     check if "gpd" is in providers.connected() (which is derived
  //     from the auth.json file on disk via the server's
  //     `provider.list` endpoint). If so, promote hasKey() to true and
  //     persist the localStorage flag so subsequent launches skip step 2.
  //
  // The brief period between "app mount" and "globalSync.ready === true"
  // is handled by keeping the old localStorage-based seed: on the very
  // first launch after a CLI install the welcome WILL flash briefly until
  // the sync completes, but once it does we skip past it. An alternative
  // would be to show a loading spinner instead of the welcome during this
  // window, but that complicates the render and the flash is <1s in
  // practice. Revisit if it becomes a UX issue.
  //
  // OLD code (kept commented for reference — single-source key detection):
  // const [hasKey, setHasKey] = createSignal(
  //   localStorage.getItem("gpd.key.saved") === "true"
  // )
  const [hasKey, setHasKey] = createSignal(
    localStorage.getItem("gpd.key.saved") === "true"
  )

  // When globalSync finishes bootstrapping and providers load, check if
  // "gpd" is already authed. This is the "installer set the key"
  // out-of-band path.
  // Latch: once we detect that provider-connected reports gpd but auth.json
  // can't be read (keyResource returned null), we stop letting the
  // provider-connected effect re-promote hasKey. Without this, the two
  // effects ping-pong: eff343 sees gpd connected → hasKey=true → eff411
  // sees null key → hasKey=false → eff343 re-promotes → infinite loop.
  //
  // Pre-latch on post-reset reloads: when the "Change API key" / revoke flow
  // writes the "gpd.key.resetting" sentinel before reloading, we start the
  // new page already latched. Reason: auth.json has been cleared by the
  // synchronous `platform.removeGpdKey` call, but the sidecar's in-memory
  // `provider.connected` cache may still report gpd for one refresh tick
  // (the pre-reload `global.dispose()` is intentionally not awaited to avoid
  // hangs — see onResetKey comments). Without this pre-latch, eff343 would
  // see stale `connected=["gpd"]`, promote `hasKey=true`, write
  // `gpd.key.saved=true` back to localStorage, and route the user back to
  // the main IDE — exactly the "flash welcome → snap back to main" bug.
  const justReset = localStorage.getItem("gpd.key.resetting") === "1"
  if (justReset) localStorage.removeItem("gpd.key.resetting")
  const [reonboardLatched, setReonboardLatched] = createSignal(justReset)

  createEffect(() => {
    if (!globalSync.ready) return
    const allProviders = globalSync.data.provider.all
    if (!allProviders || allProviders.length === 0) return
    if (reonboardLatched()) return
    const connected = globalSync.data.provider.connected ?? []
    const gpdAuthed = connected.includes("gpd")
    if (gpdAuthed && !hasKey()) {
      setHasKey(true)
      localStorage.setItem("gpd.key.saved", "true")
    }
  })

  async function handleApiKeySaved(apiKey: string) {
    await globalSDK.client.auth.set({
      providerID: "gpd",
      auth: { type: "api", key: apiKey },
    })
    localStorage.setItem("gpd.key.saved", "true")
    // WelcomeScreen's TOS step just wrote the accepted-version to
    // localStorage before calling us. The tosAcceptedVersion signal was
    // seeded from localStorage at mount time and doesn't auto-refresh,
    // so pull the current value forward here — otherwise tosUpToDate()
    // stays false and TosUpgradeGate re-prompts the user (double TOS).
    setTosAcceptedVersion(localStorage.getItem(TOS_ACCEPTED_VERSION_STORAGE_KEY))
    setHasKey(true)
    await globalSDK.client.global.dispose()
  }

  // Expose reset function globally so users can change their key
  // Usage: type `gpd-reset-key` in the command palette or run in console
  ;(window as any).__GPD_RESET_KEY__ = () => {
    localStorage.removeItem("gpd.key.saved")
    localStorage.removeItem(TOS_ACCEPTED_VERSION_STORAGE_KEY)
    setHasKey(false)
  }

  // ─── TOS version-bump gate ───────────────────────────────────────────
  //
  // Shown when the user has a saved key but the cached accepted-version
  // is older than CURRENT_TOS_VERSION. Re-prompts without asking for the
  // key again (TosUpgradeGate reads the saved key from auth.json on-demand
  // via platform.readGpdKey — no localStorage cache of the raw key).
  //
  // Seeded from localStorage so there's no render flash of the main IDE
  // before the gate kicks in.
  const platform = usePlatform()
  const [tosAcceptedVersion, setTosAcceptedVersion] = createSignal<string | null>(
    localStorage.getItem(TOS_ACCEPTED_VERSION_STORAGE_KEY),
  )
  const tosUpToDate = () => tosAcceptedVersion() === CURRENT_TOS_VERSION

  // Lazy-load the key from auth.json when the gate actually needs it.
  // On platforms without `readGpdKey` (web builds, if any) the resource
  // resolves to null and the Show fallback below forces re-onboard.
  const [keyResource] = createResource(
    () => !tosUpToDate() && hasKey(),
    async () => {
      if (!platform.readGpdKey) return null
      return (await platform.readGpdKey()) ?? null
    },
  )

  // Key is saved (gpd.key.saved=true) but readGpdKey returned null —
  // auth.json is missing / corrupt. Force re-onboard so the upgrade gate
  // doesn't render without a key to re-POST.
  createEffect(() => {
    if (!hasKey()) return
    if (tosUpToDate()) return
    if (keyResource.loading) return
    if (keyResource() != null) return
    // Latch this decision so eff343 won't re-promote hasKey from stale
    // provider.connected on the next tick (see reonboardLatched docs).
    setReonboardLatched(true)
    localStorage.removeItem("gpd.key.saved")
    setHasKey(false)
  })

  // Demote when localStorage disagrees with auth.json. Without this, a
  // stale gpd.key.saved=true combined with an empty auth.json (e.g. a
  // half-completed Change-API-Key that cleared the server side but not
  // localStorage) renders the main IDE with no usable key, so every LLM
  // call 401s as "Sign-in failed" and the user has no path back to the
  // welcome screen. auth.json is authoritative — if the sidecar reports
  // gpd not connected once providers are loaded, hasKey must drop.
  createEffect(() => {
    if (!hasKey()) return
    if (!globalSync.ready) return
    const allProviders = globalSync.data.provider.all
    if (!allProviders || allProviders.length === 0) return
    const connected = globalSync.data.provider.connected ?? []
    if (connected.includes("gpd")) return
    setReonboardLatched(true)
    localStorage.removeItem("gpd.key.saved")
    setHasKey(false)
  })

  // Unconditional FS-backed key check. The two effects above wait for
  // globalSync (effect-465) or for the upgrade-gate to need the key
  // (effect-442) before consulting auth.json — and BOTH skip the check
  // when the user is past TOS and the sync hasn't reported its
  // provider list yet. Result: a fresh launch with `gpd.key.saved=true`
  // in localStorage but a missing/empty auth.json renders the main IDE
  // until the sidecar provider list loads, and any chat send in that
  // window 401s as "Sign-in failed" with no path back to the welcome
  // screen. Confirmed 2026-04-29 in `bun tauri dev` on macOS: localStorage
  // gpd.key.saved=true, gpd.tos.acceptedVersion=1.0, auth.json absent,
  // user lands in main IDE with a stale-key UI.
  //
  // This resource fires on mount regardless of TOS state. If
  // `readGpdKey` returns null we demote immediately, exactly the same
  // way handleChangeApiKey does, sending the user to the welcome screen.
  // Web fallback (no readGpdKey command) leaves the resource undefined
  // — that case still has eff-465 to catch the desync once globalSync
  // reports a connected list, which on web is the only authoritative
  // source anyway.
  const [authJsonKey] = createResource(
    () => hasKey() && !!platform.readGpdKey,
    async () => {
      if (!platform.readGpdKey) return null
      return (await platform.readGpdKey()) ?? null
    },
  )
  createEffect(() => {
    if (!hasKey()) return
    if (!platform.readGpdKey) return
    if (authJsonKey.loading) return
    if (authJsonKey() != null) return
    setReonboardLatched(true)
    localStorage.removeItem("gpd.key.saved")
    setHasKey(false)
  })

  return (
    <Show when={hasKey()} fallback={<WelcomeScreen onComplete={handleApiKeySaved} />}>
      <Show
        when={tosUpToDate()}
        fallback={
          <Show when={keyResource()}>
            {(apiKey) => (
              <TosUpgradeGate
                apiKey={apiKey()}
                isUpgrade={!!tosAcceptedVersion()}
                onAccepted={() => setTosAcceptedVersion(CURRENT_TOS_VERSION)}
              />
            )}
          </Show>
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      disableHealthCheck={props.disableHealthCheck}
      servers={props.servers}
    >
      <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
        <ServerKey>
          <GlobalSDKProvider>
            <GlobalSyncProvider>
              <SetupGate>
                <Dynamic
                  component={props.router ?? Router}
                  root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
                >
                  <Route path="/" component={HomeRoute} />
                  <Route path="/:dir" component={DirectoryLayout}>
                    <Route path="/" component={SessionIndexRoute} />
                    <Route path="/session/:id?" component={SessionRoute} />
                  </Route>
                </Dynamic>
              </SetupGate>
            </GlobalSyncProvider>
          </GlobalSDKProvider>
        </ServerKey>
      </ConnectionGate>
    </ServerProvider>
  )
}
