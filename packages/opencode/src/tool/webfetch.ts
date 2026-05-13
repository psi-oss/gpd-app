import z from "zod"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Tool } from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"

// 25 MB cap covers >99% of arxiv ar5iv pages (typical ML/physics papers
// decode to 2-15 MB after ungzip; 25 MB gives 2× headroom). Researchers
// were hitting the prior 5 MB cap on long survey/textbook arxiv pages
// (mukund-rangamani 2026-05-07: arxiv ar5iv pages -> "Response too large
// (exceeds 5MB limit)" -> agent gives up). 25 MB is the sidecar's safe
// transient buffer ceiling — ~50 MB is the practical max for parallel
// fetches before OOM risk on Tauri-bundled processes. The downstream
// `Truncate.Service` already caps every tool's `output` to 50 KB and
// saves the full body to disk, so the LLM never sees the raw fetch —
// the agent grep/reads the saved file. Increases here therefore don't
// affect context-window cost, only sidecar memory.
const MAX_RESPONSE_SIZE = 25 * 1024 * 1024 // 25 MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

const parameters = z.object({
  url: z.string().describe("The URL to fetch content from"),
  format: z
    .enum(["text", "markdown", "html"])
    .default("markdown")
    .describe("The format to return the content in (text, markdown, or html). Defaults to markdown."),
  timeout: z.number().describe("Optional timeout in seconds (max 120)").optional(),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))

          // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
          const response = yield* httpOk.execute(request).pipe(
            Effect.catchIf(
              (err) =>
                err.reason._tag === "StatusCodeError" &&
                err.reason.response.status === 403 &&
                err.reason.response.headers["cf-mitigated"] === "challenge",
              () =>
                httpOk.execute(
                  HttpClientRequest.get(params.url).pipe(
                    HttpClientRequest.setHeaders({ ...headers, "User-Agent": "opencode" }),
                  ),
                ),
            ),
            // Rewrite effect's HttpClient errors so the actual status code
            // surfaces in the tool-error card subtitle (ENG-576). Default
            // effect format is "StatusCode: non 2xx status code (403 GET
            // <url>)" — the subtitle parser splits on ": " and grabs the
            // first segment, which produced the unhelpful literal
            // "StatusCode" subtitle users were seeing. Putting "HTTP <n>"
            // first means the subtitle becomes e.g. "HTTP 403" and the
            // body is the host+path. TransportError gets a "Connection
            // error" surface so DNS / TCP refused / TLS aren't conflated
            // with HTTP responses.
            Effect.mapError((err) => {
              const reason = err.reason
              if (reason._tag === "StatusCodeError") {
                const status = reason.response.status
                const u = new URL(params.url)
                return new Error(`HTTP ${status}: ${u.hostname}${u.pathname}`)
              }
              if (reason._tag === "TransportError") {
                return new Error(`Connection error: couldn't reach ${new URL(params.url).hostname}`)
              }
              return err
            }),
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

          // Check content length. Treat oversize as a soft warning instead of
          // a hard failure — read the body up to MAX_RESPONSE_SIZE, append a
          // truncation marker, and let the agent decide what to do. The
          // downstream Truncate.Service will further trim the LLM-visible
          // output to ~50 KB while saving the full body to disk, so the
          // agent can grep/Read it. Returning an error here was forcing the
          // agent to give up on legitimately useful pages (mukund-rangamani
          // hit this on arxiv ar5iv 2026-05-07).
          const contentLength = response.headers["content-length"]
          const declaredLengthOverCap =
            !!contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE
          const arrayBuffer = yield* response.arrayBuffer
          const oversized = arrayBuffer.byteLength > MAX_RESPONSE_SIZE
          const truncatedBuffer = oversized
            ? arrayBuffer.slice(0, MAX_RESPONSE_SIZE)
            : arrayBuffer

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          const truncationMarker = (() => {
            if (!oversized && !declaredLengthOverCap) return ""
            const capMB = (MAX_RESPONSE_SIZE / 1024 / 1024).toFixed(0)
            const declaredBytes = contentLength
              ? parseInt(contentLength).toLocaleString()
              : "unknown"
            return (
              "\n\n[webfetch: response truncated at " +
              capMB +
              " MB. Original Content-Length: " +
              declaredBytes +
              " bytes. To get more, refetch a more specific URL or a sub-section.]\n"
            )
          })()
          const truncatedMetadata = oversized
            ? {
                truncated: true,
                truncationReason: "size" as const,
                originalBytes: arrayBuffer.byteLength,
                capBytes: MAX_RESPONSE_SIZE,
              }
            : ({} as const)

          // Check if response is an image
          const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"

          if (isImage) {
            const base64Content = Buffer.from(truncatedBuffer).toString("base64")
            return {
              title,
              output: "Image fetched successfully" + truncationMarker,
              metadata: truncatedMetadata,
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(truncatedBuffer)

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                const markdown = convertHTMLToMarkdown(content)
                return {
                  output: markdown + truncationMarker,
                  title,
                  metadata: truncatedMetadata,
                }
              }
              return { output: content + truncationMarker, title, metadata: truncatedMetadata }

            case "text":
              if (contentType.includes("text/html")) {
                const text = yield* Effect.promise(() => extractTextFromHTML(content))
                return { output: text + truncationMarker, title, metadata: truncatedMetadata }
              }
              return { output: content + truncationMarker, title, metadata: truncatedMetadata }

            case "html":
              return { output: content + truncationMarker, title, metadata: truncatedMetadata }

            default:
              return { output: content + truncationMarker, title, metadata: truncatedMetadata }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

async function extractTextFromHTML(html: string) {
  let text = ""
  let skipContent = false

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true
      },
      text() {
        // Skip text content inside these elements
      },
    })
    .on("*", {
      element(element) {
        // Reset skip flag when entering other elements
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skipContent = false
        }
      },
      text(input) {
        if (!skipContent) {
          text += input.text
        }
      },
    })
    .transform(new Response(html))

  await rewriter.text()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
