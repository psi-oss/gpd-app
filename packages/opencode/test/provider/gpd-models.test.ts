import { afterEach, expect, mock, test } from "bun:test"
import { GPD_MODEL_METADATA, gpdReasoningEffortsFor, resolveGpdProviderModels } from "../../src/provider/gpd-models"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

test("gpt-5.5 exposes app-path-safe reasoning tiers", () => {
  expect(gpdReasoningEffortsFor("gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"])
})

test("gpt-5.5-pro metadata stays present and resolves with supported efforts", async () => {
  const meta = GPD_MODEL_METADATA["gpt-5.5-pro"]
  expect(meta).toBeDefined()
  expect(meta.name).toBe("GPT 5.5 Pro")
  expect(meta.reasoning).toBe(true)
  expect(meta.tool_call).toBe(true)
  expect(meta.attachment).toBe(true)
  expect(meta.limit).toEqual({ context: 1_050_000, output: 128_000 })

  expect(gpdReasoningEffortsFor("gpt-5.5-pro")).toEqual(["medium", "high", "xhigh"])

  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-5.5" }, { id: "gpt-5.5-pro" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const resolved = await resolveGpdProviderModels("https://litellm.example/v1", "test-key")
  expect(resolved["gpt-5.5"]).toBeDefined()
  expect(resolved["gpt-5.5-pro"]).toBeDefined()
})
