import { createContext, createMemo, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import type {
  TexCompileProgress,
  TexCompileResult,
  TexCompilerInfo,
} from "@/context/platform"

/**
 * Solid hook that owns TeX compile state for a single session.
 *
 * The hook is intentionally tab-agnostic — it keeps history by absolute
 * `.tex` path so the Build pane can still show the last-good PDF when the
 * user switches between multiple TeX files. Each entry in `history` is a
 * full `TexCompileResult`; the "current" entry is whichever file is
 * currently requested via `setActive()`.
 *
 * The Rust side is cancel-aware: calling `compile()` while another compile
 * is running will abort the older one and return `status = "cancelled"`
 * from its promise. We surface that as a no-op rather than a user-facing
 * error so the UI doesn't flicker an error state mid-compile.
 */
export type TexBuildEntry = {
  /** Absolute path to the `.tex` source file the user opened. */
  texFile: string
  /** The resolved root `.tex` file we actually compiled. */
  rootFile: string
  /** Latest compile result for this tex file. */
  result: TexCompileResult
  /** `performance.now()` when this entry was recorded. */
  completedAt: number
}

export type TexCompileState = {
  /** Which TeX compiler (if any) was detected on the system. */
  compiler: TexCompilerInfo | null
  /** True iff a compile is currently running for any file. */
  running: boolean
  /** Last progress payload received from the backend. */
  progress: TexCompileProgress | null
  /** History keyed by absolute `.tex` file path. */
  history: Record<string, TexBuildEntry>
}

export function createTexCompiler(input: {
  /**
   * The project's root directory, which doubles as the project ID on the
   * Rust side. Only alphanumerics + `-` / `_` survive the Rust sanitizer
   * so it is safe to pass a raw filesystem path.
   */
  projectId: () => string
}) {
  const platform = usePlatform()
  const tex = createMemo(() => platform.tex)

  const [state, setState] = createStore<TexCompileState>({
    compiler: null,
    running: false,
    progress: null,
    history: {},
  })

  const [compilerLoaded, setCompilerLoaded] = createSignal(false)

  // Probe the compiler once when the hook mounts. We don't poll — the
  // answer only changes when the user installs/uninstalls LaTeX, which is
  // rare enough that a stale value is acceptable until the app restarts.
  onMount(() => {
    const api = tex()
    if (!api) {
      setCompilerLoaded(true)
      return
    }
    api
      .detectCompiler()
      .then((info) => {
        setState("compiler", info)
      })
      .catch((err) => {
        console.warn("detect_tex_compiler failed", err)
      })
      .finally(() => {
        setCompilerLoaded(true)
      })
  })

  // Subscribe to progress events for as long as this hook is mounted.
  onMount(async () => {
    const api = tex()
    if (!api) return
    const unsub = await api.onProgress((payload) => {
      setState("progress", payload)
    })
    onCleanup(unsub)
  })

  const refreshCompiler = async () => {
    const api = tex()
    if (!api) return null
    const info = await api.detectCompiler()
    setState("compiler", info)
    return info
  }

  const compile = async (input: { texFile: string; rootFile?: string | null }) => {
    const api = tex()
    if (!api) {
      throw new Error("TeX compilation is not available on this platform.")
    }
    setState("running", true)
    setState("progress", { status: "starting", percent: 0, message: "" })
    try {
      const result = await api.compile({
        projectId: stableProjectId(),
        texFile: input.texFile,
        rootFile: input.rootFile ?? null,
      })
      // Cancelled compiles are a normal outcome when the user clicks
      // [Compile] twice quickly. Don't record them in history.
      if (result.status !== "cancelled") {
        setState("history", input.texFile, {
          texFile: input.texFile,
          rootFile: result.rootFile,
          result,
          completedAt: performance.now(),
        })
      }
      // If the probe said "no compiler" but we just ran pdflatex, refresh
      // so the UI reflects reality. And vice-versa.
      if (result.status === "no_compiler" && state.compiler?.kind !== "none") {
        await refreshCompiler()
      }
      return result
    } finally {
      setState("running", false)
    }
  }

  const detectRoot = async (startFile: string) => {
    const api = tex()
    if (!api) return startFile
    return api.detectRoot(startFile)
  }

  const synctexForward = async (input: {
    synctexPath: string
    page: number
    x: number
    y: number
  }) => {
    const api = tex()
    if (!api) return null
    try {
      return await api.synctexForward(input)
    } catch (e) {
      console.warn("synctex forward failed", e)
      return null
    }
  }

  const synctexReverse = async (input: {
    synctexPath: string
    sourceFile: string
    line: number
  }) => {
    const api = tex()
    if (!api) return null
    try {
      return await api.synctexReverse(input)
    } catch (e) {
      console.warn("synctex reverse failed", e)
      return null
    }
  }

  const stableProjectId = () => {
    const raw = input.projectId()
    return raw || "default"
  }

  /** Returns the most recent entry for a given tex file path, or null. */
  const current = (texFile: string): TexBuildEntry | null => state.history[texFile] ?? null

  /** True iff this platform supports compile at all (i.e. desktop build). */
  const supported = () => !!tex()

  return {
    state,
    current,
    compile,
    refreshCompiler,
    detectRoot,
    synctexForward,
    synctexReverse,
    supported,
    compilerLoaded,
  }
}

export type TexCompilerHandle = ReturnType<typeof createTexCompiler>

const TexCompilerContext = createContext<TexCompilerHandle>()

export function TexCompilerProvider(props: ParentProps) {
  const sdk = useSDK()
  const handle = createTexCompiler({ projectId: () => sdk.directory })
  return <TexCompilerContext.Provider value={handle}>{props.children}</TexCompilerContext.Provider>
}

export function useTexCompiler(): TexCompilerHandle {
  const ctx = useContext(TexCompilerContext)
  if (!ctx) throw new Error("useTexCompiler must be used within TexCompilerProvider")
  return ctx
}
