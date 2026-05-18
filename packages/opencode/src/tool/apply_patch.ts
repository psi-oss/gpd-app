import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import type { LSPClient } from "../lsp/client"
import { AppFileSystem } from "../filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { Format } from "../format"

const PatchParams = z.object({
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (params: z.infer<typeof PatchParams>, ctx: Tool.Context) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
      }> = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(Instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: "add",
              diff,
              additions,
              deletions,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            let oldContent = yield* afs.readFileString(filePath)
            let newContent = oldContent

            // Apply the update chunks to get new content. On
            // "Failed to find expected lines" — typically caused by an
            // out-of-band edit landing between our read at L108 and the
            // deriver's internal `readFileSync` — re-read the file once
            // and retry. If the on-disk content stabilised in the
            // intervening tick the second attempt succeeds; otherwise the
            // error surfaces unchanged, with an explicit hint to re-read.
            // ENG-561 fix #5.
            const tryDerive = () => {
              try {
                return { ok: true as const, fileUpdate: Patch.deriveNewContentsFromChunks(filePath, hunk.chunks) }
              } catch (error) {
                return { ok: false as const, error }
              }
            }
            let result = tryDerive()
            if (!result.ok && /Failed to find expected lines/.test(String(result.error))) {
              oldContent = yield* afs.readFileString(filePath)
              result = tryDerive()
              if (!result.ok) {
                return yield* Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${result.error}\n` +
                      `Hint: the file appears to have changed since the patch was generated. ` +
                      `Re-read ${filePath} and regenerate the patch with current context lines.`,
                  ),
                )
              }
            } else if (!result.ok) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${result.error}`))
            }
            newContent = result.fileUpdate.content

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const movePath = hunk.move_path ? path.resolve(Instance.directory, hunk.move_path) : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const contentToDelete = yield* afs
              .readFileString(filePath)
              .pipe(Effect.catch((error) => Effect.fail(new Error(`apply_patch verification failed: ${error}`))))
            // Skip diff for large/binary files to prevent storing hundreds of MB in SQLite.
            // V8 string limit is ~512MB; a 142MB binary file produces a 380MB+ diff.
            const DIFF_SIZE_LIMIT = 512 * 1024 // 512 KB
            const deleteDiff =
              contentToDelete.length > DIFF_SIZE_LIMIT
                ? ""
                : trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            // Create parent directories (recursive: true is safe on existing/root dirs)

            yield* afs.writeWithDirs(change.filePath, change.newContent)
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            yield* afs.writeWithDirs(change.filePath, change.newContent)
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              // Create parent directories (recursive: true is safe on existing/root dirs)

              yield* afs.writeWithDirs(change.movePath!, change.newContent)
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          // Format + edit-event publication must NOT keep the tool in
          // "Applying changes" forever (researchers reported the spinner
          // hanging after the file already landed). format.file shells out
          // to project formatters that can hang for many seconds on first
          // run; bus.publish is synchronous-ish but a downstream listener
          // could throw. Time-box the formatter and swallow listener
          // errors so the tool can return its summary while the writes
          // are already committed.
          yield* format.file(edited).pipe(
            Effect.timeout("5 seconds"),
            Effect.catch(() => Effect.void),
          )
          yield* bus.publish(File.Event.Edited, { file: edited }).pipe(Effect.catch(() => Effect.void))
        }
      }

      // Publish file change events
      for (const update of updates) {
        yield* bus.publish(FileWatcher.Event.Updated, update).pipe(Effect.catch(() => Effect.void))
      }

      // Notify LSP of file changes and collect diagnostics. Same rationale
      // as above: a stuck LSP server (e.g. pyright on a fresh project)
      // shouldn't leave the apply_patch tool in pending state forever.
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, true).pipe(Effect.catch(() => Effect.void))
      }
      const diagnostics = yield* lsp.diagnostics().pipe(
        Effect.timeout("3 seconds"),
        Effect.catch(() => Effect.succeed({} as Record<string, LSPClient.Diagnostic[]>)),
      )

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(Instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[AppFileSystem.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(Instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: PatchParams,
      execute: (params: z.infer<typeof PatchParams>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
