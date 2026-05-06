import z from "zod"
import os from "os"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { Npm } from "../npm"
import { Hash } from "../util/hash"
import { Plugin } from "../plugin"
import { NamedError } from "@opencode-ai/util/error"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import { ModelsDev } from "./models"
import { gpdUsesResponsesApi, resolveGpdProviderModels } from "./gpd-models"
import { Auth } from "../auth"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { Global } from "../global"
import path from "path"
import { Effect, Layer, Context } from "effect"
import { EffectLogger } from "@/effect/logger"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@/filesystem"
import { isRecord } from "@/util/record"

// Direct imports for bundled providers
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "./sdk/copilot"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createVenice } from "venice-ai-sdk-provider"
import { createAlibaba } from "@ai-sdk/alibaba"
import {
  createGitLab,
  VERSION as GITLAB_PROVIDER_VERSION,
  isWorkflowModel,
  discoverWorkflowModels,
} from "gitlab-ai-provider"
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { GoogleAuth } from "google-auth-library"
import { ProviderTransform } from "./transform"
import { Installation } from "../installation"
import { ModelID, ProviderID } from "./schema"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  function shouldUseCopilotResponsesApi(modelID: string): boolean {
    const match = /^gpt-(\d+)/.exec(modelID)
    if (!match) return false
    return Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")
  }

  function shouldLogGpdRequestShape(model: { providerID: string; id: string; api: { id: string } }) {
    return (
      process.env.OPENCODE_GPD_LOG_REQUEST_SHAPES === "1" &&
      model.providerID === "gpd" &&
      (model.id.startsWith("gpt-5.5") || model.api.id.startsWith("gpt-5.5"))
    )
  }

  function countBy(input: Record<string, number>, key: unknown) {
    const normalized = typeof key === "string" && key.length > 0 ? key : "<missing>"
    input[normalized] = (input[normalized] ?? 0) + 1
  }

  function jsonBytes(input: unknown) {
    try {
      return new TextEncoder().encode(JSON.stringify(input)).byteLength
    } catch {
      return 0
    }
  }

  function stringChars(input: unknown) {
    return typeof input === "string" ? input.length : 0
  }

  function requestPath(input: RequestInfo | URL) {
    let path = String(input)
    try {
      path = new URL(String(input)).pathname
    } catch {}
    return path
  }

  function isOpenAIResponsesPost(input: RequestInfo | URL, opts: BunFetchRequestInit) {
    return opts.method === "POST" && requestPath(input).endsWith("/responses")
  }

  function summarizeCallIds(input: unknown) {
    const summary = {
      total: 0,
      normalized: 0,
      overlong: 0,
      invalidChars: 0,
      maxChars: 0,
      samplePaths: [] as string[],
    }

    function scan(value: unknown, path: string) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => scan(item, `${path}[${index}]`))
        return
      }
      if (!value || typeof value !== "object") return

      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key
        if (key === "call_id" && typeof child === "string") {
          summary.total++
          summary.maxChars = Math.max(summary.maxChars, child.length)
          if (child.length > ProviderTransform.OPENAI_RESPONSES_TOOL_CALL_ID_MAX) summary.overlong++
          if (!/^[a-zA-Z0-9_-]+$/.test(child)) summary.invalidChars++
          const normalized = ProviderTransform.normalizeOpenAIResponsesToolCallId(child)
          if (normalized !== child) {
            summary.normalized++
            if (summary.samplePaths.length < 5) summary.samplePaths.push(childPath)
          }
          continue
        }
        scan(child, childPath)
      }
    }

    scan(input, "")
    return summary
  }

  /**
   * Recursively delete any `ref` keys from a JSON-Schema-shaped value.
   *
   * Effect-Schema → zod (`util/effect-zod.ts:walk`) annotates schemas with
   * `meta({ ref })` so `hey-api/openapi-ts` can extract named top-level
   * types in the generated SDK. The same `ref` key surfaces in the JSON
   * Schema attached to outgoing OpenAI tool definitions, where OpenAI's
   * Responses API rejects it with a deterministic `server_error` at high
   * / xhigh reasoning_effort. This walker is the second half of the fix
   * — keep it in sync with `effect-zod.ts:walk`.
   *
   * Returns `true` if any `ref` was removed.
   */
  export function stripJsonSchemaRefs(value: unknown): boolean {
    let mutated = false
    const visit = (node: any): void => {
      if (!node || typeof node !== "object") return
      if (Array.isArray(node)) {
        for (const child of node) visit(child)
        return
      }
      if ("ref" in node) {
        delete node.ref
        mutated = true
      }
      for (const key of Object.keys(node)) {
        visit(node[key])
      }
    }
    visit(value)
    return mutated
  }

  export function normalizeOpenAIResponsesCallIds(rawBody: unknown) {
    if (typeof rawBody !== "string") return undefined

    let body: any
    try {
      body = JSON.parse(rawBody)
    } catch {
      return undefined
    }

    const ids = new Map<string, string>()
    const normalize = (id: string) => {
      const existing = ids.get(id)
      if (existing) return existing
      const next = ProviderTransform.normalizeOpenAIResponsesToolCallId(id)
      ids.set(id, next)
      return next
    }

    function scan(value: unknown) {
      if (Array.isArray(value)) {
        for (const item of value) scan(item)
        return
      }
      if (!value || typeof value !== "object") return

      for (const [key, child] of Object.entries(value)) {
        if (key === "call_id" && typeof child === "string") {
          const record = value as Record<string, unknown>
          record[key] = normalize(child)
          continue
        }
        scan(child)
      }
    }

    const before = summarizeCallIds(body)
    if (before.normalized === 0) return { body: rawBody, summary: before, changed: false }

    scan(body)
    return {
      body: JSON.stringify(body),
      summary: before,
      changed: true,
    }
  }

  function summarizeProviderRequestBody(rawBody: unknown) {
    if (typeof rawBody !== "string") {
      return {
        parseable: false,
        bodyType: typeof rawBody,
      }
    }

    let body: any
    try {
      body = JSON.parse(rawBody)
    } catch {
      return {
        parseable: false,
        bodyBytes: new TextEncoder().encode(rawBody).byteLength,
      }
    }

    const input = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : []
    const roles: Record<string, number> = {}
    const itemTypes: Record<string, number> = {}
    const partTypes: Record<string, number> = {}
    let textChars = 0
    let imageParts = 0
    let fileParts = 0
    let toolCalls = 0
    let toolResults = 0
    let reasoningParts = 0
    let encryptedReasoningParts = 0

    function scanPart(part: any) {
      if (!part || typeof part !== "object") {
        textChars += stringChars(part)
        return
      }

      countBy(partTypes, part.type)
      switch (part.type) {
        case "text":
        case "input_text":
        case "output_text":
          textChars += stringChars(part.text)
          break
        case "image":
        case "input_image":
          imageParts++
          break
        case "file":
        case "input_file":
          fileParts++
          break
        case "tool-call":
        case "function_call":
          toolCalls++
          textChars += stringChars(part.input)
          textChars += stringChars(part.arguments)
          break
        case "tool-result":
        case "function_call_output":
          toolResults++
          textChars += stringChars(part.output)
          break
        case "reasoning":
          reasoningParts++
          if (typeof part.encrypted_content === "string") encryptedReasoningParts++
          textChars += stringChars(part.summary)
          break
      }
    }

    for (const item of input) {
      if (!item || typeof item !== "object") {
        textChars += stringChars(item)
        continue
      }

      countBy(roles, item.role)
      countBy(itemTypes, item.type)
      if (typeof item.content === "string") {
        textChars += item.content.length
      } else if (Array.isArray(item.content)) {
        for (const part of item.content) scanPart(part)
      }
      if (item.type === "function_call") toolCalls++
      if (item.type === "function_call_output") toolResults++
      if (item.type === "reasoning") {
        reasoningParts++
        if (typeof item.encrypted_content === "string") encryptedReasoningParts++
      }
    }

    const tools = Array.isArray(body.tools) ? body.tools : []
    const toolSizes: Array<{ name: string; bytes: number }> = tools
      .map((tool: any) => ({
        name: typeof tool?.name === "string" ? tool.name : typeof tool?.function?.name === "string" ? tool.function.name : "",
        bytes: jsonBytes(tool),
      }))
      .sort((a: { name: string; bytes: number }, b: { name: string; bytes: number }) => b.bytes - a.bytes)

    const summary = {
      parseable: true,
      bodyBytes: new TextEncoder().encode(rawBody).byteLength,
      bodyKeys: Object.keys(body).sort(),
      endpointShape: Array.isArray(body.input) ? "responses" : Array.isArray(body.messages) ? "chat" : "unknown",
      model: body.model,
      instructionsChars: stringChars(body.instructions),
      inputCount: input.length,
      inputRoles: roles,
      inputItemTypes: itemTypes,
      inputPartTypes: partTypes,
      textChars,
      imageParts,
      fileParts,
      toolCalls,
      toolResults,
      reasoningParts,
      encryptedReasoningParts,
      toolCount: tools.length,
      toolBytes: jsonBytes(tools),
      largestTools: toolSizes.slice(0, 5),
      include: Array.isArray(body.include) ? body.include : undefined,
      reasoning: body.reasoning
        ? {
            effort: body.reasoning.effort,
            summary: body.reasoning.summary,
          }
        : undefined,
      maxOutputTokens: body.max_output_tokens ?? body.maxOutputTokens,
      temperature: body.temperature,
      topP: body.top_p ?? body.topP,
      store: body.store,
      parallelToolCalls: body.parallel_tool_calls,
      toolChoice: body.tool_choice,
      callIds: summarizeCallIds(body),
      metadataKeys: body.metadata && typeof body.metadata === "object" ? Object.keys(body.metadata).sort() : undefined,
      previousResponseId: typeof body.previous_response_id === "string" ? "<present>" : undefined,
    }

    return {
      ...summary,
      shapeHash: Hash.fast(JSON.stringify(summary)),
    }
  }

  function wrapSSE(res: Response, ms: number, ctl: AbortController) {
    if (typeof ms !== "number" || ms <= 0) return res
    if (!res.body) return res
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            const err = new Error("SSE read timed out")
            ctl.abort(err)
            void reader.cancel(err)
            reject(err)
          }, ms)

          reader.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        })

        if (part.done) {
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        ctl.abort(reason)
        await reader.cancel(reason)
      },
    })

    return new Response(body, {
      headers: new Headers(res.headers),
      status: res.status,
      statusText: res.statusText,
    })
  }

  type BundledSDK = {
    languageModel(modelId: string): LanguageModelV3
  }

  const BUNDLED_PROVIDERS: Record<string, (options: any) => BundledSDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "@ai-sdk/vercel": createVercel,
    "@ai-sdk/alibaba": createAlibaba,
    "gitlab-ai-provider": createGitLab,
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
    "venice-ai-sdk-provider": createVenice,
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
  type CustomDiscoverModels = () => Promise<Record<string, Model>>
  type CustomLoader = (provider: Info) => Effect.Effect<{
    autoload: boolean
    getModel?: CustomModelLoader
    vars?: CustomVarsLoader
    options?: Record<string, any>
    discoverModels?: CustomDiscoverModels
  }>

  type CustomDep = {
    auth: (id: string) => Effect.Effect<Auth.Info | undefined>
    config: () => Effect.Effect<Config.Info>
    env: () => Effect.Effect<Record<string, string | undefined>>
    get: (key: string) => Effect.Effect<string | undefined>
  }

  function useLanguageModel(sdk: any) {
    return sdk.responses === undefined && sdk.chat === undefined
  }

  function custom(dep: CustomDep): Record<string, CustomLoader> {
    return {
      anthropic: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
            },
          },
        }),
      opencode: Effect.fnUntraced(function* (input: Info) {
        const env = yield* dep.env()
        const hasKey = iife(() => {
          if (input.env.some((item) => env[item])) return true
          return false
        })
        const ok =
          hasKey ||
          Boolean(yield* dep.auth(input.id)) ||
          Boolean((yield* dep.config()).provider?.["opencode"]?.options?.apiKey)

        if (!ok) {
          for (const [key, value] of Object.entries(input.models)) {
            if (value.cost.input === 0) continue
            delete input.models[key]
          }
        }

        return {
          autoload: Object.keys(input.models).length > 0,
          options: ok ? {} : { apiKey: "public" },
        }
      }),
      openai: () =>
        Effect.succeed({
          autoload: false,
          async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
            return sdk.responses(modelID)
          },
          options: {},
        }),
      xai: () =>
        Effect.succeed({
          autoload: false,
          async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
            return sdk.responses(modelID)
          },
          options: {},
        }),
      "github-copilot": () =>
        Effect.succeed({
          autoload: false,
          async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
            if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
            return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
          },
          options: {},
        }),
      // GPD provider: per-model SDK selection between OpenAI Responses API
      // (for GPT-5.x reasoning models, where summary text only streams via
      // `/v1/responses`) and the default openai-compatible chat path (for
      // Claude/Gemini and any non-reasoning OpenAI variant). The two GPT-5
      // families (5.4*, 5.5*) plus gpt-5.3-codex are listed in
      // `gpdUsesResponsesApi`; everything else falls through to chat. The
      // SDK is `@ai-sdk/openai` whenever Responses is needed (assigned in
      // the per-model `npm` resolution loop further down) and
      // `@ai-sdk/openai-compatible` otherwise. LiteLLM proxies both
      // endpoint shapes faithfully against the same `LITELLM_URL/v1` base
      // and the same virtual key — no auth/identifier changes.
      gpd: () =>
        Effect.succeed({
          autoload: false,
          async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
            if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
            return gpdUsesResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
          },
          options: {},
        }),
      azure: Effect.fnUntraced(function* (provider: Info) {
        const env = yield* dep.env()
        const resource = iife(() => {
          const name = provider.options?.resourceName
          if (typeof name === "string" && name.trim() !== "") return name
          return env["AZURE_RESOURCE_NAME"]
        })

        return {
          autoload: false,
          async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
            if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
            if (options?.["useCompletionUrls"]) {
              return sdk.chat(modelID)
            } else {
              return sdk.responses(modelID)
            }
          },
          options: {},
          vars(_options) {
            return {
              ...(resource && { AZURE_RESOURCE_NAME: resource }),
            }
          },
        }
      }),
      "azure-cognitive-services": Effect.fnUntraced(function* () {
        const resourceName = yield* dep.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
        return {
          autoload: false,
          async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
            if (useLanguageModel(sdk)) return sdk.languageModel(modelID)
            if (options?.["useCompletionUrls"]) {
              return sdk.chat(modelID)
            } else {
              return sdk.responses(modelID)
            }
          },
          options: {
            baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
          },
        }
      }),
      "amazon-bedrock": Effect.fnUntraced(function* () {
        const providerConfig = (yield* dep.config()).provider?.["amazon-bedrock"]
        const auth = yield* dep.auth("amazon-bedrock")
        const env = yield* dep.env()

        // Region precedence: 1) config file, 2) env var, 3) default
        const configRegion = providerConfig?.options?.region
        const envRegion = env["AWS_REGION"]
        const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

        // Profile: config file takes precedence over env var
        const configProfile = providerConfig?.options?.profile
        const envProfile = env["AWS_PROFILE"]
        const profile = configProfile ?? envProfile

        const awsAccessKeyId = env["AWS_ACCESS_KEY_ID"]

        // TODO: Using process.env directly because Env.set only updates a process.env shallow copy,
        // until the scope of the Env API is clarified (test only or runtime?)
        const awsBearerToken = iife(() => {
          const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
          if (envToken) return envToken
          if (auth?.type === "api") {
            process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
            return auth.key
          }
          return undefined
        })

        const awsWebIdentityTokenFile = env["AWS_WEB_IDENTITY_TOKEN_FILE"]

        const containerCreds = Boolean(
          process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
        )

        if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile && !containerCreds)
          return { autoload: false }

        const providerOptions: AmazonBedrockProviderSettings = {
          region: defaultRegion,
        }

        // Only use credential chain if no bearer token exists
        // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
        if (!awsBearerToken) {
          // Build credential provider options (only pass profile if specified)
          const credentialProviderOptions = profile ? { profile } : {}

          providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
        }

        // Add custom endpoint if specified (endpoint takes precedence over baseURL)
        const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
        if (endpoint) {
          providerOptions.baseURL = endpoint
        }

        return {
          autoload: true,
          options: providerOptions,
          async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
            // Skip region prefixing if model already has a cross-region inference profile prefix
            // Models from models.dev may already include prefixes like us., eu., global., etc.
            const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
            if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
              return sdk.languageModel(modelID)
            }

            // Region resolution precedence (highest to lowest):
            // 1. options.region from opencode.json provider config
            // 2. defaultRegion from AWS_REGION environment variable
            // 3. Default "us-east-1" (baked into defaultRegion)
            const region = options?.region ?? defaultRegion

            let regionPrefix = region.split("-")[0]

            switch (regionPrefix) {
              case "us": {
                const modelRequiresPrefix = [
                  "nova-micro",
                  "nova-lite",
                  "nova-pro",
                  "nova-premier",
                  "nova-2",
                  "claude",
                  "deepseek",
                ].some((m) => modelID.includes(m))
                const isGovCloud = region.startsWith("us-gov")
                if (modelRequiresPrefix && !isGovCloud) {
                  modelID = `${regionPrefix}.${modelID}`
                }
                break
              }
              case "eu": {
                const regionRequiresPrefix = [
                  "eu-west-1",
                  "eu-west-2",
                  "eu-west-3",
                  "eu-north-1",
                  "eu-central-1",
                  "eu-south-1",
                  "eu-south-2",
                ].some((r) => region.includes(r))
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                  modelID.includes(m),
                )
                if (regionRequiresPrefix && modelRequiresPrefix) {
                  modelID = `${regionPrefix}.${modelID}`
                }
                break
              }
              case "ap": {
                const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
                const isTokyoRegion = region === "ap-northeast-1"
                if (
                  isAustraliaRegion &&
                  ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
                ) {
                  regionPrefix = "au"
                  modelID = `${regionPrefix}.${modelID}`
                } else if (isTokyoRegion) {
                  // Tokyo region uses jp. prefix for cross-region inference
                  const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                    modelID.includes(m),
                  )
                  if (modelRequiresPrefix) {
                    regionPrefix = "jp"
                    modelID = `${regionPrefix}.${modelID}`
                  }
                } else {
                  // Other APAC regions use apac. prefix
                  const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                    modelID.includes(m),
                  )
                  if (modelRequiresPrefix) {
                    regionPrefix = "apac"
                    modelID = `${regionPrefix}.${modelID}`
                  }
                }
                break
              }
            }

            return sdk.languageModel(modelID)
          },
        }
      }),
      openrouter: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "HTTP-Referer": "https://opencode.ai/",
              "X-Title": "opencode",
            },
          },
        }),
      vercel: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "http-referer": "https://opencode.ai/",
              "x-title": "opencode",
            },
          },
        }),
      "google-vertex": Effect.fnUntraced(function* (provider: Info) {
        const env = yield* dep.env()
        const project =
          provider.options?.project ?? env["GOOGLE_CLOUD_PROJECT"] ?? env["GCP_PROJECT"] ?? env["GCLOUD_PROJECT"]

        const location = String(
          provider.options?.location ??
            env["GOOGLE_VERTEX_LOCATION"] ??
            env["GOOGLE_CLOUD_LOCATION"] ??
            env["VERTEX_LOCATION"] ??
            "us-central1",
        )

        const autoload = Boolean(project)
        if (!autoload) return { autoload: false }
        return {
          autoload: true,
          vars(_options: Record<string, any>) {
            const endpoint =
              location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
            return {
              ...(project && { GOOGLE_VERTEX_PROJECT: project }),
              GOOGLE_VERTEX_LOCATION: location,
              GOOGLE_VERTEX_ENDPOINT: endpoint,
            }
          },
          options: {
            project,
            location,
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              const auth = new GoogleAuth()
              const client = await auth.getApplicationDefault()
              const token = await client.credential.getAccessToken()

              const headers = new Headers(init?.headers)
              headers.set("Authorization", `Bearer ${token.token}`)

              return fetch(input, { ...init, headers })
            },
          },
          async getModel(sdk: any, modelID: string) {
            const id = String(modelID).trim()
            return sdk.languageModel(id)
          },
        }
      }),
      "google-vertex-anthropic": Effect.fnUntraced(function* () {
        const env = yield* dep.env()
        const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCP_PROJECT"] ?? env["GCLOUD_PROJECT"]
        const location = env["GOOGLE_CLOUD_LOCATION"] ?? env["VERTEX_LOCATION"] ?? "global"
        const autoload = Boolean(project)
        if (!autoload) return { autoload: false }
        return {
          autoload: true,
          options: {
            project,
            location,
          },
          async getModel(sdk: any, modelID) {
            const id = String(modelID).trim()
            return sdk.languageModel(id)
          },
        }
      }),
      "sap-ai-core": Effect.fnUntraced(function* () {
        const auth = yield* dep.auth("sap-ai-core")
        // TODO: Using process.env directly because Env.set only updates a shallow copy (not process.env),
        // until the scope of the Env API is clarified (test only or runtime?)
        const envServiceKey = iife(() => {
          const envAICoreServiceKey = process.env.AICORE_SERVICE_KEY
          if (envAICoreServiceKey) return envAICoreServiceKey
          if (auth?.type === "api") {
            process.env.AICORE_SERVICE_KEY = auth.key
            return auth.key
          }
          return undefined
        })
        const deploymentId = process.env.AICORE_DEPLOYMENT_ID
        const resourceGroup = process.env.AICORE_RESOURCE_GROUP

        return {
          autoload: !!envServiceKey,
          options: envServiceKey ? { deploymentId, resourceGroup } : {},
          async getModel(sdk: any, modelID: string) {
            return sdk(modelID)
          },
        }
      }),
      zenmux: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "HTTP-Referer": "https://opencode.ai/",
              "X-Title": "opencode",
            },
          },
        }),
      gitlab: Effect.fnUntraced(function* (input: Info) {
        const instanceUrl = (yield* dep.get("GITLAB_INSTANCE_URL")) || "https://gitlab.com"

        const auth = yield* dep.auth(input.id)
        const apiKey = yield* Effect.sync(() => {
          if (auth?.type === "oauth") return auth.access
          if (auth?.type === "api") return auth.key
          return undefined
        })
        const token = apiKey ?? (yield* dep.get("GITLAB_TOKEN"))

        const providerConfig = (yield* dep.config()).provider?.["gitlab"]

        const aiGatewayHeaders = {
          "User-Agent": `opencode/${Installation.VERSION} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
          "anthropic-beta": "context-1m-2025-08-07",
          ...(providerConfig?.options?.aiGatewayHeaders || {}),
        }

        const featureFlags = {
          duo_agent_platform_agentic_chat: true,
          duo_agent_platform: true,
          ...(providerConfig?.options?.featureFlags || {}),
        }

        return {
          autoload: !!token,
          options: {
            instanceUrl,
            apiKey: token,
            aiGatewayHeaders,
            featureFlags,
          },
          async getModel(sdk: ReturnType<typeof createGitLab>, modelID: string, options?: Record<string, any>) {
            if (modelID.startsWith("duo-workflow-")) {
              const workflowRef = options?.workflowRef as string | undefined
              // Use the static mapping if it exists, otherwise use duo-workflow with selectedModelRef
              const sdkModelID = isWorkflowModel(modelID) ? modelID : "duo-workflow"
              const model = sdk.workflowChat(sdkModelID, {
                featureFlags,
                workflowDefinition: options?.workflowDefinition as string | undefined,
              })
              if (workflowRef) {
                model.selectedModelRef = workflowRef
              }
              return model
            }
            return sdk.agenticChat(modelID, {
              aiGatewayHeaders,
              featureFlags,
            })
          },
          async discoverModels(): Promise<Record<string, Model>> {
            if (!apiKey) {
              log.info("gitlab model discovery skipped: no apiKey")
              return {}
            }

            try {
              const token = apiKey
              const getHeaders = (): Record<string, string> =>
                auth?.type === "api" ? { "PRIVATE-TOKEN": token } : { Authorization: `Bearer ${token}` }

              log.info("gitlab model discovery starting", { instanceUrl })
              const result = await discoverWorkflowModels(
                { instanceUrl, getHeaders },
                { workingDirectory: Instance.directory },
              )

              if (!result.models.length) {
                log.info("gitlab model discovery skipped: no models found", {
                  project: result.project
                    ? {
                        id: result.project.id,
                        path: result.project.pathWithNamespace,
                      }
                    : null,
                })
                return {}
              }

              const models: Record<string, Model> = {}
              for (const m of result.models) {
                if (!input.models[m.id]) {
                  models[m.id] = {
                    id: ModelID.make(m.id),
                    providerID: ProviderID.make("gitlab"),
                    name: `Agent Platform (${m.name})`,
                    family: "",
                    api: {
                      id: m.id,
                      url: instanceUrl,
                      npm: "gitlab-ai-provider",
                    },
                    status: "active",
                    headers: {},
                    options: { workflowRef: m.ref },
                    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                    limit: { context: m.context, output: m.output },
                    capabilities: {
                      temperature: false,
                      reasoning: true,
                      attachment: true,
                      toolcall: true,
                      input: {
                        text: true,
                        audio: false,
                        image: true,
                        video: false,
                        pdf: true,
                      },
                      output: {
                        text: true,
                        audio: false,
                        image: false,
                        video: false,
                        pdf: false,
                      },
                      interleaved: false,
                    },
                    release_date: "",
                    variants: {},
                  }
                }
              }

              log.info("gitlab model discovery complete", {
                count: Object.keys(models).length,
                models: Object.keys(models),
              })
              return models
            } catch (e) {
              log.warn("gitlab model discovery failed", { error: e })
              return {}
            }
          },
        }
      }),
      "cloudflare-workers-ai": Effect.fnUntraced(function* (input: Info) {
        // When baseURL is already configured (e.g. corporate config routing through a proxy/gateway),
        // skip the account ID check because the URL is already fully specified.
        if (input.options?.baseURL) return { autoload: false }

        const auth = yield* dep.auth(input.id)
        const env = yield* dep.env()
        const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
        if (!accountId)
          return {
            autoload: false,
            async getModel() {
              throw new Error(
                "CLOUDFLARE_ACCOUNT_ID is missing. Set it with: export CLOUDFLARE_ACCOUNT_ID=<your-account-id>",
              )
            },
          }

        const apiKey = yield* Effect.gen(function* () {
          const envToken = env["CLOUDFLARE_API_KEY"]
          if (envToken) return envToken
          if (auth?.type === "api") return auth.key
          return undefined
        })

        return {
          autoload: !!apiKey,
          options: {
            apiKey,
            headers: {
              "User-Agent": `opencode/${Installation.VERSION} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
            },
          },
          async getModel(sdk: any, modelID: string) {
            return sdk.languageModel(modelID)
          },
          vars(_options) {
            return {
              CLOUDFLARE_ACCOUNT_ID: accountId,
            }
          },
        }
      }),
      "cloudflare-ai-gateway": Effect.fnUntraced(function* (input: Info) {
        // When baseURL is already configured (e.g. corporate config), skip the ID checks.
        if (input.options?.baseURL) return { autoload: false }

        const auth = yield* dep.auth(input.id)
        const env = yield* dep.env()
        const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
        const gateway = env["CLOUDFLARE_GATEWAY_ID"] || (auth?.type === "api" ? auth.metadata?.gatewayId : undefined)

        if (!accountId || !gateway) {
          const missing = [
            !accountId ? "CLOUDFLARE_ACCOUNT_ID" : undefined,
            !gateway ? "CLOUDFLARE_GATEWAY_ID" : undefined,
          ].filter((x): x is string => Boolean(x))
          return {
            autoload: false,
            async getModel() {
              throw new Error(
                `${missing.join(" and ")} missing. Set with: ${missing.map((x) => `export ${x}=<value>`).join(" && ")}`,
              )
            },
          }
        }

        // Get API token from env or auth - required for authenticated gateways
        const apiToken = yield* Effect.gen(function* () {
          const envToken = env["CLOUDFLARE_API_TOKEN"] || env["CF_AIG_TOKEN"]
          if (envToken) return envToken
          if (auth?.type === "api") return auth.key
          return undefined
        })

        if (!apiToken) {
          throw new Error(
            "CLOUDFLARE_API_TOKEN (or CF_AIG_TOKEN) is required for Cloudflare AI Gateway. " +
              "Set it via environment variable or run `opencode auth cloudflare-ai-gateway`.",
          )
        }

        // Use official ai-gateway-provider package (v2.x for AI SDK v5 compatibility)
        const { createAiGateway } = yield* Effect.promise(() => import("ai-gateway-provider"))
        const { createUnified } = yield* Effect.promise(() => import("ai-gateway-provider/providers/unified"))

        const metadata = iife(() => {
          if (input.options?.metadata) return input.options.metadata
          try {
            return JSON.parse(input.options?.headers?.["cf-aig-metadata"])
          } catch {
            return undefined
          }
        })
        const opts = {
          metadata,
          cacheTtl: input.options?.cacheTtl,
          cacheKey: input.options?.cacheKey,
          skipCache: input.options?.skipCache,
          collectLog: input.options?.collectLog,
          headers: {
            "User-Agent": `opencode/${Installation.VERSION} cloudflare-ai-gateway (${os.platform()} ${os.release()}; ${os.arch()})`,
          },
        }

        const aigateway = createAiGateway({
          accountId,
          gateway,
          apiKey: apiToken,
          ...(Object.values(opts).some((v) => v !== undefined) ? { options: opts } : {}),
        })
        const unified = createUnified()

        return {
          autoload: true,
          async getModel(_sdk: any, modelID: string, _options?: Record<string, any>) {
            // Model IDs use Unified API format: provider/model (e.g., "anthropic/claude-sonnet-4-5")
            return aigateway(unified(modelID))
          },
          options: {},
        }
      }),
      cerebras: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "X-Cerebras-3rd-Party-Integration": "opencode",
            },
          },
        }),
      kilo: () =>
        Effect.succeed({
          autoload: false,
          options: {
            headers: {
              "HTTP-Referer": "https://opencode.ai/",
              "X-Title": "opencode",
            },
          },
        }),
    }
  }

  export const Model = z
    .object({
      id: ModelID.zod,
      providerID: ProviderID.zod,
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: ProviderID.zod,
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  export interface Interface {
    readonly list: () => Effect.Effect<Record<ProviderID, Info>>
    readonly getProvider: (providerID: ProviderID) => Effect.Effect<Info>
    readonly getModel: (providerID: ProviderID, modelID: ModelID) => Effect.Effect<Model>
    readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV3>
    readonly closest: (
      providerID: ProviderID,
      query: string[],
    ) => Effect.Effect<{ providerID: ProviderID; modelID: string } | undefined>
    readonly getSmallModel: (providerID: ProviderID) => Effect.Effect<Model | undefined>
    readonly defaultModel: () => Effect.Effect<{ providerID: ProviderID; modelID: ModelID }>
  }

  interface State {
    models: Map<string, LanguageModelV3>
    providers: Record<ProviderID, Info>
    sdk: Map<string, BundledSDK>
    modelLoaders: Record<string, CustomModelLoader>
    varsLoaders: Record<string, CustomVarsLoader>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Provider") {}

  function cost(c: ModelsDev.Model["cost"]): Model["cost"] {
    const result: Model["cost"] = {
      input: c?.input ?? 0,
      output: c?.output ?? 0,
      cache: {
        read: c?.cache_read ?? 0,
        write: c?.cache_write ?? 0,
      },
    }
    if (c?.context_over_200k) {
      result.experimentalOver200K = {
        cache: {
          read: c.context_over_200k.cache_read ?? 0,
          write: c.context_over_200k.cache_write ?? 0,
        },
        input: c.context_over_200k.input,
        output: c.context_over_200k.output,
      }
    }
    return result
  }

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: ModelID.make(model.id),
      providerID: ProviderID.make(provider.id),
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: model.provider?.api ?? provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      headers: {},
      options: {},
      cost: cost(model.cost),
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      variants: {},
    }

    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    const models: Record<string, Model> = {}
    for (const [key, model] of Object.entries(provider.models)) {
      models[key] = fromModelsDevModel(provider, model)
      for (const [mode, opts] of Object.entries(model.experimental?.modes ?? {})) {
        const id = `${model.id}-${mode}`
        const m = fromModelsDevModel(provider, model)
        m.id = ModelID.make(id)
        m.name = `${model.name} ${mode[0].toUpperCase()}${mode.slice(1)}`
        if (opts.cost) m.cost = mergeDeep(m.cost, cost(opts.cost))
        // convert body params to camelCase for ai sdk compatibility
        if (opts.provider?.body)
          m.options = Object.fromEntries(
            Object.entries(opts.provider.body).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]),
          )
        if (opts.provider?.headers) m.headers = opts.provider.headers
        models[id] = m
      }
    }
    return {
      id: ProviderID.make(provider.id),
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models,
    }
  }

  const layer: Layer.Layer<
    Service,
    never,
    Config.Service | Auth.Service | Plugin.Service | AppFileSystem.Service | Env.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const config = yield* Config.Service
      const auth = yield* Auth.Service
      const env = yield* Env.Service
      const plugin = yield* Plugin.Service

      const state = yield* InstanceState.make<State>(() =>
        Effect.gen(function* () {
          using _ = log.time("state")
          const cfg = yield* config.get()
          const modelsDev = yield* Effect.promise(() => ModelsDev.get())
          const database = mapValues(modelsDev, fromModelsDevProvider)

          const providers: Record<ProviderID, Info> = {} as Record<ProviderID, Info>
          const languages = new Map<string, LanguageModelV3>()
          const modelLoaders: {
            [providerID: string]: CustomModelLoader
          } = {}
          const varsLoaders: {
            [providerID: string]: CustomVarsLoader
          } = {}
          const sdk = new Map<string, BundledSDK>()
          const discoveryLoaders: {
            [providerID: string]: CustomDiscoverModels
          } = {}
          const dep = {
            auth: (id: string) => auth.get(id).pipe(Effect.orDie),
            config: () => config.get(),
            env: () => env.all(),
            get: (key: string) => env.get(key),
          }

          log.info("init")

          function mergeProvider(providerID: ProviderID, provider: Partial<Info>) {
            const existing = providers[providerID]
            if (existing) {
              // @ts-expect-error
              providers[providerID] = mergeDeep(existing, provider)
              return
            }
            const match = database[providerID]
            if (!match) return
            // @ts-expect-error
            providers[providerID] = mergeDeep(match, provider)
          }

          // load plugins first so config() hook runs before reading cfg.provider
          const plugins = yield* plugin.list()

          // now read config providers - includes any modifications from plugin config() hook
          const configProviders = Object.entries(cfg.provider ?? {})
          const disabled = new Set(cfg.disabled_providers ?? [])
          const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : null

          function isProviderAllowed(providerID: ProviderID): boolean {
            if (enabled && !enabled.has(providerID)) return false
            if (disabled.has(providerID)) return false
            return true
          }

          // extend database from config
          for (const [providerID, provider] of configProviders) {
            const existing = database[providerID]
            const parsed: Info = {
              id: ProviderID.make(providerID),
              name: provider.name ?? existing?.name ?? providerID,
              env: provider.env ?? existing?.env ?? [],
              options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
              source: "config",
              models: existing?.models ?? {},
            }

            // GPD (PSI) model list is driven by the LiteLLM proxy's
            // access group, not by a hardcoded block in opencode.json.
            // Fetch the user's allowed model ids at provider-resolve
            // time, join against a static metadata table, and splice
            // the result in place of `provider.models`. On network
            // failure this falls back to the full static table (see
            // resolveGpdProviderModels). Synchronously cached for 5min
            // so repeated /provider calls don't hammer the proxy.
            type ConfigModels = NonNullable<typeof provider.models>
            let models: ConfigModels = provider.models ?? ({} as ConfigModels)
            if (providerID === "gpd") {
              const storedAuth = yield* auth.get(ProviderID.make("gpd")).pipe(Effect.orDie)
              const apiKey =
                storedAuth && storedAuth.type === "api" ? storedAuth.key : undefined
              const baseURL = provider.api
              const dynamic = yield* Effect.promise(() =>
                resolveGpdProviderModels(baseURL, apiKey),
              )
              // Fold the dynamic metadata into any per-model overrides
              // the user wrote into config so local tweaks still win.
              const merged: Record<string, any> = {}
              for (const [id, meta] of Object.entries(dynamic)) {
                merged[id] = { ...meta, ...(models as Record<string, any>)[id] }
              }
              models = merged as ConfigModels
            }

            for (const [modelID, model] of Object.entries(models)) {
              const existingModel = parsed.models[model.id ?? modelID]
              const name = iife(() => {
                if (model.name) return model.name
                if (model.id && model.id !== modelID) return modelID
                return existingModel?.name ?? modelID
              })
              const resolvedApiId = model.id ?? existingModel?.api.id ?? modelID
              // GPD GPT-5.x reasoning models must go through `@ai-sdk/openai`
              // (which exposes `.responses()`) instead of the default
              // `@ai-sdk/openai-compatible` (chat-completions only) so the
              // session-summary stream chunks emitted by OpenAI reach the UI.
              // See `gpdUsesResponsesApi` + the `gpd` entry in `custom()`.
              const gpdResponsesNpm =
                providerID === "gpd" && gpdUsesResponsesApi(resolvedApiId) ? "@ai-sdk/openai" : undefined
              const parsedModel: Model = {
                id: ModelID.make(modelID),
                api: {
                  id: resolvedApiId,
                  npm:
                    model.provider?.npm ??
                    gpdResponsesNpm ??
                    provider.npm ??
                    existingModel?.api.npm ??
                    modelsDev[providerID]?.npm ??
                    "@ai-sdk/openai-compatible",
                  url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
                },
                status: model.status ?? existingModel?.status ?? "active",
                name,
                providerID: ProviderID.make(providerID),
                capabilities: {
                  temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
                  reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
                  attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
                  toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
                  input: {
                    text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
                    audio:
                      model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
                    image:
                      model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
                    video:
                      model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
                    pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
                  },
                  output: {
                    text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
                    audio:
                      model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
                    image:
                      model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
                    video:
                      model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
                    pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
                  },
                  interleaved: model.interleaved ?? false,
                },
                cost: {
                  input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
                  output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
                  cache: {
                    read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
                    write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
                  },
                },
                options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
                limit: {
                  context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
                  input: model.limit?.input ?? existingModel?.limit?.input,
                  output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
                },
                headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
                family: model.family ?? existingModel?.family ?? "",
                release_date: model.release_date ?? existingModel?.release_date ?? "",
                variants: {},
              }
              const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
              parsedModel.variants = mapValues(
                pickBy(merged, (v) => !v.disabled),
                (v) => omit(v, ["disabled"]),
              )
              parsed.models[modelID] = parsedModel
            }
            database[providerID] = parsed
          }

          // load env
          const envs = yield* env.all()
          for (const [id, provider] of Object.entries(database)) {
            const providerID = ProviderID.make(id)
            if (disabled.has(providerID)) continue
            const apiKey = provider.env.map((item) => envs[item]).find(Boolean)
            if (!apiKey) continue
            mergeProvider(providerID, {
              source: "env",
              key: provider.env.length === 1 ? apiKey : undefined,
            })
          }

          // load apikeys
          const auths = yield* auth.all().pipe(Effect.orDie)
          for (const [id, provider] of Object.entries(auths)) {
            const providerID = ProviderID.make(id)
            if (disabled.has(providerID)) continue
            if (provider.type === "api") {
              mergeProvider(providerID, {
                source: "api",
                key: provider.key,
              })
            }
          }

          // plugin auth loader - database now has entries for config providers
          for (const plugin of plugins) {
            if (!plugin.auth) continue
            const providerID = ProviderID.make(plugin.auth.provider)
            if (disabled.has(providerID)) continue

            const stored = yield* auth.get(providerID).pipe(Effect.orDie)
            if (!stored) continue
            if (!plugin.auth.loader) continue

            const options = yield* Effect.promise(() =>
              plugin.auth!.loader!(
                () =>
                  Effect.runPromise(auth.get(providerID).pipe(Effect.orDie, Effect.provide(EffectLogger.layer))) as any,
                database[plugin.auth!.provider],
              ),
            )
            const opts = options ?? {}
            const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
            mergeProvider(providerID, patch)
          }

          for (const [id, fn] of Object.entries(custom(dep))) {
            const providerID = ProviderID.make(id)
            if (disabled.has(providerID)) continue
            const data = database[providerID]
            if (!data) {
              log.error("Provider does not exist in model list " + providerID)
              continue
            }
            const result = yield* fn(data)
            if (result && (result.autoload || providers[providerID])) {
              if (result.getModel) modelLoaders[providerID] = result.getModel
              if (result.vars) varsLoaders[providerID] = result.vars
              if (result.discoverModels) discoveryLoaders[providerID] = result.discoverModels
              const opts = result.options ?? {}
              const patch: Partial<Info> = providers[providerID]
                ? { options: opts }
                : { source: "custom", options: opts }
              mergeProvider(providerID, patch)
            }
          }

          // load config - re-apply with updated data
          for (const [id, provider] of configProviders) {
            const providerID = ProviderID.make(id)
            const partial: Partial<Info> = { source: "config" }
            if (provider.env) partial.env = provider.env
            if (provider.name) partial.name = provider.name
            if (provider.options) partial.options = provider.options
            mergeProvider(providerID, partial)
          }

          const gitlab = ProviderID.make("gitlab")
          if (discoveryLoaders[gitlab] && providers[gitlab] && isProviderAllowed(gitlab)) {
            yield* Effect.promise(async () => {
              try {
                const discovered = await discoveryLoaders[gitlab]()
                for (const [modelID, model] of Object.entries(discovered)) {
                  if (!providers[gitlab].models[modelID]) {
                    providers[gitlab].models[modelID] = model
                  }
                }
              } catch (e) {
                log.warn("state discovery error", { id: "gitlab", error: e })
              }
            })
          }

          for (const hook of plugins) {
            const p = hook.provider
            const models = p?.models
            if (!p || !models) continue

            const providerID = ProviderID.make(p.id)
            if (disabled.has(providerID)) continue

            const provider = providers[providerID]
            if (!provider) continue
            const pluginAuth = yield* auth.get(providerID).pipe(Effect.orDie)

            provider.models = yield* Effect.promise(async () => {
              const next = await models(provider, { auth: pluginAuth })
              return Object.fromEntries(
                Object.entries(next).map(([id, model]) => [
                  id,
                  {
                    ...model,
                    id: ModelID.make(id),
                    providerID,
                  },
                ]),
              )
            })
          }

          for (const [id, provider] of Object.entries(providers)) {
            const providerID = ProviderID.make(id)
            if (!isProviderAllowed(providerID)) {
              delete providers[providerID]
              continue
            }

            const configProvider = cfg.provider?.[providerID]

            for (const [modelID, model] of Object.entries(provider.models)) {
              model.api.id = model.api.id ?? model.id ?? modelID
              if (
                modelID === "gpt-5-chat-latest" ||
                (providerID === ProviderID.openrouter && modelID === "openai/gpt-5-chat")
              )
                delete provider.models[modelID]
              if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
              if (model.status === "deprecated") delete provider.models[modelID]
              if (
                (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
                (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
              )
                delete provider.models[modelID]

              model.variants = mapValues(ProviderTransform.variants(model), (v) => v)

              const configVariants = configProvider?.models?.[modelID]?.variants
              if (configVariants && model.variants) {
                const merged = mergeDeep(model.variants, configVariants)
                model.variants = mapValues(
                  pickBy(merged, (v) => !v.disabled),
                  (v) => omit(v, ["disabled"]),
                )
              }
            }

            if (Object.keys(provider.models).length === 0) {
              delete providers[providerID]
              continue
            }

            log.info("found", { providerID })
          }

          return {
            models: languages,
            providers,
            sdk,
            modelLoaders,
            varsLoaders,
          }
        }),
      )

      const list = Effect.fn("Provider.list")(() => InstanceState.use(state, (s) => s.providers))

      async function resolveSDK(model: Model, s: State, envs: Record<string, string | undefined>) {
        try {
          using _ = log.time("getSDK", {
            providerID: model.providerID,
          })
          const provider = s.providers[model.providerID]
          const options = { ...provider.options }

          if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
            delete options.fetch
          }

          if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
            options["includeUsage"] = true
          }

          const baseURL = iife(() => {
            let url =
              typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
            if (!url) return

            const loader = s.varsLoaders[model.providerID]
            if (loader) {
              const vars = loader(options)
              for (const [key, value] of Object.entries(vars)) {
                const field = "${" + key + "}"
                url = url.replaceAll(field, value)
              }
            }

            url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
              const val = envs[String(key)]
              return val ?? item
            })
            return url
          })

          if (baseURL !== undefined) options["baseURL"] = baseURL
          if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
          if (model.headers)
            options["headers"] = {
              ...options["headers"],
              ...model.headers,
            }

          const key = Hash.fast(
            JSON.stringify({
              providerID: model.providerID,
              npm: model.api.npm,
              options,
            }),
          )
          const existing = s.sdk.get(key)
          if (existing) return existing

          const customFetch = options["fetch"]
          const chunkTimeout = options["chunkTimeout"]
          delete options["chunkTimeout"]

          options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
            const fetchFn = customFetch ?? fetch
            const opts = init ?? {}
            const chunkAbortCtl =
              typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
            const signals: AbortSignal[] = []

            if (opts.signal) signals.push(opts.signal)
            if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
            if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
              signals.push(AbortSignal.timeout(options["timeout"]))

            const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
            if (combined) opts.signal = combined

            // Strip openai item id metadata only when the upstream server
            // already holds the previous-turn state (store=true). With
            // store=false the server has no record of prior items, so
            // each function_call / reasoning item in `input` must carry
            // its own `id` for OpenAI to thread multi-turn state — every
            // continuation request 500s with `server_error` otherwise.
            // Confirmed against the gpt-5.5 Responses endpoint: identical
            // body returns 500 with store=false+stripped ids vs 200 with
            // store=true.
            if (
              model.api.npm === "@ai-sdk/openai" &&
              opts.body &&
              typeof opts.body === "string" &&
              isOpenAIResponsesPost(input, opts)
            ) {
              const normalized = normalizeOpenAIResponsesCallIds(opts.body)
              if (normalized?.changed) {
                opts.body = normalized.body
                log.warn("normalized OpenAI Responses call_id values", {
                  providerID: model.providerID,
                  modelID: model.id,
                  apiModelID: model.api.id,
                  path: requestPath(input),
                  callIds: normalized.summary,
                })
              }
            }

            if (model.api.npm === "@ai-sdk/openai" && typeof opts.body === "string" && opts.method === "POST") {
              const body = JSON.parse(opts.body)
              const stripIds = body.store === true
              let mutated = false
              if (stripIds && Array.isArray(body.input)) {
                for (const item of body.input) {
                  if ("id" in item) {
                    delete item.id
                  }
                }
                mutated = true
              }
              // OpenAI's Responses API rejects tool schemas that carry the
              // non-standard `ref` JSON-Schema keyword (deterministic
              // server_error at SSE seq=3 on high/xhigh reasoning_effort).
              // Effect-Schema → zod emits `ref` so hey-api/openapi-ts can
              // generate named SDK types; we have to strip it out of the
              // outgoing request right before it hits the wire.
              if (Array.isArray(body.tools) && stripJsonSchemaRefs(body.tools)) {
                mutated = true
              }
              if (mutated) {
                opts.body = JSON.stringify(body)
              }
            }

            // claude-opus-4-7 needs three coordinated tweaks to surface
            // visible thinking through the GPD UI. Scoped to the GPD
            // chat-completions path; other models untouched.
            //
            // (1) `thinking.display = "summarized"`. opus-4-7's default
            //     silently flipped to `"omitted"` (vs opus-4-6's
            //     `"summarized"`); thinking blocks come back with empty
            //     `thinking` text. The `@ai-sdk/openai-compatible` driver
            //     gates reasoning events on truthy
            //     `delta.reasoning_content`, so empty drops everything
            //     and the UI never renders a reasoning part. Setting
            //     `display: "summarized"` restores Anthropic's plaintext
            //     thinking summaries — see
            //     https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking.
            //
            // (2) Promote xhigh → max. opus-4-7's adaptive scheduler
            //     declines to think on non-computational ("think about X",
            //     "explore Y") prompts at xhigh in practice — verified
            //     live 2026-05-05. Only `max` reliably forces a thinking
            //     commit for those prompts; adaptive still chooses how
            //     many tokens to actually spend, so cheap prompts stay
            //     cheap. Tiers below xhigh stay as-is so users who
            //     intentionally pick low/medium/high keep that behavior.
            //
            // (3) Re-order JSON keys so `thinking` is the LAST top-level
            //     field. LiteLLM v1.83.14's `map_openai_params` iterates
            //     `non_default_params` in dict-insertion order; on the
            //     `reasoning_effort` branch it OVERWRITES
            //     `optional_params["thinking"]` with
            //     `AnthropicThinkingParam(type="adaptive")` — no
            //     `display` key — clobbering our `display:"summarized"`
            //     if `reasoning_effort` is processed after `thinking`.
            //     Forcing `thinking` to the last position means LiteLLM
            //     processes `reasoning_effort` first (sets
            //     `output_config.effort`) and then re-applies our
            //     `thinking` payload intact (display preserved). See
            //     `litellm/llms/anthropic/chat/transformation.py:1088-1108`.
            if (
              model.providerID === "gpd" &&
              model.api.id === "claude-opus-4-7" &&
              model.api.npm === "@ai-sdk/openai-compatible" &&
              opts.body &&
              opts.method === "POST"
            ) {
              const body = JSON.parse(opts.body as string)
              const existing = body.thinking
              const finalThinking =
                !existing || typeof existing !== "object"
                  ? { type: "adaptive", display: "summarized" }
                  : existing.display === undefined
                    ? { ...existing, display: "summarized" }
                    : existing
              if (body.reasoning_effort === "xhigh") {
                body.reasoning_effort = "max"
              }
              if (body.output_config?.effort === "xhigh") {
                body.output_config = { ...body.output_config, effort: "max" }
              }
              // Anthropic's `max_tokens` is a COMBINED thinking + output
              // budget. opus-4-7 at `effort: "max"` thinks with "no
              // constraints on thinking depth" (Anthropic docs, verbatim),
              // so the default 32k combined cap can be entirely consumed
              // by the thinking phase, producing zero visible output.
              // Verified 2026-05-05: dumped body showed `max_tokens:
              // 32000` + `effort: max`, model thought to budget exhaustion
              // mid-derivation and never emitted the answer. Bump the cap
              // to opus-4-7's full 128k output ceiling at max effort so
              // the answer always has room to land. Lower tiers keep the
              // standard cap — they don't blow through 32k as easily.
              if (
                body.reasoning_effort === "max" &&
                typeof body.max_tokens === "number" &&
                body.max_tokens < 128_000
              ) {
                body.max_tokens = 128_000
              }
              // Force `thinking` into the last position so LiteLLM's
              // dict-iteration sees it after `reasoning_effort` and our
              // display value survives the translation. See (3) above.
              delete body.thinking
              body.thinking = finalThinking
              opts.body = JSON.stringify(body)
            }

            if (shouldLogGpdRequestShape(model) && opts.body && opts.method === "POST") {
              log.warn("gpd request shape", {
                providerID: model.providerID,
                modelID: model.id,
                apiModelID: model.api.id,
                path: requestPath(input),
                request: summarizeProviderRequestBody(opts.body),
              })
            }

            const res = await fetchFn(input, {
              ...opts,
              // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
              timeout: false,
            })

            // Capture non-2xx responses for any GPD POST so we can chase
            // intermittent "AI service rejected the request" reports.
            // Researchers who hit a 4xx during dogfood pass us the dump
            // file; we never see the response body otherwise because the
            // AI SDK consumes the stream and the classifier only sees a
            // hash of the message. Fires only on `model.providerID ===
            // "gpd"` POSTs and only when the upstream returned a non-2xx,
            // so happy-path traffic incurs no overhead.
            try {
              if (
                model.providerID === "gpd" &&
                opts.method === "POST" &&
                res.status >= 400 &&
                typeof opts.body === "string"
              ) {
                const cloned = res.clone()
                const ts = Date.now()
                const stem = `/tmp/gpd-error-${ts}-${Math.random().toString(36).slice(2, 8)}`
                const fs = require("fs")
                fs.writeFileSync(`${stem}.req.json`, opts.body)
                cloned
                  .text()
                  .then((text: string) => {
                    try {
                      fs.writeFileSync(`${stem}.res.txt`, text)
                      log.warn("gpd error response captured", {
                        status: res.status,
                        modelID: model.id,
                        apiModelID: model.api.id,
                        path: requestPath(input),
                        reqFile: `${stem}.req.json`,
                        resFile: `${stem}.res.txt`,
                        bodyBytes: text.length,
                      })
                    } catch {}
                  })
                  .catch(() => {})
              }
            } catch {}

            if (!chunkAbortCtl) return res
            return wrapSSE(res, chunkTimeout, chunkAbortCtl)
          }

          const bundledFn = BUNDLED_PROVIDERS[model.api.npm]
          if (bundledFn) {
            log.info("using bundled provider", {
              providerID: model.providerID,
              pkg: model.api.npm,
            })
            const loaded = bundledFn({
              name: model.providerID,
              ...options,
            })
            s.sdk.set(key, loaded)
            return loaded as SDK
          }

          let installedPath: string
          if (!model.api.npm.startsWith("file://")) {
            const item = await Npm.add(model.api.npm)
            if (!item.entrypoint) throw new Error(`Package ${model.api.npm} has no import entrypoint`)
            installedPath = item.entrypoint
          } else {
            log.info("loading local provider", { pkg: model.api.npm })
            installedPath = model.api.npm
          }

          const mod = await import(installedPath)

          const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
          const loaded = fn({
            name: model.providerID,
            ...options,
          })
          s.sdk.set(key, loaded)
          return loaded as SDK
        } catch (e) {
          throw new InitError({ providerID: model.providerID }, { cause: e })
        }
      }

      const getProvider = Effect.fn("Provider.getProvider")((providerID: ProviderID) =>
        InstanceState.use(state, (s) => s.providers[providerID]),
      )

      const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderID, modelID: ModelID) {
        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (!provider) {
          const available = Object.keys(s.providers)
          const matches = fuzzysort.go(providerID, available, { limit: 3, threshold: -10000 })
          throw new ModelNotFoundError({ providerID, modelID, suggestions: matches.map((m) => m.target) })
        }

        const info = provider.models[modelID]
        if (!info) {
          const available = Object.keys(provider.models)
          const matches = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 })
          throw new ModelNotFoundError({ providerID, modelID, suggestions: matches.map((m) => m.target) })
        }
        return info
      })

      const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
        const s = yield* InstanceState.get(state)
        const envs = yield* env.all()
        const key = `${model.providerID}/${model.id}`
        if (s.models.has(key)) return s.models.get(key)!

        return yield* Effect.promise(async () => {
          const provider = s.providers[model.providerID]
          const sdk = await resolveSDK(model, s, envs)

          try {
            const language = s.modelLoaders[model.providerID]
              ? await s.modelLoaders[model.providerID](sdk, model.api.id, {
                  ...provider.options,
                  ...model.options,
                })
              : sdk.languageModel(model.api.id)
            s.models.set(key, language)
            return language
          } catch (e) {
            if (e instanceof NoSuchModelError)
              throw new ModelNotFoundError(
                {
                  modelID: model.id,
                  providerID: model.providerID,
                },
                { cause: e },
              )
            throw e
          }
        })
      })

      const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderID, query: string[]) {
        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (!provider) return undefined
        for (const item of query) {
          for (const modelID of Object.keys(provider.models)) {
            if (modelID.includes(item)) return { providerID, modelID }
          }
        }
        return undefined
      })

      const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (providerID: ProviderID) {
        const cfg = yield* config.get()

        if (cfg.small_model) {
          const parsed = parseModel(cfg.small_model)
          return yield* getModel(parsed.providerID, parsed.modelID)
        }

        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (!provider) return undefined

        let priority = [
          "claude-haiku-4-5",
          "claude-haiku-4.5",
          "3-5-haiku",
          "3.5-haiku",
          "gemini-3-flash",
          "gemini-2.5-flash",
          "gpt-5-nano",
        ]
        if (providerID.startsWith("opencode")) {
          priority = ["gpt-5-nano"]
        }
        if (providerID.startsWith("github-copilot")) {
          priority = ["gpt-5-mini", "claude-haiku-4.5", ...priority]
        }
        for (const item of priority) {
          if (providerID === ProviderID.amazonBedrock) {
            const crossRegionPrefixes = ["global.", "us.", "eu."]
            const candidates = Object.keys(provider.models).filter((m) => m.includes(item))

            const globalMatch = candidates.find((m) => m.startsWith("global."))
            if (globalMatch) return yield* getModel(providerID, ModelID.make(globalMatch))

            const region = provider.options?.region
            if (region) {
              const regionPrefix = region.split("-")[0]
              if (regionPrefix === "us" || regionPrefix === "eu") {
                const regionalMatch = candidates.find((m) => m.startsWith(`${regionPrefix}.`))
                if (regionalMatch) return yield* getModel(providerID, ModelID.make(regionalMatch))
              }
            }

            const unprefixed = candidates.find((m) => !crossRegionPrefixes.some((p) => m.startsWith(p)))
            if (unprefixed) return yield* getModel(providerID, ModelID.make(unprefixed))
          } else {
            for (const model of Object.keys(provider.models)) {
              if (model.includes(item)) return yield* getModel(providerID, ModelID.make(model))
            }
          }
        }

        return undefined
      })

      const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
        const cfg = yield* config.get()
        if (cfg.model) return parseModel(cfg.model)

        const s = yield* InstanceState.get(state)
        const recent = yield* fs.readJson(path.join(Global.Path.state, "model.json")).pipe(
          Effect.map((x): { providerID: ProviderID; modelID: ModelID }[] => {
            if (!isRecord(x) || !Array.isArray(x.recent)) return []
            return x.recent.flatMap((item) => {
              if (!isRecord(item)) return []
              if (typeof item.providerID !== "string") return []
              if (typeof item.modelID !== "string") return []
              return [{ providerID: ProviderID.make(item.providerID), modelID: ModelID.make(item.modelID) }]
            })
          }),
          Effect.catch(() => Effect.succeed([] as { providerID: ProviderID; modelID: ModelID }[])),
        )
        for (const entry of recent) {
          const provider = s.providers[entry.providerID]
          if (!provider) continue
          if (!provider.models[entry.modelID]) continue
          return { providerID: entry.providerID, modelID: entry.modelID }
        }

        const provider = Object.values(s.providers).find(
          (p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id),
        )
        if (!provider) throw new Error("no providers found")
        const [model] = sort(Object.values(provider.models))
        if (!model) throw new Error("no models found")
        return {
          providerID: provider.id,
          modelID: model.id,
        }
      })

      return Service.of({ list, getProvider, getModel, getLanguage, closest, getSmallModel, defaultModel })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Env.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Auth.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
    ),
  )

  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
  export function sort<T extends { id: string }>(models: T[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: ProviderID.make(providerID),
      modelID: ModelID.make(rest.join("/")),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: ProviderID.zod,
    }),
  )

  // Thrown from the stream entry path when a provider that requires a key
  // resolves to no key at request time — i.e. auth.json lost the entry
  // between onboarding and send. Without this, the SDK emits a keyless
  // request and LiteLLM (or the upstream) returns a generic 401 that
  // `classifyError` guesses into "Sign-in failed" — the UX is identical
  // but one network roundtrip is wasted and the log doesn't show why.
  // Mapped to 400 in server/middleware.ts so the frontend classifier
  // routes through the same `error.classified.auth` i18n key.
  export const AuthMissingError = NamedError.create(
    "ProviderAuthMissingError",
    z.object({
      providerID: ProviderID.zod,
    }),
  )
}
