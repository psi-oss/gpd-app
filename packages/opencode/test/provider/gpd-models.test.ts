import { afterEach, expect, mock, test } from "bun:test"
import {
  GPD_MODEL_METADATA,
  gpdAnthropicAdaptiveProfile,
  gpdReasoningEffortsFor,
  gpdUsesResponsesApi,
  resolveGpdProviderModels,
} from "../../src/provider/gpd-models"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

test("gpt-5.5 exposes app-path-safe reasoning tiers", () => {
  expect(gpdReasoningEffortsFor("gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"])
})

// claude-opus-5 (2026-07-24): full ladder, opus-4-8/fable-5 adaptive
// profile (output_config-only effort against the pinned LiteLLM image),
// and it must not collide with the dot/dash-normalized 4.x opus ids.
test("claude-opus-5 exposes the full ladder and the unmapped-id adaptive profile", () => {
  expect(gpdReasoningEffortsFor("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(GPD_MODEL_METADATA["claude-opus-5"]?.name).toBe("Claude Opus 5")
  expect(GPD_MODEL_METADATA["claude-opus-5"]?.limit).toEqual({ context: 1_000_000, output: 128_000 })
  expect(gpdUsesResponsesApi("claude-opus-5")).toBe(false)
  expect(gpdAnthropicAdaptiveProfile("claude-opus-5")).toEqual({
    summarizedDisplay: true,
    omitsReasoningEffort: true,
    promoteXhighToMax: false,
  })
  // 4.x ids keep their own profiles — "opus-5" must not swallow them.
  expect(gpdAnthropicAdaptiveProfile("claude-opus-4-5")).toBeUndefined()
  expect(gpdAnthropicAdaptiveProfile("claude-opus-4-7")?.promoteXhighToMax).toBe(true)
})

// gpt-5.6 family (sol / terra / luna): first OpenAI family with the full
// low→max ladder, and it routes through the Responses API like 5.4/5.5.
test("gpt-5.6 family exposes the full effort ladder and Responses routing", () => {
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    expect(gpdReasoningEffortsFor(id)).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(gpdUsesResponsesApi(id)).toBe(true)
    expect(GPD_MODEL_METADATA[id]?.reasoning).toBe(true)
    expect(GPD_MODEL_METADATA[id]?.limit).toEqual({ context: 1_050_000, output: 128_000 })
    // /v1/responses rejects the temperature param for 5.6 (probed live
    // 2026-07-22); the capability flag must stay off so agent-configured
    // temperatures are never sent.
    expect(GPD_MODEL_METADATA[id]?.temperature).toBe(false)
  }
  expect(GPD_MODEL_METADATA["gpt-5.6-sol"]?.name).toBe("GPT 5.6 Sol")
  expect(GPD_MODEL_METADATA["gpt-5.6-terra"]?.name).toBe("GPT 5.6 Terra")
  expect(GPD_MODEL_METADATA["gpt-5.6-luna"]?.name).toBe("GPT 5.6 Luna")
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
