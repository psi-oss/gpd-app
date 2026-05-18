import { Component, createEffect, createSignal, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

// Profile schema mirrors gpd.core.profile in get-physics-done; the
// paper-writer skill on the Python side reads the same file via
// load_profile() and pre-fills authors[] in PAPER-CONFIG.json from
// it. Keep this shape in lock-step with src/gpd/core/profile.py
// AuthorProfile + Profile (schema_version=1).
type AuthorProfile = {
  name: string
  affiliations: string[]
  email: string
  orcid: string
}

type Profile = {
  schema_version: 1
  authors: AuthorProfile[]
}

const EMPTY_PROFILE: Profile = { schema_version: 1, authors: [] }

const EMPTY_AUTHOR = (): AuthorProfile => ({
  name: "",
  affiliations: [""],
  email: "",
  orcid: "",
})

function parseProfile(raw: string | null | undefined): Profile {
  if (!raw) return EMPTY_PROFILE
  try {
    const parsed = JSON.parse(raw) as Partial<Profile>
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.schema_version !== 1 ||
      !Array.isArray(parsed.authors)
    ) {
      return EMPTY_PROFILE
    }
    return {
      schema_version: 1,
      authors: parsed.authors.map((a) => ({
        name: typeof a?.name === "string" ? a.name : "",
        affiliations: Array.isArray(a?.affiliations)
          ? a.affiliations.filter((s): s is string => typeof s === "string")
          : [],
        email: typeof a?.email === "string" ? a.email : "",
        orcid: typeof a?.orcid === "string" ? a.orcid : "",
      })),
    }
  } catch {
    return EMPTY_PROFILE
  }
}

// Strip empty affiliation rows + trim before persisting. The Python
// reader does its own normalization but doing it client-side gives
// the user a stable file on disk + lets us decide if the form is
// dirty/saveable without trim-aware diffing.
function normalizeForSave(profile: Profile): Profile {
  return {
    schema_version: 1,
    authors: profile.authors
      .map((a) => ({
        name: a.name.trim(),
        affiliations: a.affiliations.map((s) => s.trim()).filter((s) => s.length > 0),
        email: a.email.trim(),
        orcid: a.orcid.trim(),
      }))
      .filter((a) => a.name.length > 0),
  }
}

