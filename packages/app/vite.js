import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

// pdfjs-dist requires character maps (cmaps) and standard PDF fonts at
// runtime. Without them the renderer substitutes ASCII fallbacks for
// math symbols (∂→@), accented characters (ö→o), and ligatures (fi→" "),
// producing garbled output for any non-Latin-1 PDF. We serve the bundled
// payloads from pdfjs-dist's own copy under `/pdfjs/cmaps/` and
// `/pdfjs/standard_fonts/` so the consumer just sets the URLs and
// forgets about it. Dev: middleware streams files directly. Prod: the
// closeBundle hook copies the directories into the build output.
const _require = createRequire(import.meta.url)
let pdfjsRoot = null
try {
  pdfjsRoot = dirname(_require.resolve("pdfjs-dist/package.json"))
} catch {
  // pdfjs-dist isn't installed in every workspace consumer (the web
  // build pulls in different deps). Skip the asset serving in that
  // case — only the TeX-rendering desktop build needs these payloads.
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const s = join(src, entry)
    const d = join(dest, entry)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  {
    name: "opencode-desktop:pdfjs-assets",
    apply: () => true,
    configureServer(server) {
      if (!pdfjsRoot) return
      server.middlewares.use("/pdfjs/cmaps/", (req, res, next) => {
        const file = join(pdfjsRoot, "cmaps", req.url.replace(/^\/+/, ""))
        if (!existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader("Content-Type", "application/octet-stream")
        createReadStream(file).pipe(res)
      })
      server.middlewares.use("/pdfjs/standard_fonts/", (req, res, next) => {
        const file = join(pdfjsRoot, "standard_fonts", req.url.replace(/^\/+/, ""))
        if (!existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader("Content-Type", "application/octet-stream")
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      if (!pdfjsRoot || !this.environment) return
      const outDir = this.environment.config?.build?.outDir
      if (!outDir) return
      copyDir(join(pdfjsRoot, "cmaps"), join(outDir, "pdfjs", "cmaps"))
      copyDir(join(pdfjsRoot, "standard_fonts"), join(outDir, "pdfjs", "standard_fonts"))
    },
  },
  tailwindcss(),
  solidPlugin(),
]
