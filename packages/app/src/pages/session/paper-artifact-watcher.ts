// RES-1012: auto-open the manuscript .tex in the session side panel when
// `gpd paper-build` writes ARTIFACT-MANIFEST.json. The signal is the file
// watcher event for any path ending in ARTIFACT-MANIFEST.json under the
// project root; the .tex artifact recorded in the manifest's `artifacts`
// array (category === "tex") is the canonical primary.
//
// State is session-scoped: a per-session Set of auto-opened tab keys (so we
// don't re-open the same file on every manifest re-emission within one
// session) and a per-session Set of user-closed tab keys (so a manual close
// is sticky — the workflow refreshing the manifest will not reopen).

// SDK shape is described structurally to avoid coupling this module to the
// per-session SDK context's full surface. Only the two members used here.
type SDKLike = {
  client: { file: { read: (req: { path: string }) => Promise<{ data?: { content?: string } }> } }
  event: { listen: (handler: (evt: { details: { type: string; properties?: unknown } }) => void) => () => void }
}

const autoOpenedBySession = new Map<string, Set<string>>()
const userClosedBySession = new Map<string, Set<string>>()

function setFor(map: Map<string, Set<string>>, key: string): Set<string> {
  let s = map.get(key)
  if (!s) {
    s = new Set()
    map.set(key, s)
  }
  return s
}

export function isAutoOpened(sessionKey: string, tab: string): boolean {
  return autoOpenedBySession.get(sessionKey)?.has(tab) ?? false
}

export function markAutoOpened(sessionKey: string, tab: string): void {
  setFor(autoOpenedBySession, sessionKey).add(tab)
}

export function listAutoOpened(sessionKey: string): readonly string[] {
  const s = autoOpenedBySession.get(sessionKey)
  return s ? [...s] : []
}

export function isUserClosed(sessionKey: string, tab: string): boolean {
  return userClosedBySession.get(sessionKey)?.has(tab) ?? false
}

export function markUserClosed(sessionKey: string, tab: string): void {
  setFor(userClosedBySession, sessionKey).add(tab)
}

export function clearPaperArtifactSession(sessionKey: string): void {
  autoOpenedBySession.delete(sessionKey)
  userClosedBySession.delete(sessionKey)
}

async function readTexArtifactPath(sdk: SDKLike, manifestPath: string): Promise<string | undefined> {
  // The manifest writer (`gpd_paper.json_io.write_model_json`) does a plain
  // truncating write, not an atomic rename. On macOS fs-events the update
  // notification typically lands after the writer closes the fd, but the
  // contract is not guaranteed. Retry once on parse failure to cover the
  // narrow race window where the read sees a partial file.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await sdk.client.file.read({ path: manifestPath })
      const content = res.data?.content
      if (typeof content !== "string" || content.length === 0) return
      const manifest = JSON.parse(content) as { artifacts?: Array<{ category?: string; path?: string }> }
      const tex = manifest.artifacts?.find((a) => a?.category === "tex")
      if (tex && typeof tex.path === "string" && tex.path.length > 0) return tex.path
      return
    } catch {
      if (attempt === 0) {
        await new Promise<void>((r) => setTimeout(r, 100))
        continue
      }
      return
    }
  }
}

function manifestDir(relManifestPath: string): string {
  const idx = relManifestPath.lastIndexOf("/")
  return idx === -1 ? "" : relManifestPath.slice(0, idx)
}

export function subscribePaperArtifactWatcher(opts: {
  sdk: SDKLike
  sessionKey: () => string
  normalize: (input: string) => string
  pathToTab: (path: string) => string
  openTab: (tab: string) => void | Promise<void>
}): () => void {
  return opts.sdk.event.listen((evt) => {
    void handleEvent(evt, opts)
  })
}

async function handleEvent(
  evt: { details: { type: string; properties?: unknown } },
  opts: {
    sdk: SDKLike
    sessionKey: () => string
    normalize: (input: string) => string
    pathToTab: (path: string) => string
    openTab: (tab: string) => void | Promise<void>
  },
): Promise<void> {
  if (evt.details.type !== "file.watcher.updated") return
  const props =
    typeof evt.details.properties === "object" && evt.details.properties
      ? (evt.details.properties as Record<string, unknown>)
      : undefined
  const rawFile = typeof props?.file === "string" ? props.file : undefined
  if (!rawFile) return
  if (!rawFile.endsWith("ARTIFACT-MANIFEST.json")) return
  const kind = typeof props?.event === "string" ? props.event : undefined
  if (kind === "unlink") return

  const relManifest = opts.normalize(rawFile)
  if (!relManifest || !relManifest.endsWith("ARTIFACT-MANIFEST.json")) return

  const texPathRelToManifest = await readTexArtifactPath(opts.sdk, relManifest)
  if (!texPathRelToManifest) return

  const dir = manifestDir(relManifest)
  const texRel = dir ? `${dir}/${texPathRelToManifest}` : texPathRelToManifest
  const tabKey = opts.pathToTab(texRel)
  if (!tabKey) return

  const session = opts.sessionKey()
  if (isUserClosed(session, tabKey)) return
  if (isAutoOpened(session, tabKey)) return

  markAutoOpened(session, tabKey)
  await opts.openTab(tabKey)
}
