import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { AppFileSystem } from "@/filesystem"
import { Git } from "@/git"
import { Effect, Layer, Context } from "effect"
import * as Stream from "effect/Stream"
import { createHash, randomUUID } from "crypto"
import { formatPatch, structuredPatch } from "diff"
import fuzzysort from "fuzzysort"
import ignore from "ignore"
import { mkdir, open, rename, unlink } from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Protected } from "./protected"
import { Ripgrep } from "./ripgrep"

export namespace File {
  export const Info = z
    .object({
      path: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
      status: z.enum(["added", "deleted", "modified"]),
    })
    .meta({
      ref: "File",
    })

  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.enum(["file", "directory"]),
      ignored: z.boolean(),
    })
    .meta({
      ref: "FileNode",
    })
  export type Node = z.infer<typeof Node>

  export const Content = z
    .object({
      type: z.enum(["text", "binary"]),
      content: z.string(),
      hash: z.string(),
      diff: z.string().optional(),
      patch: z
        .object({
          oldFileName: z.string(),
          newFileName: z.string(),
          oldHeader: z.string().optional(),
          newHeader: z.string().optional(),
          hunks: z.array(
            z.object({
              oldStart: z.number(),
              oldLines: z.number(),
              newStart: z.number(),
              newLines: z.number(),
              lines: z.array(z.string()),
            }),
          ),
          index: z.string().optional(),
        })
        .optional(),
      encoding: z.literal("base64").optional(),
      mimeType: z.string().optional(),
    })
    .meta({
      ref: "FileContent",
    })
  export type Content = z.infer<typeof Content>

  export const Event = {
    Edited: BusEvent.define(
      "file.edited",
      z.object({
        file: z.string(),
      }),
    ),
  }

  export const EditLineResult = z
    .object({
      ok: z.literal(true),
      content: z.string(),
    })
    .meta({
      ref: "FileEditLineResult",
    })
  export type EditLineResult = z.infer<typeof EditLineResult>

  export const EditLineConflict = z
    .object({
      ok: z.literal(false),
      reason: z.literal("conflict"),
      currentContent: z.string(),
      currentLineContent: z.string().optional(),
    })
    .meta({
      ref: "FileEditLineConflict",
    })
  export type EditLineConflict = z.infer<typeof EditLineConflict>

  export const WriteResult = z
    .object({
      ok: z.literal(true),
      hash: z.string(),
    })
    .meta({
      ref: "FileWriteResult",
    })
  export type WriteResult = z.infer<typeof WriteResult>

  export const WriteConflict = z
    .object({
      ok: z.literal(false),
      reason: z.literal("conflict"),
      currentContent: z.string(),
      currentHash: z.string(),
    })
    .meta({
      ref: "FileWriteConflict",
    })
  export type WriteConflict = z.infer<typeof WriteConflict>

  export const DeleteResult = z
    .object({
      ok: z.literal(true),
    })
    .meta({
      ref: "FileDeleteResult",
    })
  export type DeleteResult = z.infer<typeof DeleteResult>

  export const DeleteConflict = z
    .object({
      ok: z.literal(false),
      reason: z.literal("conflict"),
      currentContent: z.string(),
      currentHash: z.string(),
    })
    .meta({
      ref: "FileDeleteConflict",
    })
  export type DeleteConflict = z.infer<typeof DeleteConflict>

  export const CreateResult = z
    .object({
      ok: z.literal(true),
      path: z.string(),
      type: z.enum(["file", "directory"]),
    })
    .meta({
      ref: "FileCreateResult",
    })
  export type CreateResult = z.infer<typeof CreateResult>

  export const CreateConflict = z
    .object({
      ok: z.literal(false),
      reason: z.literal("exists"),
    })
    .meta({
      ref: "FileCreateConflict",
    })
  export type CreateConflict = z.infer<typeof CreateConflict>

  const log = Log.create({ service: "file" })

  const binary = new Set([
    "exe",
    "dll",
    "pdb",
    "bin",
    "so",
    "dylib",
    "o",
    "a",
    "lib",
    "wav",
    "mp3",
    "ogg",
    "oga",
    "ogv",
    "ogx",
    "flac",
    "aac",
    "wma",
    "m4a",
    "weba",
    "mp4",
    "avi",
    "mov",
    "wmv",
    "flv",
    "webm",
    "mkv",
    "zip",
    "tar",
    "gz",
    "gzip",
    "bz",
    "bz2",
    "bzip",
    "bzip2",
    "7z",
    "rar",
    "xz",
    "lz",
    "z",
    "doc",
    "docx",
    "ppt",
    "pptx",
    "xls",
    "xlsx",
    "dmg",
    "iso",
    "img",
    "vmdk",
    "ttf",
    "otf",
    "woff",
    "woff2",
    "eot",
    "sqlite",
    "db",
    "mdb",
    "apk",
    "ipa",
    "aab",
    "xapk",
    "app",
    "pkg",
    "deb",
    "rpm",
    "snap",
    "flatpak",
    "appimage",
    "msi",
    "msp",
    "jar",
    "war",
    "ear",
    "class",
    "kotlin_module",
    "dex",
    "vdex",
    "odex",
    "oat",
    "art",
    "wasm",
    "wat",
    "bc",
    "ll",
    "s",
    "ko",
    "sys",
    "drv",
    "efi",
    "rom",
    "com",
  ])

  const image = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "bmp",
    "webp",
    "ico",
    "tif",
    "tiff",
    "svg",
    "svgz",
    "avif",
    "apng",
    "jxl",
    "heic",
    "heif",
    "raw",
    "cr2",
    "nef",
    "arw",
    "dng",
    "orf",
    "raf",
    "pef",
    "x3f",
  ])

  const text = new Set([
    "ts",
    "tsx",
    "mts",
    "cts",
    "mtsx",
    "ctsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "psm1",
    "cmd",
    "bat",
    "json",
    "jsonc",
    "json5",
    "yaml",
    "yml",
    "toml",
    "md",
    "mdx",
    "txt",
    "xml",
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "graphql",
    "gql",
    "sql",
    "ini",
    "cfg",
    "conf",
    "env",
  ])

  const textName = new Set([
    "dockerfile",
    "makefile",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".npmrc",
    ".nvmrc",
    ".prettierrc",
    ".eslintrc",
  ])

  const pdf = new Set(["pdf"])

  const mime: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    ico: "image/x-icon",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
    svgz: "image/svg+xml",
    avif: "image/avif",
    apng: "image/apng",
    jxl: "image/jxl",
    heic: "image/heic",
    heif: "image/heif",
  }

  type Entry = { files: string[]; dirs: string[] }

  const ext = (file: string) => path.extname(file).toLowerCase().slice(1)
  const name = (file: string) => path.basename(file).toLowerCase()
  const isImageByExtension = (file: string) => image.has(ext(file))
  const isPdfByExtension = (file: string) => pdf.has(ext(file))
  const isTextByExtension = (file: string) => text.has(ext(file))
  const isTextByName = (file: string) => textName.has(name(file))
  const isBinaryByExtension = (file: string) => binary.has(ext(file))
  const isImage = (mimeType: string) => mimeType.startsWith("image/")
  const getImageMimeType = (file: string) => mime[ext(file)] || "image/" + ext(file)
  const getPdfMimeType = (_file: string) => "application/pdf"
  const empty = createHash("sha256").update(new Uint8Array()).digest("hex")
  const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

  function shouldEncode(mimeType: string) {
    const type = mimeType.toLowerCase()
    log.debug("shouldEncode", { type })
    if (!type) return false
    if (type.startsWith("text/")) return false
    if (type.includes("charset=")) return false
    const top = type.split("/", 2)[0]
    return ["image", "audio", "video", "font", "model", "multipart"].includes(top)
  }

  const SNIFF_BYTES = 8192

  // Sniff a small prefix of bytes to detect binary content. Used as a fallback
  // for files whose extension/MIME does not classify them (e.g. extensionless
  // compiled executables), which would otherwise be read as a UTF-8 string and
  // fed to `git diff` — slow or hung for large binaries.
  function isBinaryBySniff(bytes: Uint8Array) {
    if (bytes.length === 0) return false
    if (bytes.includes(0)) return true
    return bytes.filter((b) => b < 9 || (b > 13 && b < 32)).length / bytes.length > 0.3
  }

  const hidden = (item: string) => {
    const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
    return normalized.split("/").some((part) => part.startsWith(".") && part.length > 1)
  }

  const sortHiddenLast = (items: string[], prefer: boolean) => {
    if (prefer) return items
    const visible: string[] = []
    const hiddenItems: string[] = []
    for (const item of items) {
      if (hidden(item)) hiddenItems.push(item)
      else visible.push(item)
    }
    return [...visible, ...hiddenItems]
  }

  interface State {
    cache: Entry
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<File.Info[]>
    readonly read: (file: string) => Effect.Effect<File.Content>
    readonly list: (dir?: string) => Effect.Effect<File.Node[]>
    readonly search: (input: {
      query: string
      limit?: number
      dirs?: boolean
      type?: "file" | "directory"
    }) => Effect.Effect<string[]>
    readonly editLine: (input: {
      path: string
      line: number
      oldContent: string
      newContent: string
    }) => Effect.Effect<EditLineResult | EditLineConflict>
    readonly write: (input: {
      path: string
      expectedHash: string
      content: string
    }) => Effect.Effect<WriteResult | WriteConflict>
    readonly delete: (input: { path: string; expectedHash: string }) => Effect.Effect<DeleteResult | DeleteConflict>
    readonly create: (input: {
      path: string
      type: "file" | "directory"
    }) => Effect.Effect<CreateResult | CreateConflict>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/File") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const appFs = yield* AppFileSystem.Service
      const rg = yield* Ripgrep.Service
      const git = yield* Git.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("File.state")(() =>
          Effect.succeed({
            cache: { files: [], dirs: [] } as Entry,
          }),
        ),
      )

      const scan = Effect.fn("File.scan")(function* () {
        if (Instance.directory === path.parse(Instance.directory).root) return
        // Apply the Protected-aware enumeration whenever the scan is rooted
        // at $HOME, NOT only when the special "global" project is in play.
        // A `git init` in the user's $HOME (e.g. dotfile management) makes
        // Project.fromDirectory register a non-global project with
        // worktree=$HOME — without this guard the else branch below runs
        // `rg.files({cwd: $HOME})` which walks ~/Music, ~/Pictures,
        // ~/Desktop, ~/Documents and triggers macOS TCC prompts on first
        // launch (especially on Sequoia/Tahoe where Music Library /
        // Photos Library files are gated). Reproduced on macOS 26.3.1 with
        // ~/Music/Music/Music Library.musiclibrary present.
        const isHomeScan = Instance.directory === Global.Path.home
        const next: Entry = { files: [], dirs: [] }

        if (isHomeScan) {
          const dirs = new Set<string>()
          const protectedNames = Protected.names()
          const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
          const shouldIgnoreName = (name: string) => name.startsWith(".") || protectedNames.has(name)
          const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)
          const top = yield* appFs.readDirectoryEntries(Instance.directory).pipe(Effect.orElseSucceed(() => []))

          for (const entry of top) {
            if (entry.type !== "directory") continue
            if (shouldIgnoreName(entry.name)) continue
            dirs.add(entry.name + "/")

            const base = path.join(Instance.directory, entry.name)
            const children = yield* appFs.readDirectoryEntries(base).pipe(Effect.orElseSucceed(() => []))
            for (const child of children) {
              if (child.type !== "directory") continue
              if (shouldIgnoreNested(child.name)) continue
              dirs.add(entry.name + "/" + child.name + "/")
            }
          }

          next.dirs = Array.from(dirs).toSorted()
        } else {
          const files = yield* rg.files({ cwd: Instance.directory }).pipe(
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const seen = new Set<string>()
          for (const file of files) {
            next.files.push(file)
            let current = file
            while (true) {
              const dir = path.dirname(current)
              if (dir === ".") break
              if (dir === current) break
              current = dir
              if (seen.has(dir)) continue
              seen.add(dir)
              next.dirs.push(dir + "/")
            }
          }
        }

        const s = yield* InstanceState.get(state)
        s.cache = next
      })

      let cachedScan = yield* Effect.cached(scan().pipe(Effect.catchCause(() => Effect.void)))

      const ensure = Effect.fn("File.ensure")(function* () {
        yield* cachedScan
        cachedScan = yield* Effect.cached(scan().pipe(Effect.catchCause(() => Effect.void)))
      })

      const gitText = Effect.fnUntraced(function* (args: string[]) {
        return (yield* git.run(args, { cwd: Instance.directory })).text()
      })

      const init = Effect.fn("File.init")(function* () {
        yield* ensure()
      })

      const status = Effect.fn("File.status")(function* () {
        if (Instance.project.vcs !== "git") return []

        const diffOutput = yield* gitText([
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.quotepath=false",
          "diff",
          "--numstat",
          "HEAD",
        ])

        const changed: File.Info[] = []

        if (diffOutput.trim()) {
          for (const line of diffOutput.trim().split("\n")) {
            const [added, removed, file] = line.split("\t")
            changed.push({
              path: file,
              added: added === "-" ? 0 : parseInt(added, 10),
              removed: removed === "-" ? 0 : parseInt(removed, 10),
              status: "modified",
            })
          }
        }

        const untrackedOutput = yield* gitText([
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.quotepath=false",
          "ls-files",
          "--others",
          "--exclude-standard",
        ])

        if (untrackedOutput.trim()) {
          for (const file of untrackedOutput.trim().split("\n")) {
            const content = yield* appFs
              .readFileString(path.join(Instance.directory, file))
              .pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)))
            if (content === undefined) continue
            changed.push({
              path: file,
              added: content.split("\n").length,
              removed: 0,
              status: "added",
            })
          }
        }

        const deletedOutput = yield* gitText([
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.quotepath=false",
          "diff",
          "--name-only",
          "--diff-filter=D",
          "HEAD",
        ])

        if (deletedOutput.trim()) {
          for (const file of deletedOutput.trim().split("\n")) {
            changed.push({
              path: file,
              added: 0,
              removed: 0,
              status: "deleted",
            })
          }
        }

        return changed.map((item) => {
          const full = path.isAbsolute(item.path) ? item.path : path.join(Instance.directory, item.path)
          return {
            ...item,
            path: path.relative(Instance.directory, full),
          }
        })
      })

      const read: Interface["read"] = Effect.fn("File.read")(function* (file: string) {
        using _ = log.time("read", { file })
        const full = path.join(Instance.directory, file)

        if (!Instance.containsPath(full)) throw new Error("Access denied: path escapes project directory")

        if (isImageByExtension(file)) {
          const exists = yield* appFs.existsSafe(full)
          if (exists) {
            const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
            return {
              type: "text" as const,
              content: Buffer.from(bytes).toString("base64"),
              hash: hash(bytes),
              mimeType: getImageMimeType(file),
              encoding: "base64" as const,
            }
          }
          return { type: "text" as const, content: "", hash: empty }
        }

        if (isPdfByExtension(file)) {
          const exists = yield* appFs.existsSafe(full)
          if (exists) {
            const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
            return {
              type: "text" as const,
              content: Buffer.from(bytes).toString("base64"),
              hash: hash(bytes),
              mimeType: getPdfMimeType(file),
              encoding: "base64" as const,
            }
          }
          return { type: "text" as const, content: "", hash: empty }
        }

        const knownText = isTextByExtension(file) || isTextByName(file)

        if (isBinaryByExtension(file) && !knownText) {
          const exists = yield* appFs.existsSafe(full)
          const bytes = exists
            ? yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
            : new Uint8Array()
          return { type: "binary" as const, content: "", hash: hash(bytes) }
        }

        const exists = yield* appFs.existsSafe(full)
        if (!exists) return { type: "text" as const, content: "", hash: empty }

        const mimeType = AppFileSystem.mimeType(full)
        const encode = knownText ? false : shouldEncode(mimeType)

        if (encode && !isImage(mimeType)) {
          const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
          return { type: "binary" as const, content: "", hash: hash(bytes), mimeType }
        }

        if (encode) {
          const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
          return {
            type: "text" as const,
            content: Buffer.from(bytes).toString("base64"),
            hash: hash(bytes),
            mimeType,
            encoding: "base64" as const,
          }
        }

        if (!knownText) {
          const sniff = yield* Effect.scoped(
            Effect.acquireRelease(
              Effect.promise(() => open(full, "r")),
              (fh) => Effect.promise(() => fh.close()),
            ).pipe(
              Effect.flatMap((fh) =>
                Effect.promise(async () => {
                  const buf = new Uint8Array(SNIFF_BYTES)
                  const result = await fh.read(buf, 0, SNIFF_BYTES, 0)
                  return buf.subarray(0, result.bytesRead)
                }),
              ),
            ),
          ).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
          if (isBinaryBySniff(sniff)) {
            const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
            return { type: "binary" as const, content: "", hash: hash(bytes), mimeType }
          }
        }

        const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
        const content = Buffer.from(bytes).toString("utf8")
        const digest = hash(bytes)

        if (Instance.project.vcs === "git") {
          let diff = yield* gitText(["-c", "core.fsmonitor=false", "diff", "--", file])
          if (!diff.trim()) {
            diff = yield* gitText(["-c", "core.fsmonitor=false", "diff", "--staged", "--", file])
          }
          if (diff.trim()) {
            const original = yield* git.show(Instance.directory, "HEAD", file)
            const patch = structuredPatch(file, file, original, content, "old", "new", {
              context: Infinity,
              ignoreWhitespace: true,
            })
            return { type: "text" as const, content, hash: digest, patch, diff: formatPatch(patch) }
          }
          return { type: "text" as const, content, hash: digest }
        }

        return { type: "text" as const, content, hash: digest }
      })

      const list = Effect.fn("File.list")(function* (dir?: string) {
        const exclude = [".git", ".DS_Store"]
        let ignored = (_: string) => false
        if (Instance.project.vcs === "git") {
          const ig = ignore()
          const gitignore = path.join(Instance.project.worktree, ".gitignore")
          const gitignoreText = yield* appFs.readFileString(gitignore).pipe(Effect.catch(() => Effect.succeed("")))
          if (gitignoreText) ig.add(gitignoreText)
          const ignoreFile = path.join(Instance.project.worktree, ".ignore")
          const ignoreText = yield* appFs.readFileString(ignoreFile).pipe(Effect.catch(() => Effect.succeed("")))
          if (ignoreText) ig.add(ignoreText)
          ignored = ig.ignores.bind(ig)
        }

        const resolved = dir ? path.join(Instance.directory, dir) : Instance.directory
        if (!Instance.containsPath(resolved)) throw new Error("Access denied: path escapes project directory")

        const entries = yield* appFs.readDirectoryEntries(resolved).pipe(Effect.orElseSucceed(() => []))

        const nodes: File.Node[] = []
        for (const entry of entries) {
          if (exclude.includes(entry.name)) continue
          const absolute = path.join(resolved, entry.name)
          const file = path.relative(Instance.directory, absolute)
          const type = entry.type === "directory" ? "directory" : "file"
          nodes.push({
            name: entry.name,
            path: file,
            absolute,
            type,
            ignored: ignored(type === "directory" ? file + "/" : file),
          })
        }
        return nodes.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      })

      const search = Effect.fn("File.search")(function* (input: {
        query: string
        limit?: number
        dirs?: boolean
        type?: "file" | "directory"
      }) {
        yield* ensure()
        const { cache } = yield* InstanceState.get(state)

        const query = input.query.trim()
        const limit = input.limit ?? 100
        const kind = input.type ?? (input.dirs === false ? "file" : "all")
        log.info("search", { query, kind })

        const preferHidden = query.startsWith(".") || query.includes("/.")

        if (!query) {
          if (kind === "file") return cache.files.slice(0, limit)
          return sortHiddenLast(cache.dirs.toSorted(), preferHidden).slice(0, limit)
        }

        const items =
          kind === "file" ? cache.files : kind === "directory" ? cache.dirs : [...cache.files, ...cache.dirs]

        const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
        const sorted = fuzzysort.go(query, items, { limit: searchLimit }).map((item) => item.target)
        const output = kind === "directory" ? sortHiddenLast(sorted, preferHidden).slice(0, limit) : sorted

        log.info("search", { query, kind, results: output.length })
        return output
      })

      const editLine = Effect.fn("File.editLine")(function* (input: {
        path: string
        line: number
        oldContent: string
        newContent: string
      }) {
        const full = path.join(Instance.directory, input.path)

        if (!Instance.containsPath(full)) throw new Error("Access denied: path escapes project directory")
        if (input.line < 1) throw new Error("Line numbers are 1-indexed")
        if (input.oldContent.includes("\n") || input.newContent.includes("\n")) {
          throw new Error("editLine only supports single-line edits")
        }

        const stat = yield* appFs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!stat) throw new Error(`File not found: ${input.path}`)
        if (stat.type === "Directory") throw new Error(`Path is a directory, not a file: ${input.path}`)

        const current = yield* appFs.readFileString(full).pipe(
          Effect.orDie,
        )
        const ending = current.includes("\r\n") ? "\r\n" : "\n"
        const lines = current.split(/\r?\n/)
        // Preserve trailing-newline convention: if the file ends with a newline, split produces
        // a trailing empty element. Don't treat that as an editable line.
        const editableCount = current.endsWith(ending) || current.endsWith("\n") ? lines.length - 1 : lines.length

        if (input.line > editableCount) {
          return {
            ok: false as const,
            reason: "conflict" as const,
            currentContent: current,
          } satisfies EditLineConflict
        }

        const actualLine = lines[input.line - 1] ?? ""
        if (actualLine !== input.oldContent) {
          return {
            ok: false as const,
            reason: "conflict" as const,
            currentContent: current,
            currentLineContent: actualLine,
          } satisfies EditLineConflict
        }

        lines[input.line - 1] = input.newContent
        const next = lines.join(ending)
        yield* appFs.writeFileString(full, next).pipe(Effect.orDie)

        return {
          ok: true as const,
          content: next,
        } satisfies EditLineResult
      })

      const write: Interface["write"] = Effect.fn("File.write")(function* (input) {
        const full = path.resolve(Instance.directory, input.path)
        const dir = path.dirname(full)
        const inside = (item: string) => {
          const rel = path.relative(Instance.directory, item)
          return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
        }

        if (!inside(full)) throw new Error("Access denied: path escapes project directory")
        if (!inside(dir)) throw new Error("Access denied: path escapes project directory")

        const parent = yield* appFs.stat(dir).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!parent) throw new Error(`Directory not found: ${path.dirname(input.path)}`)
        if (parent.type !== "Directory") throw new Error(`Parent path is not a directory: ${path.dirname(input.path)}`)

        const stat = yield* appFs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (stat?.type === "Directory") throw new Error(`Path is a directory, not a file: ${input.path}`)

        const bytes = stat
          ? yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
          : new Uint8Array()
        const currentHash = hash(bytes)
        const currentContent = Buffer.from(bytes).toString("utf8")

        if (currentHash !== input.expectedHash) {
          return {
            ok: false as const,
            reason: "conflict" as const,
            currentContent,
            currentHash,
          } satisfies WriteConflict
        }

        const tmp = path.join(dir, `.${path.basename(full)}.tmp.${process.pid}.${randomUUID()}`)
        yield* appFs.writeFileString(tmp, input.content).pipe(Effect.orDie)
        yield* Effect.tryPromise({
          try: () => rename(tmp, full),
          catch: (cause) => cause,
        }).pipe(Effect.tapError(() => Effect.promise(() => unlink(tmp).catch(() => undefined))), Effect.orDie)

        return {
          ok: true as const,
          hash: hash(input.content),
        } satisfies WriteResult
      })

      const remove: Interface["delete"] = Effect.fn("File.delete")(function* (input) {
        const full = path.resolve(Instance.directory, input.path)
        const inside = (item: string) => {
          const rel = path.relative(Instance.directory, item)
          return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
        }

        if (!inside(full)) throw new Error("Access denied: path escapes project directory")

        const stat = yield* appFs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!stat) throw new Error(`File not found: ${input.path}`)
        if (stat.type === "Directory") throw new Error(`Path is a directory, not a file: ${input.path}`)

        const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
        const currentHash = hash(bytes)
        if (currentHash !== input.expectedHash) {
          return {
            ok: false as const,
            reason: "conflict" as const,
            currentContent: Buffer.from(bytes).toString("utf8"),
            currentHash,
          } satisfies DeleteConflict
        }

        yield* Effect.tryPromise({
          try: () => unlink(full),
          catch: (cause) => cause,
        }).pipe(Effect.orDie)

        return { ok: true as const } satisfies DeleteResult
      })

      const create: Interface["create"] = Effect.fn("File.create")(function* (input) {
        const full = path.resolve(Instance.directory, input.path)
        const parentDir = path.dirname(full)
        const inside = (item: string) => {
          const rel = path.relative(Instance.directory, item)
          return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
        }

        if (!inside(full)) throw new Error("Access denied: path escapes project directory")
        if (!inside(parentDir)) throw new Error("Access denied: path escapes project directory")

        const existing = yield* appFs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (existing) {
          return { ok: false as const, reason: "exists" as const } satisfies CreateConflict
        }

        if (input.type === "directory") {
          yield* Effect.tryPromise({
            try: () => mkdir(full, { recursive: true }),
            catch: (cause) => cause,
          }).pipe(Effect.orDie)
          return {
            ok: true as const,
            path: input.path,
            type: "directory" as const,
          } satisfies CreateResult
        }

        const parent = yield* appFs.stat(parentDir).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!parent) throw new Error(`Directory not found: ${path.dirname(input.path)}`)
        if (parent.type !== "Directory") throw new Error(`Parent path is not a directory: ${path.dirname(input.path)}`)

        const tmp = path.join(parentDir, `.${path.basename(full)}.tmp.${process.pid}.${randomUUID()}`)
        yield* appFs.writeFileString(tmp, "").pipe(Effect.orDie)
        yield* Effect.tryPromise({
          try: () => rename(tmp, full),
          catch: (cause) => cause,
        }).pipe(Effect.tapError(() => Effect.promise(() => unlink(tmp).catch(() => undefined))), Effect.orDie)

        return {
          ok: true as const,
          path: input.path,
          type: "file" as const,
        } satisfies CreateResult
      })

      log.info("init")
      return Service.of({ init, status, read, list, search, editLine, write, delete: remove, create })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Git.defaultLayer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export function init() {
    return runPromise((svc) => svc.init())
  }

  export async function status() {
    return runPromise((svc) => svc.status())
  }

  export async function read(file: string): Promise<Content> {
    return runPromise((svc) => svc.read(file))
  }

  export async function list(dir?: string) {
    return runPromise((svc) => svc.list(dir))
  }

  export async function search(input: { query: string; limit?: number; dirs?: boolean; type?: "file" | "directory" }) {
    return runPromise((svc) => svc.search(input))
  }

  export async function editLine(input: {
    path: string
    line: number
    oldContent: string
    newContent: string
  }): Promise<EditLineResult | EditLineConflict> {
    return runPromise((svc) => svc.editLine(input))
  }

  export async function write(input: {
    path: string
    expectedHash: string
    content: string
  }): Promise<WriteResult | WriteConflict> {
    return runPromise((svc) => svc.write(input))
  }

  export async function remove(input: { path: string; expectedHash: string }): Promise<DeleteResult | DeleteConflict> {
    return runPromise((svc) => svc.delete(input))
  }

  export async function create(input: {
    path: string
    type: "file" | "directory"
  }): Promise<CreateResult | CreateConflict> {
    return runPromise((svc) => svc.create(input))
  }
}
