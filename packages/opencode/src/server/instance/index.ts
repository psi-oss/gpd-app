import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { Effect } from "effect"
import z from "zod"
import { Format } from "../../format"
import { TuiRoutes } from "./tui"
import { Instance } from "../../project/instance"
import { Vcs } from "../../project/vcs"
import { Agent } from "../../agent/agent"
import { Skill } from "../../skill"
import { Global } from "../../global"
import { LSP } from "../../lsp"
import { Command } from "../../command"
import { QuestionRoutes } from "./question"
import { PermissionRoutes } from "./permission"
import { ProjectRoutes } from "./project"
import { SessionRoutes } from "./session"
import { PtyRoutes } from "./pty"
import { McpRoutes } from "./mcp"
import { FileRoutes } from "./file"
import { ConfigRoutes } from "./config"
import { ExperimentalRoutes } from "./experimental"
import { HealthRoutes } from "./health"
import { ProviderRoutes } from "./provider"
import { EventRoutes } from "./event"
import { WorkspaceRouterMiddleware } from "./middleware"
import { AppRuntime } from "@/effect/app-runtime"

export const InstanceRoutes = (upgrade: UpgradeWebSocket): Hono =>
  new Hono()
    .use(WorkspaceRouterMiddleware(upgrade))
    .route("/project", ProjectRoutes())
    .route("/pty", PtyRoutes(upgrade))
    .route("/config", ConfigRoutes())
    .route("/", HealthRoutes())
    .route("/experimental", ExperimentalRoutes())
    .route("/session", SessionRoutes())
    .route("/permission", PermissionRoutes())
    .route("/question", QuestionRoutes())
    .route("/provider", ProviderRoutes())
    .route("/", FileRoutes())
    .route("/", EventRoutes())
    .route("/mcp", McpRoutes())
    .route("/tui", TuiRoutes())
    .post(
      "/instance/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
        operationId: "instance.dispose",
        responses: {
          200: {
            description: "Instance disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.dispose()
        return c.json(true)
      },
    )
    .get(
      "/path",
      describeRoute({
        summary: "Get paths",
        description: "Retrieve the current working directory and related path information for the OpenCode instance.",
        operationId: "path.get",
        responses: {
          200: {
            description: "Path",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      home: z.string(),
                      state: z.string(),
                      config: z.string(),
                      worktree: z.string(),
                      directory: z.string(),
                    })
                    .meta({
                      ref: "Path",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: Instance.worktree,
          directory: Instance.directory,
        })
      },
    )
    .get(
      "/vcs",
      describeRoute({
        summary: "Get VCS info",
        description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
        operationId: "vcs.get",
        responses: {
          200: {
            description: "VCS info",
            content: {
              "application/json": {
                schema: resolver(Vcs.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(
          await AppRuntime.runPromise(
            Effect.gen(function* () {
              const vcs = yield* Vcs.Service
              const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
                concurrency: 2,
              })
              return { branch, default_branch }
            }),
          ),
        )
      },
    )
    .get(
      "/vcs/diff",
      describeRoute({
        summary: "Get VCS diff",
        description: "Retrieve the current git diff for the working tree or against the default branch.",
        operationId: "vcs.diff",
        responses: {
          200: {
            description: "VCS diff",
            content: {
              "application/json": {
                schema: resolver(Vcs.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          mode: Vcs.Mode,
        }),
      ),
      async (c) => {
        return c.json(
          await AppRuntime.runPromise(
            Effect.gen(function* () {
              const vcs = yield* Vcs.Service
              return yield* vcs.diff(c.req.valid("query").mode)
            }),
          ),
        )
      },
    )
    .get(
      "/command",
      describeRoute({
        summary: "List commands",
        description: "Get a list of all available commands in the OpenCode system.",
        operationId: "command.list",
        responses: {
          200: {
            description: "List of commands",
            content: {
              "application/json": {
                schema: resolver(Command.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const commands = await AppRuntime.runPromise(Command.Service.use((svc) => svc.list()))
        return c.json(commands)
      },
    )
    .get(
      "/agent",
      describeRoute({
        summary: "List agents",
        description: "Get a list of all available AI agents in the OpenCode system.",
        operationId: "app.agents",
        responses: {
          200: {
            description: "List of agents",
            content: {
              "application/json": {
                schema: resolver(Agent.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const modes = await AppRuntime.runPromise(Agent.Service.use((svc) => svc.list()))
        // Drop the `prompt` body from the listing. Each agent's prompt is the
        // raw .md frontmatter+body and totals ~1 MB across the 24 GPD agents.
        // No frontend consumer reads it (`Agent.prompt` is not referenced in
        // packages/app/src — verified 2026-05-08 against bootstrap.ts:329-340
        // `sameAgents`, local.tsx, message-timeline.tsx, session-header.tsx,
        // prompt-input.tsx). The runtime re-loads prompts from disk when an
        // agent fires, so the listing endpoint serving prompts was wasteful
        // anyway. Bigger than that: WebKit `fetch().text()` silently
        // truncates large bodies on macOS — observed dropping ~2 KB off a
        // 1.1 MB response, producing exactly the "JSON Parse error:
        // Unterminated string" toast users hit on bootstrap. Slimming the
        // payload to ~30 KB sidesteps the WebKit cap. If you ever need the
        // prompt body programmatically, add a dedicated `/agent/:id/prompt`
        // route — don't put it back here.
        const slim = modes.map(({ prompt: _prompt, ...rest }) => rest)
        return c.json(slim)
      },
    )
    .get(
      "/skill",
      describeRoute({
        summary: "List skills",
        description: "Get a list of all available skills in the OpenCode system.",
        operationId: "app.skills",
        responses: {
          200: {
            description: "List of skills",
            content: {
              "application/json": {
                schema: resolver(Skill.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const skills = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const skill = yield* Skill.Service
            return yield* skill.all()
          }),
        )
        return c.json(skills)
      },
    )
    .get(
      "/lsp",
      describeRoute({
        summary: "Get LSP status",
        description: "Get LSP server status",
        operationId: "lsp.status",
        responses: {
          200: {
            description: "LSP server status",
            content: {
              "application/json": {
                schema: resolver(LSP.Status.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const items = await AppRuntime.runPromise(LSP.Service.use((lsp) => lsp.status()))
        return c.json(items)
      },
    )
    .get(
      "/formatter",
      describeRoute({
        summary: "Get formatter status",
        description: "Get formatter status",
        operationId: "formatter.status",
        responses: {
          200: {
            description: "Formatter status",
            content: {
              "application/json": {
                schema: resolver(Format.Status.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Format.Service.use((svc) => svc.status())))
      },
    )
