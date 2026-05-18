import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import { ServerConnection } from "./server"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean; defaultPath?: string }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type UpdateInfo = { updateAvailable: boolean; version?: string }

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** Desktop OS (Tauri only) */
  os?: "macos" | "windows" | "linux"

  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /**
   * Reveal a file in the system file manager (Finder on macOS, Explorer on
   * Windows, default file manager on Linux). Desktop only — web returns
   * undefined and callers should hide the corresponding UI.
   */
  revealPath?(path: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open directory picker dialog (native on Tauri, server-backed on web) */
  openDirectoryPickerDialog?(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>

  /** Open native file picker dialog (Tauri only) */
  openFilePickerDialog?(opts?: OpenFilePickerOptions): Promise<PickerPaths>

  /** Save file picker dialog (Tauri only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check for updates (Tauri only) */
  checkUpdate?(): Promise<UpdateInfo>

  /** Install updates (Tauri only) */
  update?(): Promise<void>

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Get the configured WSL integration (desktop only) */
  getWslEnabled?(): Promise<boolean>

  /** Set the configured WSL integration (desktop only) */
  setWslEnabled?(config: boolean): Promise<void> | void

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Read the bundled root LICENSE file (desktop only; web has no bundle) */
  readLicense?(): Promise<string>

  /** Read the bundled THIRD_PARTY_NOTICES.md (desktop only) */
  readThirdPartyNotices?(): Promise<string>

  /** Exit the app immediately (desktop only; falls back to window.close on web). */
  quit?(): Promise<void>

  /**
   * Read the saved LiteLLM virtual key for the `gpd` provider out of
   * `auth.json` (desktop only — the webview has no filesystem access).
   * Returns `null` if no key is saved or the file is missing/corrupt.
   *
   * Used by the TOS version-bump gate so acceptance re-POST can reuse
   * the user's already-saved key without caching it in localStorage
   * (which has unverified cross-OS trust-envelope claims).
   */
  readGpdKey?(): Promise<string | null>

  /**
   * Delete the `gpd` entry from `auth.json` synchronously on disk. Used
   * by the "Change API Key" flow as an authoritative reset — calling
   * the sidecar's HTTP `auth.remove` endpoint can hang if the sidecar
   * is mid-dispose or wedged on another request, leaving a stale key
   * in `auth.json` after reload and re-promoting the user past the
   * welcome screen on provider.connected. Direct FS write is fast and
   * cannot race the sidecar.
   */
  removeGpdKey?(): Promise<void>

  /**
   * Read the author-profile JSON at `~/.gpd/profile.json` (desktop only).
   * Returns the raw string so the Settings → Profile pane can parse it
   * with its own schema; returns `null` when the file is missing. The
   * file is also read by the get-physics-done `gpd.core.profile` Python
   * helper, which is what the paper-writer skill calls — both sides
   * resolve to the same default path so a profile saved here pre-fills
   * authors[] in new PAPER-CONFIG.json on the next paper draft.
   */
  readProfile?(): Promise<string | null>

  /**
   * Atomically write the author profile JSON. The Rust side validates
   * that the body parses as JSON (so malformed strings never clobber a
   * good file) and chmod 0o600 on Unix to keep PII off the multi-user
   * inspection path, then renames into place so a concurrent paper-draft
   * read never observes a half-written file.
   */
  writeProfile?(json: string): Promise<void>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Launch git install on macOS (xcode-select --install). Desktop macOS only. */
  installGitMacos?(): Promise<{ launched: boolean; message: string }>

  /** Launch git install on Windows (winget). Desktop Windows only. */
  installGitWindows?(): Promise<{ launched: boolean; message: string }>

  /** Return the install shell snippet for a tool on Linux (no execution). */
  linuxInstallHint?(tool: string): Promise<string>

  /**
   * Download and install the Tectonic TeX engine on demand (desktop only).
   * Resolves with the absolute path to the installed `tectonic` binary.
   */
  installTectonic?(): Promise<string>

  /**
   * Subscribe to Tectonic download progress while `installTectonic()` is in
   * flight. Returns an unsubscribe callback. Desktop only.
   */
  onTectonicDownloadProgress?(
    cb: (payload: { loaded: number; total: number }) => void,
  ): Promise<() => void>

  /** Copy a string to the system clipboard. */
  writeClipboard?(text: string): Promise<void>

  /** Delete the GPD venv + init marker and re-run first-run setup. Desktop only. */
  repairGpdVenv?(): Promise<void>

  /**
   * Create a new empty directory under `parent` with name `name`. Desktop
   * only. Refuses to overwrite an existing file or directory and validates
   * name (no slashes, not `.` or `..`, non-empty). Resolves with the full
   * path to the newly created directory.
   */
  createProjectDirectory?(parent: string, name: string): Promise<string>

  /**
   * Probe whether the app can read the given project folder. Runs in the
   * Tauri main process so macOS TCC attributes any prompt/grant to the
   * signed app bundle rather than the sidecar subprocess.
   *
   * Returns one of:
   *   - `"ok"`       — directory exists and is readable
   *   - `"locked"`   — macOS (or another OS) denied read access (EACCES/EPERM)
   *   - `"missing"`  — directory does not exist
   */
  checkProjectAccessible?(path: string): Promise<"ok" | "locked" | "missing">

  /**
   * Canonicalize a filesystem path via the Tauri main process.
   * Resolves `.`/`..` segments and follows symlinks.
   *
   * Returns the canonical absolute path, or `null` when the path does
   * not exist or cannot be resolved. Used as a trust boundary before
   * comparing an untrusted (URL-derived) path against forbidden roots:
   * without canonicalization, `<home>/Documents/..` or a symlinked
   * path bypasses `rejectUnsafeProjectPath`.
   *
   * Desktop-only. Web builds return `undefined` at the function slot
   * so callers must handle absence (treat as "cannot verify").
   */
  canonicalizeProjectPath?(path: string): Promise<string | null>

  /**
   * TeX compilation surface. Desktop only. Lets the Build pane detect a
   * compiler, compile a `.tex` file to PDF, and do bidirectional SyncTeX
   * navigation between source and rendered output.
   */
  tex?: {
    detectCompiler(): Promise<TexCompilerInfo>
    detectRoot(startFile: string): Promise<string>
    compile(input: { projectId: string; texFile: string; rootFile: string | null }): Promise<TexCompileResult>
    synctexForward(input: { synctexPath: string; page: number; x: number; y: number }): Promise<SyncTexResult>
    synctexReverse(input: { synctexPath: string; sourceFile: string; line: number }): Promise<SyncTexResult>
    parseLog(logPath: string): Promise<TexLogParseResult>
    /**
     * Read a build artifact (PDF, log) and return it as a base64 string.
     * The backend verifies the path lives under the GPD tex-builds cache.
     */
    readArtifactBase64(path: string): Promise<string>
    /**
     * Subscribe to compile progress events. Returns an unsubscribe callback.
     */
    onProgress(cb: (payload: TexCompileProgress) => void): Promise<() => void>
  }
}

export type TexCompileStatus =
  | "success"
  | "success_with_warnings"
  | "error"
  | "no_compiler"
  | "cancelled"

export type TexDiagnostic = {
  severity: string
  file: string | null
  line: number | null
  message: string
}

export type TexCompileResult = {
  status: TexCompileStatus
  pdfPath: string | null
  synctexPath: string | null
  logPath: string | null
  compilerKind: string | null
  compilerPath: string | null
  durationMs: number
  errors: TexDiagnostic[]
  warnings: TexDiagnostic[]
  rootFile: string
  outDir: string
}

export type TexCompilerInfo = {
  kind: string
  path: string | null
  hasLatexmk: boolean
  hasBibtex: boolean
  hasSynctex: boolean
}

export type SyncTexResult = {
  file: string | null
  line: number | null
  page: number | null
  x: number | null
  y: number | null
}

export type TexLogParseResult = {
  errors: TexDiagnostic[]
  warnings: TexDiagnostic[]
  rawLog: string
}

export type TexCompileProgress = {
  status: string
  percent: number
  message: string
}

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
