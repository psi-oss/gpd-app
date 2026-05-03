import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { shouldBootForSavedKeyValidation, validateGpdKey } from "./gpd-key-validate"

const ENDPOINT =
  "https://litellm-production-46bb.up.railway.app/v1/models"

type FetchSpy = {
  calls: { url: string; init: RequestInit | undefined }[]
  install: (handler: (req: Request) => Promise<Response> | Response) => void
  restore: () => void
}

function makeFetchSpy(): FetchSpy {
  const original = globalThis.fetch
  const calls: FetchSpy["calls"] = []
  let handler: ((req: Request) => Promise<Response> | Response) | null = null

  function install(h: (req: Request) => Promise<Response> | Response) {
    handler = h
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      calls.push({ url, init })
      const req = new Request(typeof input === "string" ? input : input, init)
      if (!handler) throw new Error("no handler installed")
      return handler(req)
    }) as typeof fetch
  }

  function restore() {
    globalThis.fetch = original
  }

  return { calls, install, restore }
}

let spy: FetchSpy

beforeEach(() => {
  spy = makeFetchSpy()
})

afterEach(() => {
  spy.restore()
})

describe("validateGpdKey", () => {
  test("returns ok for HTTP 200 with non-empty model list", async () => {
    spy.install(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "gpt-5.4", object: "model" },
              { id: "claude-sonnet-4-6", object: "model" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    )

    const result = await validateGpdKey("sk-real-virtual-key")
    expect(result.ok).toBe(true)
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0].url).toBe(ENDPOINT)
    const auth = (spy.calls[0].init?.headers as Record<string, string>)
      ?.Authorization
    expect(auth).toBe("Bearer sk-real-virtual-key")
  })

  test("returns invalid_key for HTTP 401 with detail message", async () => {
    spy.install(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "Authentication Error, LiteLLM Virtual Key expected. Received=****, expected to start with 'sk-'.",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
    )

    const result = await validateGpdKey("not-a-real-key")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("invalid_key")
    expect(result.httpStatus).toBe(401)
    expect(result.detail).toContain("LiteLLM Virtual Key expected")
  })

  test("returns invalid_key for HTTP 403 (revoked key)", async () => {
    spy.install(
      () =>
        new Response(JSON.stringify({ detail: "Key revoked" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    )

    const result = await validateGpdKey("sk-revoked-key-xxxx")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("invalid_key")
    expect(result.httpStatus).toBe(403)
  })

  test("returns invalid_key when 200 has empty model list", async () => {
    // A key with no model access is technically "authenticated" but useless;
    // surface it as invalid_key so the user gets a clear error rather than
    // an empty model picker after TOS.
    spy.install(
      () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    )

    const result = await validateGpdKey("sk-no-access-xxxx")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("invalid_key")
    expect(result.detail).toContain("no model access")
  })

  test("returns network_error for HTTP 500 (proxy reachable but unhappy)", async () => {
    spy.install(
      () =>
        new Response("internal server error", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
    )

    const result = await validateGpdKey("sk-real-virtual-key")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("network_error")
    expect(result.httpStatus).toBe(500)
  })

  test("returns network_error when fetch throws (offline / DNS / TLS)", async () => {
    spy.install(() => {
      throw new TypeError("Failed to fetch")
    })

    const result = await validateGpdKey("sk-real-virtual-key")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("network_error")
    expect(result.detail).toBe("Failed to fetch")
  })

  test("returns network_error when proxy returns non-JSON 200 body", async () => {
    spy.install(
      () =>
        new Response("<html>captive portal</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    )

    const result = await validateGpdKey("sk-real-virtual-key")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("network_error")
    expect(result.detail).toContain("non-JSON")
  })

  test("times out after timeoutMs and reports as network_error", async () => {
    // Fetch handler resolves only after our timeout fires + a margin, so
    // the abort path is forced. Pin the timeout very low for fast tests.
    spy.install(
      (req) =>
        new Promise<Response>((resolve, reject) => {
          req.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          })
          // Never resolve unless aborted.
        }),
    )

    const result = await validateGpdKey("sk-real-virtual-key", {
      timeoutMs: 50,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("network_error")
    expect(result.detail).toContain("timed out after 50ms")
  })

  test("respects external AbortSignal (caller cancellation)", async () => {
    const ac = new AbortController()
    spy.install(
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"))
          })
        }),
    )

    const promise = validateGpdKey("sk-real-virtual-key", { signal: ac.signal })
    ac.abort()
    const result = await promise
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("network_error")
  })
})

describe("shouldBootForSavedKeyValidation", () => {
  test("boots only for explicit invalid-key validation results", () => {
    expect(shouldBootForSavedKeyValidation(undefined)).toBe(false)
    expect(shouldBootForSavedKeyValidation({ ok: true })).toBe(false)
    expect(
      shouldBootForSavedKeyValidation({
        ok: false,
        reason: "network_error",
        detail: "offline",
      }),
    ).toBe(false)
    expect(
      shouldBootForSavedKeyValidation({
        ok: false,
        reason: "invalid_key",
        httpStatus: 401,
      }),
    ).toBe(true)
  })
})
