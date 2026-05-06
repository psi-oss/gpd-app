import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Effect } from "effect"
import path from "path"
import z from "zod"
import { AppRuntime } from "../../effect/app-runtime"
import { Bus } from "../../bus"
import { File } from "../../file"
import { FileWatcher } from "../../file/watcher"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await AppRuntime.runPromise(
          Ripgrep.Service.use((svc) => svc.search({ cwd: Instance.directory, pattern, limit: 10 })),
        )
        return c.json(result.items)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await AppRuntime.runPromise(
          Effect.gen(function* () {
            return yield* File.Service.use((svc) =>
              svc.search({
                query,
                limit: limit ?? 10,
                dirs: dirs !== "false",
                type,
              }),
            )
          }),
        )
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await AppRuntime.runPromise(
          Effect.gen(function* () {
            return yield* File.Service.use((svc) => svc.list(path))
          }),
        )
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await AppRuntime.runPromise(
          Effect.gen(function* () {
            return yield* File.Service.use((svc) => svc.read(path))
          }),
        )
        return c.json(content)
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await AppRuntime.runPromise(
          Effect.gen(function* () {
            return yield* File.Service.use((svc) => svc.status())
          }),
        )
        return c.json(content)
      },
    )
    .post(
      "/file/write",
      describeRoute({
        summary: "Write file",
        description: "Replace a file with full text content using an expected content hash for optimistic concurrency.",
        operationId: "file.write",
        responses: {
          200: {
            description: "Write applied",
            content: {
              "application/json": {
                schema: resolver(File.WriteResult),
              },
            },
          },
          409: {
            description: "Conflict: current content hash no longer matches expectedHash",
            content: {
              "application/json": {
                schema: resolver(File.WriteConflict),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          expectedHash: z.string(),
          content: z.string(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await AppRuntime.runPromise(File.Service.use((svc) => svc.write(body)))
        if (!result.ok) {
          return c.json(result, 409)
        }
        const full = path.resolve(Instance.directory, body.path)
        await Bus.publish(File.Event.Edited, { file: full }).catch(() => {})
        await Bus.publish(FileWatcher.Event.Updated, { file: full, event: "change" }).catch(() => {})
        return c.json(result, 200)
      },
    )
    .post(
      "/file/edit-line",
      describeRoute({
        summary: "Edit a single line in a file",
        description:
          "Replace one line of a file with new content, using optimistic concurrency against the prior line value.",
        operationId: "file.editLine",
        responses: {
          200: {
            description: "Edit applied",
            content: {
              "application/json": {
                schema: resolver(File.EditLineResult),
              },
            },
          },
          409: {
            description: "Conflict: the current line no longer matches oldContent",
            content: {
              "application/json": {
                schema: resolver(File.EditLineConflict),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          line: z.number().int().positive(),
          oldContent: z.string(),
          newContent: z.string(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await AppRuntime.runPromise(File.Service.use((svc) => svc.editLine(body)))
        if (!result.ok) {
          return c.json(result, 409)
        }
        // Notify watchers so open editors refresh their view.
        const full = path.join(Instance.directory, body.path)
        await Bus.publish(File.Event.Edited, { file: full }).catch(() => {})
        await Bus.publish(FileWatcher.Event.Updated, { file: full, event: "change" }).catch(() => {})
        return c.json(result, 200)
      },
    )
    .post(
      "/file/delete",
      describeRoute({
        summary: "Delete file",
        description:
          "Remove a file under the project directory using an expected content hash for optimistic concurrency. " +
          "Direct user delete: not gated by the agent permission system (parallels /file/write).",
        operationId: "file.delete",
        responses: {
          200: {
            description: "File deleted",
            content: {
              "application/json": {
                schema: resolver(File.DeleteResult),
              },
            },
          },
          409: {
            description: "Conflict: current content hash no longer matches expectedHash",
            content: {
              "application/json": {
                schema: resolver(File.DeleteConflict),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          expectedHash: z.string(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await AppRuntime.runPromise(File.Service.use((svc) => svc.delete(body)))
        if (!result.ok) {
          return c.json(result, 409)
        }
        const full = path.resolve(Instance.directory, body.path)
        await Bus.publish(FileWatcher.Event.Updated, { file: full, event: "unlink" }).catch(() => {})
        return c.json(result, 200)
      },
    ),
)
