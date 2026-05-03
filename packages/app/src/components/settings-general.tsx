import { Component, Show, createMemo, createResource, createSignal, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { useEditorRegistry } from "@/components/file-edit/editor-registry"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  useSettings,
} from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { Link } from "./link"
import { SettingsList } from "./settings-list"
import { abortAllPending } from "./prompt-input/submit"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

type ThemeOption = {
  id: string
  name: string
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

export const SettingsGeneral: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const permission = usePermission()
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()
  const params = useParams()
  const settings = useSettings()
  const registry = useEditorRegistry()

  onMount(() => {
    void theme.loadThemes()
  })

  const [store, setStore] = createStore({
    checking: false,
  })

  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const dir = createMemo(() => decode64(params.dir))
  const accepting = createMemo(() => {
    const value = dir()
    if (!value) return false
    if (!params.id) return permission.isAutoAcceptingDirectory(value)
    return permission.isAutoAccepting(params.id, value)
  })

  const toggleAccept = (checked: boolean) => {
    const value = dir()
    if (!value) return

    if (!params.id) {
      if (permission.isAutoAcceptingDirectory(value) === checked) return
      permission.toggleAutoAcceptDirectory(value)
      return
    }

    if (checked) {
      permission.enableAutoAccept(params.id, value)
      return
    }

    permission.disableAutoAccept(params.id, value)
  }

  const toggleEditor = (checked: boolean) => {
    if (checked) {
      settings.general.setExperimentalFileEditor(true)
      return
    }

    if (registry.dirty().length > 0) {
      showToast({
        title: language.t("file.editor.status.dirty"),
        description: language.t("file.editor.close.description"),
      })
      return
    }

    settings.general.setExperimentalFileEditor(false)
  }

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)

    void platform
      .checkUpdate()
      .then((result) => {
        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        const actions =
          platform.update && platform.restart
            ? [
                {
                  label: language.t("toast.update.action.installRestart"),
                  onClick: async () => {
                    await platform.update!()
                    await platform.restart!()
                  },
                },
                {
                  label: language.t("toast.update.action.notYet"),
                  onClick: "dismiss" as const,
                },
              ]
            : [
                {
                  label: language.t("toast.update.action.notYet"),
                  onClick: "dismiss" as const,
                },
              ]

        showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
          actions,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setStore("checking", false))
  }

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
    variant: "secondary" as const,
    size: "small" as const,
    triggerVariant: "settings" as const,
  })

  const GeneralSection = () => (
    <div class="flex flex-col gap-1">
      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <Select
            data-action="settings-language"
            options={languageOptions()}
            current={languageOptions().find((o) => o.value === language.locale())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && language.setLocale(option.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("command.permissions.autoaccept.enable")}
          description={language.t("toast.permissions.autoaccept.on.description")}
        >
          <div data-action="settings-auto-accept-permissions">
            <Switch checked={accepting()} disabled={!dir()} onChange={toggleAccept} />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.reasoningSummaries.title")}
          description={language.t("settings.general.row.reasoningSummaries.description")}
        >
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.shellToolPartsExpanded.title")}
          description={language.t("settings.general.row.shellToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-shell-tool-parts-expanded">
            <Switch
              checked={settings.general.shellToolPartsExpanded()}
              onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.editToolPartsExpanded.title")}
          description={language.t("settings.general.row.editToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-edit-tool-parts-expanded">
            <Switch
              checked={settings.general.editToolPartsExpanded()}
              onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.experimentalFileEditor.title")}
          description={language.t("settings.general.row.experimentalFileEditor.description")}
        >
          <div data-action="settings-experimental-file-editor">
            <Switch
              checked={settings.general.experimentalFileEditor()}
              onChange={toggleEditor}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const AppearanceSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.appearance")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <Select
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
            onHighlight={(option) => {
              if (!option) return
              theme.previewColorScheme(option.value)
              return () => theme.cancelPreview()
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
            triggerStyle={{ "min-width": "220px" }}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.theme.title")}
          description={
            <>
              {language.t("settings.general.row.theme.description")}{" "}
              <Link href="https://opencode.ai/docs/themes/">{language.t("common.learnMore")}</Link>
            </>
          }
        >
          <Select
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
            onHighlight={(option) => {
              if (!option) return
              theme.previewTheme(option.id)
              return () => theme.cancelPreview()
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.uiFont.title")}
          description={language.t("settings.general.row.uiFont.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextField
              data-action="settings-ui-font"
              label={language.t("settings.general.row.uiFont.title")}
              hideLabel
              type="text"
              value={sans()}
              onChange={(value) => settings.appearance.setUIFont(value)}
              placeholder={sansDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="text-12-regular"
              style={{ "font-family": sansFontFamily(settings.appearance.uiFont()) }}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextField
              data-action="settings-code-font"
              label={language.t("settings.general.row.font.title")}
              hideLabel
              type="text"
              value={mono()}
              onChange={(value) => settings.appearance.setFont(value)}
              placeholder={monoDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="text-12-regular"
              style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const NotificationsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.notifications")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const SoundsSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.sounds")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <Select
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <Select
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
          />
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <Select
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const UpdatesSection = () => (
    <div class="flex flex-col gap-1">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.updates")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.updates.row.startup.title")}
          description={language.t("settings.updates.row.startup.description")}
        >
          <div data-action="settings-updates-startup">
            <Switch
              checked={settings.updates.startup()}
              disabled={!platform.checkUpdate}
              onChange={(checked) => settings.updates.setStartup(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <Button size="small" variant="secondary" disabled={store.checking || !platform.checkUpdate} onClick={check}>
            {store.checking
              ? language.t("settings.updates.action.checking")
              : language.t("settings.updates.action.checkNow")}
          </Button>
        </SettingsRow>
      </SettingsList>
    </div>
  )

  const AccountSection = () => {
    const [revoking, setRevoking] = createSignal(false)
    const [confirmingKey, setConfirmingKey] = createSignal(false)
    const [confirming, setConfirming] = createSignal(false)
    const [revokeError, setRevokeError] = createSignal<string | undefined>()

    const handleChangeApiKey = async () => {
      setConfirmingKey(false)
      // Deliberately DO NOT clear gpd.tos.acceptedVersion — changing key
      // on the same device keeps prior version acceptance valid. Revoke
      // Consent is the explicit path for wiping it.
      //
      // Authoritative delete path is the Tauri `removeGpdKey` command:
      // it writes auth.json synchronously on the filesystem, so the
      // next SetupGate mount reads a key-free auth.json regardless of
      // sidecar state. The sidecar's HTTP `auth.remove` endpoint was
      // unreliable here — if the sidecar was mid-dispose or wedged on
      // a request, the await blocked indefinitely and the reload never
      // ran, so the button appeared dead. Even when it completed, a
      // racing `global.dispose` left provider.connected still reporting
      // "gpd" on the next launch and re-promoted the user past the
      // welcome screen (visible as "entry page flashes then snaps back
      // to the main IDE"). That re-promotion race is now closed by the
      // "gpd.key.resetting" sentinel written below: app.tsx consumes it
      // at mount to pre-latch reonboardLatched, so the stale
      // provider.connected tick can't re-promote hasKey before the
      // sidecar catches up to the just-emptied auth.json.
      if (platform.removeGpdKey) {
        try {
          await platform.removeGpdKey()
        } catch (e) {
          console.error("[gpd] removeGpdKey failed:", e)
        }
      } else {
        // Web / non-desktop fallback — HTTP path with a short timeout
        // so a stalled sidecar cannot wedge the button.
        const timeout = <T,>(p: Promise<T>) =>
          Promise.race([
            p,
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
          ])
        await timeout(globalSDK.client.auth.remove({ providerID: "gpd" })).catch((e) =>
          console.error("[gpd] auth.remove failed:", e),
        )
      }
      // Best-effort instance dispose so the sidecar forgets the stale
      // in-memory provider state. Not required for correctness — the
      // file-backed state is already clean.
      void globalSDK.client.global.dispose().catch((e) =>
        console.error("[gpd] global.dispose failed:", e),
      )
      localStorage.removeItem("gpd.key.saved")
      // Sentinel read by app.tsx on the next mount: pre-latches
      // reonboardLatched so the provider-connected effect can't
      // re-promote hasKey from the sidecar's stale in-memory cache
      // before its /provider read catches up to the just-emptied
      // auth.json. See app.tsx reonboardLatched doc.
      localStorage.setItem("gpd.key.resetting", "1")
      window.location.reload()
    }

    async function handleRevokeConsent() {
      setRevokeError(undefined)
      setConfirming(false)
      setRevoking(true)
      // Abort all in-flight prompt streams BEFORE anything else. Closes
      // the window where the sidecar keeps streaming tokens against the
      // (about-to-be-revoked) key after the user clicks Revoke. This
      // fires immediately — don't hold it behind the POST latency.
      abortAllPending()
      try {
        const key = platform.readGpdKey ? await platform.readGpdKey() : null
        // Only POST a server-side revocation row when we actually hold a
        // key. Without one we can't authenticate to /gpd/tos-revoke, but
        // we must still let the user out of the main IDE — otherwise the
        // button is dead in exactly the desync state it's meant to fix
        // (local "signed in" + auth.json empty). In that desync state
        // there is no provable current acceptance from this device tied
        // to a real user_id anyway, so skipping the audit row is correct
        // — the local wipe + reload sends them back to the welcome
        // screen where a fresh acceptance will be recorded properly.
        if (key) {
          const res = await fetch(
            "https://litellm-production-46bb.up.railway.app/gpd/tos-revoke",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
              },
              body: "{}",
            },
          )
          if (!res.ok) {
            let detail = ""
            try {
              const body = (await res.json()) as { detail?: string }
              detail = body.detail ?? ""
            } catch {
              /* non-JSON */
            }
            throw new Error(
              language.t("settings.account.revokeConsent.errorHttp", {
                status: res.status,
                detail: detail ? `: ${detail}` : "",
              }),
            )
          }
        }
        // Delete the GPD entry from auth.json on disk before clearing
        // localStorage. Without this step the LiteLLM virtual key
        // persists on disk post-revoke; a second CLI process (or
        // anyone with filesystem access) can keep calling LiteLLM with
        // that key. The server-side consent gate (infra/litellm/
        // gpd_consent) is the authoritative enforcement surface —
        // calls will now 403 — but defence-in-depth says remove the
        // credential too. platform.removeGpdKey writes via atomic
        // tmp+rename (lib.rs:remove_gpd_key) so a concurrent sidecar
        // read sees either the full file or the post-delete shape,
        // never a torn state. Best-effort: a failure here still
        // reloads the UI, the server gate still blocks future calls.
        if (platform.removeGpdKey) {
          try {
            await platform.removeGpdKey()
          } catch (e) {
            console.warn("revoke: removeGpdKey failed (continuing):", e)
          }
        }
        // Clear local sign-in state. Server has a revocation row; operator
        // runs `scripts/delete-user.ts --user-id=... --confirm` to
        // pseudonymize identifying fields + purge GCS/BQ data.
        localStorage.removeItem("gpd.key.saved")
        localStorage.removeItem("gpd.tos.acceptedVersion")
        // Same pre-latch rationale as handleChangeApiKey — block stale
        // sidecar provider.connected from re-promoting hasKey post-reload.
        localStorage.setItem("gpd.key.resetting", "1")
        window.location.reload()
      } catch (e) {
        setRevokeError(e instanceof Error ? e.message : String(e))
      } finally {
        setRevoking(false)
      }
    }

    return (
      <div class="flex flex-col gap-1">
        <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.account.title")}</h3>

        <SettingsList>
          <SettingsRow
            title={language.t("settings.account.accessKey.title")}
            description={language.t("settings.account.accessKey.description")}
          >
            <Button
              size="small"
              variant="secondary"
              disabled={confirmingKey() || revoking()}
              onClick={() => setConfirmingKey(true)}
            >
              {language.t("sidebar.resetKey")}
            </Button>
          </SettingsRow>
          <Show when={confirmingKey()}>
            <div class="mx-4 mb-3 flex flex-col gap-3 rounded-md border border-border-weak-base bg-surface-base p-3">
              <p class="text-13-regular text-text-base">
                {language.t("settings.account.accessKey.description")}
              </p>
              <div class="flex justify-end gap-2">
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => setConfirmingKey(false)}
                >
                  {language.t("common.cancel")}
                </Button>
                <Button
                  size="small"
                  variant="primary"
                  onClick={() => void handleChangeApiKey()}
                >
                  {language.t("sidebar.resetKey")}
                </Button>
              </div>
            </div>
          </Show>
          <SettingsRow
            title={language.t("settings.account.revokeConsent.title")}
            description={language.t("settings.account.revokeConsent.description")}
          >
            <Button
              size="small"
              variant="secondary"
              disabled={revoking() || confirming()}
              onClick={() => setConfirming(true)}
            >
              {language.t("settings.account.revokeConsent.button")}
            </Button>
          </SettingsRow>
          <Show when={confirming()}>
            <div class="mx-4 mb-3 flex flex-col gap-3 rounded-md border border-border-weak-base bg-surface-base p-3">
              <p class="text-13-regular text-text-base">
                {language.t("settings.account.revokeConsent.confirm")}
              </p>
              <div class="flex justify-end gap-2">
                <Button
                  size="small"
                  variant="ghost"
                  disabled={revoking()}
                  onClick={() => setConfirming(false)}
                >
                  {language.t("common.cancel")}
                </Button>
                <Button
                  size="small"
                  variant="primary"
                  disabled={revoking()}
                  onClick={() => void handleRevokeConsent()}
                >
                  {language.t("settings.account.revokeConsent.button")}
                </Button>
              </div>
            </div>
          </Show>
          <Show when={revokeError()}>
            <p class="px-4 py-2 text-13-regular text-text-danger">{revokeError()}</p>
          </Show>
        </SettingsList>
      </div>
    )
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.general")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <GeneralSection />

        <AppearanceSection />

        <NotificationsSection />

        <SoundsSection />

        <AccountSection />

        {/*<Show when={platform.platform === "desktop" && platform.os === "windows" && platform.getWslEnabled}>
          {(_) => {
            const [enabledResource, actions] = createResource(() => platform.getWslEnabled?.())
            const enabled = () => (enabledResource.state === "pending" ? undefined : enabledResource.latest)

            return (
              <div class="flex flex-col gap-1">
                <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.desktop.section.wsl")}</h3>

                <SettingsList>
                  <SettingsRow
                    title={language.t("settings.desktop.wsl.title")}
                    description={language.t("settings.desktop.wsl.description")}
                  >
                    <div data-action="settings-wsl">
                      <Switch
                        checked={enabled() ?? false}
                        disabled={enabledResource.state === "pending"}
                        onChange={(checked) => platform.setWslEnabled?.(checked)?.finally(() => actions.refetch())}
                      />
                    </div>
                  </SettingsRow>
                </SettingsList>
              </div>
            )
          }}
        </Show>*/}

        <UpdatesSection />

        <Show when={linux()}>
          {(_) => {
            const [valueResource, actions] = createResource(() => platform.getDisplayBackend?.())
            const value = () => (valueResource.state === "pending" ? undefined : valueResource.latest)

            const onChange = (checked: boolean) =>
              platform.setDisplayBackend?.(checked ? "wayland" : "auto").finally(() => actions.refetch())

            return (
              <div class="flex flex-col gap-1">
                <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.display")}</h3>

                <SettingsList>
                  <SettingsRow
                    title={
                      <div class="flex items-center gap-2">
                        <span>{language.t("settings.general.row.wayland.title")}</span>
                        <Tooltip value={language.t("settings.general.row.wayland.tooltip")} placement="top">
                          <span class="text-text-weak">
                            <Icon name="help" size="small" />
                          </span>
                        </Tooltip>
                      </div>
                    }
                    description={language.t("settings.general.row.wayland.description")}
                  >
                    <div data-action="settings-wayland">
                      <Switch checked={value() === "wayland"} onChange={onChange} />
                    </div>
                  </SettingsRow>
                </SettingsList>
              </div>
            )
          }}
        </Show>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
    </div>
  )
}