export const SettingsProfile: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()

  const [profile, setProfile] = createSignal<Profile>(EMPTY_PROFILE)
  const [loaded, setLoaded] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  createEffect(() => {
    // Load once on mount; the pane unmounts when the dialog closes
    // so a fresh open re-reads the file.
    if (loaded()) return
    void (async () => {
      try {
        const raw = platform.readProfile ? await platform.readProfile() : null
        const parsed = parseProfile(raw)
        // Seed at least one empty author so the form has something to
        // edit when the file is missing — saving with an empty form
        // re-writes an empty authors[], which is valid.
        if (parsed.authors.length === 0) {
          parsed.authors.push(EMPTY_AUTHOR())
        }
        setProfile(parsed)
      } catch (e) {
        console.error("[gpd] read_profile failed:", e)
      } finally {
        setLoaded(true)
      }
    })()
  })

  const setAuthorField = (idx: number, field: keyof AuthorProfile, value: string) => {
    setProfile((prev) => {
      const next = { ...prev, authors: prev.authors.map((a) => ({ ...a })) }
      const author = next.authors[idx]
      if (!author) return prev
      if (field === "affiliations") return prev
      author[field] = value
      return next
    })
  }

  const setAffiliation = (authorIdx: number, affIdx: number, value: string) => {
    setProfile((prev) => {
      const next = {
        ...prev,
        authors: prev.authors.map((a, i) =>
          i === authorIdx ? { ...a, affiliations: [...a.affiliations] } : { ...a },
        ),
      }
      const author = next.authors[authorIdx]
      if (!author) return prev
      author.affiliations[affIdx] = value
      return next
    })
  }

  const addAffiliation = (authorIdx: number) => {
    setProfile((prev) => {
      const next = {
        ...prev,
        authors: prev.authors.map((a, i) =>
          i === authorIdx ? { ...a, affiliations: [...a.affiliations, ""] } : a,
        ),
      }
      return next
    })
  }

  const removeAffiliation = (authorIdx: number, affIdx: number) => {
    setProfile((prev) => {
      const next = {
        ...prev,
        authors: prev.authors.map((a, i) => {
          if (i !== authorIdx) return a
          const remaining = a.affiliations.filter((_, j) => j !== affIdx)
          return { ...a, affiliations: remaining.length > 0 ? remaining : [""] }
        }),
      }
      return next
    })
  }

  const addAuthor = () => {
    setProfile((prev) => ({ ...prev, authors: [...prev.authors, EMPTY_AUTHOR()] }))
  }

  const removeAuthor = (idx: number) => {
    setProfile((prev) => {
      const remaining = prev.authors.filter((_, i) => i !== idx)
      return {
        ...prev,
        authors: remaining.length > 0 ? remaining : [EMPTY_AUTHOR()],
      }
    })
  }

  const save = async () => {
    if (!platform.writeProfile) {
      showToast({
        title: language.t("settings.profile.toast.failed"),
        description: "platform.writeProfile is unavailable",
        variant: "error",
      })
      return
    }
    setSaving(true)
    try {
      const normalized = normalizeForSave(profile())
      await platform.writeProfile(JSON.stringify(normalized, null, 2) + "\n")
      showToast({
        title: language.t("settings.profile.toast.saved"),
        variant: "success",
      })
    } catch (e) {
      showToast({
        title: language.t("settings.profile.toast.failed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex flex-col gap-4 p-6 max-w-2xl">
      <div class="flex flex-col gap-1">
        <h2 class="text-16-semibold text-text-base">{language.t("settings.profile.title")}</h2>
        <p class="text-13-regular text-text-weak">{language.t("settings.profile.description")}</p>
      </div>

      <Show when={loaded()} fallback={<div class="text-13-regular text-text-weak">…</div>}>
        <For each={profile().authors}>
          {(author, idx) => (
            <div class="flex flex-col gap-3 rounded-md border border-border-base bg-surface-base p-4">
              <div class="flex items-center justify-between">
                <span class="text-13-medium text-text-base">
                  {language.t("settings.profile.author.label", { index: idx() + 1 })}
                </span>
                <Show when={profile().authors.length > 1 || author.name.length > 0}>
                  <IconButton
                    icon="close-small"
                    variant="ghost"
                    size="small"
                    onClick={() => removeAuthor(idx())}
                    aria-label={language.t("settings.profile.author.remove")}
                  />
                </Show>
              </div>

              <div class="flex flex-col gap-2">
                <label class="text-12-medium text-text-weak" for={`profile-name-${idx()}`}>
                  {language.t("settings.profile.name")}
                </label>
                <input
                  id={`profile-name-${idx()}`}
                  type="text"
                  class="w-full rounded-md border border-border-base bg-background-base p-2 text-14-regular text-text-base outline-none focus:border-border-strong"
                  placeholder={language.t("settings.profile.name.placeholder")}
                  value={author.name}
                  onInput={(e) => setAuthorField(idx(), "name", e.currentTarget.value)}
                  disabled={saving()}
                />
              </div>

              <div class="flex flex-col gap-2">
                <label class="text-12-medium text-text-weak">
                  {language.t("settings.profile.affiliations.label")}
                </label>
                <For each={author.affiliations}>
                  {(aff, affIdx) => (
                    <div class="flex items-center gap-2">
                      <input
                        type="text"
                        class="w-full rounded-md border border-border-base bg-background-base p-2 text-14-regular text-text-base outline-none focus:border-border-strong"
                        placeholder={language.t("settings.profile.affiliations.placeholder")}
                        value={aff}
                        onInput={(e) => setAffiliation(idx(), affIdx(), e.currentTarget.value)}
                        disabled={saving()}
                      />
                      <Show when={author.affiliations.length > 1 || aff.length > 0}>
                        <IconButton
                          icon="close-small"
                          variant="ghost"
                          size="small"
                          onClick={() => removeAffiliation(idx(), affIdx())}
                          aria-label={language.t("settings.profile.affiliations.remove")}
                        />
                      </Show>
                    </div>
                  )}
                </For>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => addAffiliation(idx())}
                  disabled={saving()}
                >
                  {language.t("settings.profile.affiliations.add")}
                </Button>
              </div>

              <div class="flex flex-col gap-2">
                <label class="text-12-medium text-text-weak" for={`profile-email-${idx()}`}>
                  {language.t("settings.profile.email")}
                </label>
                <input
                  id={`profile-email-${idx()}`}
                  type="email"
                  class="w-full rounded-md border border-border-base bg-background-base p-2 text-14-regular text-text-base outline-none focus:border-border-strong"
                  placeholder={language.t("settings.profile.email.placeholder")}
                  value={author.email}
                  onInput={(e) => setAuthorField(idx(), "email", e.currentTarget.value)}
                  disabled={saving()}
                />
              </div>

              <div class="flex flex-col gap-2">
                <label class="text-12-medium text-text-weak" for={`profile-orcid-${idx()}`}>
                  {language.t("settings.profile.orcid")}
                </label>
                <input
                  id={`profile-orcid-${idx()}`}
                  type="text"
                  class="w-full rounded-md border border-border-base bg-background-base p-2 text-14-regular text-text-base outline-none focus:border-border-strong"
                  placeholder={language.t("settings.profile.orcid.placeholder")}
                  value={author.orcid}
                  onInput={(e) => setAuthorField(idx(), "orcid", e.currentTarget.value)}
                  disabled={saving()}
                />
              </div>
            </div>
          )}
        </For>

        <div class="flex items-center justify-between">
          <Button variant="ghost" size="small" onClick={addAuthor} disabled={saving()}>
            {language.t("settings.profile.author.add")}
          </Button>
          <Button onClick={save} disabled={saving()} variant="primary">
            {language.t(saving() ? "settings.profile.saving" : "settings.profile.save")}
          </Button>
        </div>
      </Show>
    </div>
  )
}
