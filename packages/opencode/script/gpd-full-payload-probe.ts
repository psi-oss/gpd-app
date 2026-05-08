import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText, jsonSchema, streamText, tool, type ModelMessage, type Tool as AITool } from "ai"
import z from "zod"
import { makeRuntime } from "../src/effect/run-service"
import { Instance } from "../src/project/instance"
import { GPD_MODEL_METADATA } from "../src/provider/gpd-models"
import { ProviderTransform } from "../src/provider/transform"
import type { Provider } from "../src/provider/provider"
import { ModelID, ProviderID } from "../src/provider/schema"
import { SystemPrompt } from "../src/session/system"
import { ToolRegistry } from "../src/tool/registry"
import { Log } from "../src/util/log"

const DEFAULT_BASE_URL = "https://litellm-production-46bb.up.railway.app/v1"
const DEFAULT_MODELS = ["gpt-5.5", "gpt-5.4"]
const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh"]
const DEFAULT_TOOL_COUNTS = ["0", "1", "10", "20", "40", "full"]
const DEFAULT_STREAMS = ["true", "false"]
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000
const DEFAULT_SYNTHETIC_TOOL_DESCRIPTION_BYTES = 2_400

type StreamMode = "true" | "false"
type ProbeCase = {
  model: string
  effort: string
  stream: boolean
  toolCount: string
}

type CapturedRequest = {
  url: string
  method: string
  headers: Record<string, string>
  bodyText: string
}

type ProbeResult = {
  case: ProbeCase
  status: "captured" | "pass" | "fail"
  durationMs: number
  request: ReturnType<typeof summarizeRequestBody>
  response?: {
    httpStatus?: number
    eventTypes?: Record<string, number>
    outputTextChars?: number
    errorType?: string
    errorCode?: string
    message?: string
    requestId?: string
  }
}

type ToolSize = {
  name: string
  bytes: number
  strict?: boolean
}

type SchemaAudit = {
  objectSchemas: number
  objectsMissingAdditionalPropertiesFalse: number
  optionalPropertySlots: number
  unsupportedKeywordHits: Record<string, number>
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | true> = {}
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue
    const eq = arg.indexOf("=")
    if (eq === -1) {
      args[arg.slice(2)] = true
      continue
    }
    args[arg.slice(2, eq)] = arg.slice(eq + 1)
  }
  return args
}

function csv(value: string | true | undefined, fallback: string[]) {
  if (typeof value !== "string" || value.trim() === "") return fallback
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function flag(args: Record<string, string | true>, name: string) {
  const value = args[name]
  return value === true || value === "1" || value === "true" || value === "yes"
}

function readDotenv(cwd: string) {
  const out: Record<string, string> = {}
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const file = path.join(dir, ".env")
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/)
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eq = trimmed.indexOf("=")
        if (eq <= 0) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        out[key] ??= value
      }
    }
    const next = path.dirname(dir)
    if (next === dir) break
  }
  return out
}

async function bodyToText(body: BodyInit | null | undefined): Promise<string> {
  if (body == null) return ""
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (body instanceof Blob) return await body.text()
  return await new Response(body).text()
}

function redactHeaders(headers: HeadersInit | undefined) {
  const out: Record<string, string> = {}
  const h = new Headers(headers)
  for (const [key, value] of h.entries()) {
    out[key] = key.toLowerCase() === "authorization" ? "<redacted>" : value
  }
  return out
}

function countBy(target: Record<string, number>, key: unknown) {
  const normalized = typeof key === "string" && key.length > 0 ? key : "<missing>"
  target[normalized] = (target[normalized] ?? 0) + 1
}

function jsonBytes(input: unknown) {
  try {
    return new TextEncoder().encode(JSON.stringify(input)).byteLength
  } catch {
    return 0
  }
}

