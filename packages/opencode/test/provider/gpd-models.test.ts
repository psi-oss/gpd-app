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

// gpt-5.5-pro and gpt-5.4-pro were removed (2026-05-08): the pro variants
// concentrated 87% of spend with 0% prompt-cache hit rate, with no observed
// quality lift over the base tiers in our session traces. If the LiteLLM
// proxy still advertises a "*-pro" id (e.g. it lingers in the access group)
// the picker should NOT surface it — confirm absence here so a future
// metadata regression fails loudly instead of re-leaking pro through.
test("pro variants stay removed from picker metadata", async () => {
  expect(GPD_MODEL_METADATA["gpt-5.5-pro"]).toBeUndefined()
  expect(GPD_MODEL_METADATA["gpt-5.4-pro"]).toBeUndefined()
  expect(gpdReasoningEffortsFor("gpt-5.5-pro")).toBeUndefined()
  expect(gpdReasoningEffortsFor("gpt-5.4-pro")).toBeUndefined()

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
  // Even when the proxy advertises gpt-5.5-pro, it should be absent from the
  // resolved picker entries because it has no metadata anchor.
  expect(resolved["gpt-5.5-pro"]).toBeUndefined()
})
