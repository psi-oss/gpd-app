import { Component, createSignal, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useGlobalSDK } from "@/context/global-sdk"
import { SettingsList } from "./settings-list"
import { abortAllPending } from "./prompt-input/submit"

// Dedicated "API Key" settings pane. Hosts the two account-management
// flows previously buried at the bottom of the General tab:
//  - Change API Key  → wipes the saved gpd entry from auth.json and
//    reloads the app to the welcome screen so the user can paste a new
//    key. Preserves gpd.tos.acceptedVersion: replacing the key on the
//    same device does not invalidate prior TOS acceptance. The explicit
//    Revoke Consent button below is the path for clearing TOS.
//  - Revoke Consent  → POSTs /gpd/tos-revoke and wipes both the saved
//    key AND gpd.tos.acceptedVersion, sending the user back through the
//    full welcome + TOS flow on next launch.
//
// Implementation extracted verbatim from the AccountSection that lived
// inside settings-general.tsx through v1.0.2. See the inline comments
// for the operational rationale of each step (auth.json atomic write,
// abortAllPending before revoke POST, gpd.key.resetting sentinel, etc).
export const SettingsApiKey: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()

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
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.account.title")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        <div class="flex flex-col gap-1">
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
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string
  description: string
  children: import("solid-js").JSX.Element
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