function strictSchemaAudit(schema: unknown) {
  const result = {
    objectSchemas: 0,
    objectsMissingAdditionalPropertiesFalse: 0,
    optionalPropertySlots: 0,
    unsupportedKeywordHits: {} as Record<string, number>,
  }
  const unsupported = new Set(["patternProperties", "if", "then", "else", "not"])
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const obj = node as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      if (unsupported.has(key)) countBy(result.unsupportedKeywordHits, key)
    }
    if (obj.type === "object" || obj.properties) {
      result.objectSchemas++
      if (obj.additionalProperties !== false) result.objectsMissingAdditionalPropertiesFalse++
      const properties = obj.properties
      if (properties && typeof properties === "object" && !Array.isArray(properties)) {
        const required = new Set(Array.isArray(obj.required) ? obj.required.filter((x) => typeof x === "string") : [])
        for (const key of Object.keys(properties)) {
          if (!required.has(key)) result.optionalPropertySlots++
        }
      }
    }
    for (const value of Object.values(obj)) visit(value)
  }
  visit(schema)
  return result
}

function summarizeRequestBody(bodyText: string) {
  let body: any
  try {
    body = JSON.parse(bodyText)
  } catch {
    return {
      parseable: false as const,
      bodyBytes: new TextEncoder().encode(bodyText).byteLength,
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

  const scanPart = (part: any) => {
    if (!part || typeof part !== "object") {
      if (typeof part === "string") textChars += part.length
      return
    }
    countBy(partTypes, part.type)
    if (typeof part.text === "string") textChars += part.text.length
    if (typeof part.input === "string") textChars += part.input.length
    if (typeof part.arguments === "string") textChars += part.arguments.length
    if (part.type === "image" || part.type === "input_image") imageParts++
    if (part.type === "file" || part.type === "input_file") fileParts++
    if (part.type === "tool-call" || part.type === "function_call") toolCalls++
    if (part.type === "tool-result" || part.type === "function_call_output") toolResults++
    if (part.type === "reasoning") {
      reasoningParts++
      if (typeof part.encrypted_content === "string") encryptedReasoningParts++
    }
  }

  for (const item of input) {
    if (!item || typeof item !== "object") {
      if (typeof item === "string") textChars += item.length
      continue
    }
    countBy(roles, item.role)
    countBy(itemTypes, item.type)
    if (typeof item.content === "string") textChars += item.content.length
    if (Array.isArray(item.content)) for (const part of item.content) scanPart(part)
    scanPart(item)
  }

  const tools: any[] = Array.isArray(body.tools) ? body.tools : []
  const toolSizes: ToolSize[] = tools
    .map((entry: any) => ({
      name:
        typeof entry?.name === "string"
          ? entry.name
          : typeof entry?.function?.name === "string"
            ? entry.function.name
            : "",
      bytes: jsonBytes(entry),
      strict:
        typeof entry?.strict === "boolean"
          ? entry.strict
          : typeof entry?.function?.strict === "boolean"
            ? entry.function.strict
            : undefined,
    }))
    .sort((a: ToolSize, b: ToolSize) => b.bytes - a.bytes)
  const schemaAudit = tools.reduce(
    (acc: SchemaAudit, entry: any) => {
      const schema = entry?.parameters ?? entry?.function?.parameters
      const audit = strictSchemaAudit(schema)
      acc.objectSchemas += audit.objectSchemas
      acc.objectsMissingAdditionalPropertiesFalse += audit.objectsMissingAdditionalPropertiesFalse
      acc.optionalPropertySlots += audit.optionalPropertySlots
      for (const [key, count] of Object.entries(audit.unsupportedKeywordHits)) {
        acc.unsupportedKeywordHits[key] = (acc.unsupportedKeywordHits[key] ?? 0) + count
      }
      return acc
    },
    {
      objectSchemas: 0,
      objectsMissingAdditionalPropertiesFalse: 0,
      optionalPropertySlots: 0,
      unsupportedKeywordHits: {} as Record<string, number>,
    },
  )

  const summary = {
    parseable: true as const,
    bodyBytes: new TextEncoder().encode(bodyText).byteLength,
    bodyKeys: Object.keys(body).sort(),
    endpointShape: Array.isArray(body.input) ? "responses" : Array.isArray(body.messages) ? "chat" : "unknown",
    model: body.model,
    stream: body.stream === true,
    instructionsChars: typeof body.instructions === "string" ? body.instructions.length : 0,
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
    largestTools: toolSizes.slice(0, 8),
    strictTrueTools: toolSizes.filter((item: ToolSize) => item.strict === true).length,
    strictFalseTools: toolSizes.filter((item: ToolSize) => item.strict === false).length,
    schemaAudit,
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
    metadataKeys: body.metadata && typeof body.metadata === "object" ? Object.keys(body.metadata).sort() : undefined,
  }

  return {
    ...summary,
    shapeHash: createHash("sha256").update(JSON.stringify(summary)).digest("hex").slice(0, 16),
  }
}

function modelFor(modelID: string): Provider.Model {
  const meta = GPD_MODEL_METADATA[modelID] ?? { name: modelID }
  return {
    id: ModelID.make(modelID),
    providerID: ProviderID.make("gpd"),
    api: {
      id: modelID,
      npm: "@ai-sdk/openai",
      url: DEFAULT_BASE_URL,
    },
    name: meta.name,
    capabilities: {
      temperature: meta.temperature ?? true,
      reasoning: meta.reasoning ?? true,
      attachment: meta.attachment ?? true,
      toolcall: meta.tool_call ?? true,
      input: { text: true, audio: false, image: meta.attachment ?? true, video: false, pdf: meta.attachment ?? true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: meta.cost?.input ?? 0,
      output: meta.cost?.output ?? 0,
      cache: { read: meta.cost?.cache_read ?? 0, write: meta.cost?.cache_write ?? 0 },
    },
    limit: {
      context: meta.limit?.context ?? 1_050_000,
      output: meta.limit?.output ?? 128_000,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: {},
  }
}

function buildSystemMessages(model: Provider.Model, directory: string): ModelMessage[] {
  const env = [
    `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    "  Is directory a git repo: unknown",
    `  Platform: ${process.platform}`,
    `  Today's date: ${new Date().toDateString()}`,
    "</env>",
  ].join("\n")
  return [...SystemPrompt.provider(model), env].map((content) => ({ role: "system" as const, content }))
}

const registryRuntime = makeRuntime(ToolRegistry.Service, ToolRegistry.defaultLayer)

function syntheticTool(index: number, descriptionBytes: number) {
  const id = `probe_synthetic_${String(index).padStart(3, "0")}`
  const description = [
    "Synthetic GPD payload probe tool. This tool should never be called.",
    "It exists only to reproduce large tool-catalog request shapes without touching user systems.",
    "x".repeat(Math.max(0, descriptionBytes)),
  ].join("\n")
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Probe input. Do not call this tool." },
      mode: { type: "string", enum: ["inspect", "summarize", "verify"] },
    },
    required: ["query", "mode"],
  }
  const aiTool = tool({
    description,
    inputSchema: jsonSchema(schema as any),
    execute: async () => ({ title: "probe synthetic stub", output: "probe synthetic stub", metadata: { probe: true } }),
  })
  return {
    id,
    bytes: jsonBytes({
      type: "function",
      name: id,
      description,
      parameters: schema,
    }),
    tool: aiTool,
  }
}

async function loadTools(input: {
  directory: string
  model: Provider.Model
  count: string
  padTools: number
  syntheticToolDescriptionBytes: number
}) {
  const agent = {
    name: "build",
    mode: "primary" as const,
    permission: [],
    options: {},
  }

  const defs = await Instance.provide({
    directory: input.directory,
    fn: () =>
      registryRuntime.runPromise((registry) =>
        registry.tools({
          providerID: ProviderID.make("gpd"),
          modelID: ModelID.make(input.model.api.id),
          agent,
        }),
      ),
  })

  const converted = defs.map((item) => {
    const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
    const aiTool = tool({
      description: item.description,
      inputSchema: jsonSchema(schema as any),
      execute: async () => ({ title: "probe stub", output: "probe stub", metadata: { probe: true } }),
    })
    return {
      id: item.id,
      bytes: jsonBytes({
        type: "function",
        name: item.id,
        description: item.description,
        parameters: schema,
      }),
      tool: aiTool,
    }
  })

  while (converted.length < input.padTools) {
    converted.push(syntheticTool(converted.length + 1, input.syntheticToolDescriptionBytes))
  }

  const ordered = [...converted].sort((a, b) => b.bytes - a.bytes)
  const selected =
    input.count === "full" ? converted : ordered.slice(0, Math.max(0, Number.parseInt(input.count, 10) || 0))
  return Object.fromEntries(selected.map((item) => [item.id, item.tool])) as Record<string, AITool>
}

async function captureRequest(input: {
  baseURL: string
  modelID: string
  effort: string
  stream: boolean
  tools: Record<string, AITool>
  directory: string
  maxOutputTokens: number
}) {
  let captured: CapturedRequest | undefined
  const captureFetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
    const bodyText = await bodyToText(init?.body)
    captured = {
      url: String(url),
      method: init?.method ?? "POST",
      headers: redactHeaders(init?.headers),
      bodyText,
    }

    let body: any
    try {
      body = JSON.parse(bodyText)
    } catch {
      body = {}
    }
    if (body.stream === true) {
      const now = Math.floor(Date.now() / 1000)
      const sse = [
        {
          type: "response.created",
          response: { id: "resp_probe_capture", created_at: now, model: body.model, service_tier: null },
        },
        {
          type: "response.output_text.delta",
          item_id: "item_probe_capture",
          delta: "ok",
          logprobs: null,
        },
        {
          type: "response.completed",
          response: {
            id: "resp_probe_capture",
            incomplete_details: null,
            usage: {
              input_tokens: 1,
              input_tokens_details: null,
              output_tokens: 1,
              output_tokens_details: null,
            },
            service_tier: null,
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("")
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    }

    return new Response(
      JSON.stringify({
        id: "resp_probe_capture",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: body.model,
        output: [
          {
            id: "msg_probe_capture",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 1,
          input_tokens_details: null,
          output_tokens: 1,
          output_tokens_details: null,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  }) as unknown as typeof fetch

  const openai = createOpenAI({
    apiKey: "probe-capture-key",
    baseURL: input.baseURL,
    fetch: captureFetch,
  } as any)
  const languageModel = openai.responses(input.modelID)
  const model = modelFor(input.modelID)
  const messages: ModelMessage[] = [
    ...buildSystemMessages(model, input.directory),
    {
      role: "user",
      content: "Say hi in one short sentence. Do not call tools.",
    },
  ]
  const providerOptions = {
    openai: {
      reasoningEffort: input.effort,
      reasoningSummary: "auto",
      textVerbosity: "low",
      metadata: {
        gpd_probe: "full_payload_matrix",
        gpd_probe_case: `${input.modelID}:${input.effort}:${input.stream ? "stream" : "nonstream"}`,
      },
    },
  }
  const common = {
    model: languageModel,
    messages,
    tools: input.tools,
    activeTools: Object.keys(input.tools),
    providerOptions,
    maxOutputTokens: input.maxOutputTokens,
    maxRetries: 0,
    headers: {
      "User-Agent": "gpd-full-payload-probe/1.0",
      "x-session-affinity": "ses_probe_full_payload",
    },
  } as any

  if (input.stream) {
    const result = streamText(common)
    for await (const _event of result.fullStream) {
      // Drain once so the AI SDK performs request serialization.
    }
  } else {
    await generateText(common)
  }
  if (!captured) throw new Error("AI SDK did not issue a request")
  return captured
}

function headersForLive(captured: CapturedRequest, apiKey: string) {
  const headers = new Headers(captured.headers)
  headers.set("authorization", `Bearer ${apiKey}`)
  headers.set("content-type", "application/json")
  headers.delete("content-length")
  return headers
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function requestIdFromText(input: string) {
  return input.match(/\breq_[a-zA-Z0-9]+/)?.[0]
}

function errorFromPayload(input: any) {
  const err = input?.error?.error ?? input?.error ?? input
  if (!err || typeof err !== "object") return undefined
  return {
    errorType: typeof err.type === "string" ? err.type : undefined,
    errorCode: typeof err.code === "string" ? err.code : undefined,
    message: typeof err.message === "string" ? err.message : undefined,
    requestId: typeof err.message === "string" ? requestIdFromText(err.message) : undefined,
  }
}

async function runLive(input: { captured: CapturedRequest; apiKey: string; timeoutMs: number }) {
  const started = Date.now()
  const res = await fetchWithTimeout(
    input.captured.url,
    {
      method: input.captured.method,
      headers: headersForLive(input.captured, input.apiKey),
      body: input.captured.bodyText,
    },
    input.timeoutMs,
  )
  const text = await res.text()
  const durationMs = Date.now() - started

  if (!res.ok) {
    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    return {
      status: "fail" as const,
      durationMs,
      response: {
        httpStatus: res.status,
        ...(errorFromPayload(parsed) ?? { message: text.slice(0, 500), requestId: requestIdFromText(text) }),
      },
    }
  }

  if (input.captured.bodyText.includes('"stream":true')) {
    const eventTypes: Record<string, number> = {}
    let outputTextChars = 0
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue
      const data = line.slice("data:".length).trim()
      if (!data || data === "[DONE]") continue
      let event: any
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      countBy(eventTypes, event.type)
      if (typeof event.delta === "string") outputTextChars += event.delta.length
      if (event.type === "error") {
        return {
          status: "fail" as const,
          durationMs,
          response: {
            httpStatus: res.status,
            eventTypes,
            outputTextChars,
            ...errorFromPayload(event),
          },
        }
      }
    }
    return { status: "pass" as const, durationMs, response: { httpStatus: res.status, eventTypes, outputTextChars } }
  }

  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      status: "fail" as const,
      durationMs,
      response: { httpStatus: res.status, message: `non-JSON response: ${text.slice(0, 500)}` },
    }
  }
  if (parsed.error) {
    return { status: "fail" as const, durationMs, response: { httpStatus: res.status, ...errorFromPayload(parsed) } }
  }
  const output = Array.isArray(parsed.output) ? parsed.output : []
  const outputTextChars = JSON.stringify(output).length
  return { status: "pass" as const, durationMs, response: { httpStatus: res.status, outputTextChars } }
}

async function main() {
  await Log.init({ print: true, level: "WARN" })

  const args = parseArgs(process.argv.slice(2))
  const dotenv = readDotenv(process.cwd())
  const live = flag(args, "live")
  const baseURL = (typeof args["base-url"] === "string" && args["base-url"]) || dotenv.GPD_LITELLM_BASE || DEFAULT_BASE_URL
  const apiKeyEnv = (typeof args["api-key-env"] === "string" && args["api-key-env"]) || "GPD_API_KEY"
  const apiKey = process.env[apiKeyEnv] || dotenv[apiKeyEnv] || process.env.LITELLM_API_KEY || dotenv.LITELLM_API_KEY
  const directory =
    (typeof args.directory === "string" && args.directory) || process.env.GPD_PROBE_DIRECTORY || process.cwd()
  const models = csv(args.models, DEFAULT_MODELS)
  const efforts = csv(args.efforts, DEFAULT_EFFORTS)
  const toolCounts = csv(args["tool-counts"], DEFAULT_TOOL_COUNTS)
  const streams = csv(args.streams, DEFAULT_STREAMS).map((item) => item.toLowerCase()) as StreamMode[]
  const timeoutMs =
    (typeof args["timeout-ms"] === "string" && Number.parseInt(args["timeout-ms"], 10)) || DEFAULT_TIMEOUT_MS
  const maxOutputTokens =
    (typeof args["max-output-tokens"] === "string" && Number.parseInt(args["max-output-tokens"], 10)) ||
    DEFAULT_MAX_OUTPUT_TOKENS
  const padTools = (typeof args["pad-tools"] === "string" && Number.parseInt(args["pad-tools"], 10)) || 0
  const syntheticToolDescriptionBytes =
    (typeof args["synthetic-tool-description-bytes"] === "string" &&
      Number.parseInt(args["synthetic-tool-description-bytes"], 10)) ||
    DEFAULT_SYNTHETIC_TOOL_DESCRIPTION_BYTES
  const out =
    (typeof args.output === "string" && args.output) ||
    path.join(
      process.cwd(),
      ".artifacts",
      "gpd-full-payload-probe",
      `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    )

  if (live && !apiKey) {
    throw new Error(`--live requires ${apiKeyEnv} in the environment or .env`)
  }

  const results: ProbeResult[] = []
  for (const modelID of models) {
    const model = modelFor(modelID)
    for (const effort of efforts) {
      for (const stream of streams) {
        for (const toolCount of toolCounts) {
          const probeCase: ProbeCase = { model: modelID, effort, stream: stream === "true", toolCount }
          const started = Date.now()
          try {
            const tools = await loadTools({
              directory,
              model,
              count: toolCount,
              padTools,
              syntheticToolDescriptionBytes,
            })
            const captured = await captureRequest({
              baseURL,
              modelID,
              effort,
              stream: stream === "true",
              tools,
              directory,
              maxOutputTokens,
            })
            const request = summarizeRequestBody(captured.bodyText)
            const liveResult = live
              ? await runLive({ captured, apiKey: apiKey!, timeoutMs })
              : { status: "captured" as const, durationMs: Date.now() - started }
            const result: ProbeResult = {
              case: probeCase,
              status: liveResult.status,
              durationMs: liveResult.durationMs,
              request,
              response: "response" in liveResult ? liveResult.response : undefined,
            }
            results.push(result)
            const response = result.response
            console.log(
              [
                result.status.toUpperCase().padEnd(8),
                `model=${modelID}`,
                `effort=${effort}`,
                `stream=${probeCase.stream}`,
                `tools=${request.parseable ? request.toolCount : "?"}`,
                `bytes=${request.bodyBytes}`,
                `hash=${request.parseable ? request.shapeHash : "?"}`,
                response?.errorCode ? `error=${response.errorCode}` : undefined,
                response?.requestId ? `request=${response.requestId}` : undefined,
              ]
                .filter(Boolean)
                .join(" "),
            )
          } catch (err) {
            const result: ProbeResult = {
              case: probeCase,
              status: "fail",
              durationMs: Date.now() - started,
              request: summarizeRequestBody("{}"),
              response: {
                message: err instanceof Error ? err.message : String(err),
              },
            }
            results.push(result)
            console.log(
              [
                "FAIL    ",
                `model=${modelID}`,
                `effort=${effort}`,
                `stream=${probeCase.stream}`,
                `tools=${toolCount}`,
                `error=${result.response?.message}`,
              ].join(" "),
            )
          }
        }
      }
    }
  }

  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(
    out,
    JSON.stringify(
      {
        live,
        baseURL: baseURL.replace(/\/+$/, ""),
        directory,
        maxOutputTokens,
        padTools,
        syntheticToolDescriptionBytes,
        timeoutMs,
        createdAt: new Date().toISOString(),
        platform: `${process.platform}/${process.arch}`,
        results,
        summary: {
          total: results.length,
          pass: results.filter((r) => r.status === "pass").length,
          fail: results.filter((r) => r.status === "fail").length,
          captured: results.filter((r) => r.status === "captured").length,
        },
      },
      null,
      2,
    ),
  )
  await Instance.disposeAll().catch(() => undefined)
  console.log(`wrote ${path.relative(process.cwd(), out) || out}`)
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)
