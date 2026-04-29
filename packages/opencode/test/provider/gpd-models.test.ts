import { expect, test } from "bun:test"
import { GPD_MODEL_METADATA, gpdReasoningEffortsFor } from "../../src/provider/gpd-models"

test("gpt-5.5-pro has GPD metadata and pro reasoning tiers", () => {
  const meta = GPD_MODEL_METADATA["gpt-5.5-pro"]
  expect(meta).toBeDefined()
  expect(meta.name).toBe("GPT 5.5 Pro")
  expect(meta.reasoning).toBe(true)
  expect(meta.tool_call).toBe(true)
  expect(meta.attachment).toBe(true)
  expect(meta.limit).toEqual({ context: 1_050_000, output: 128_000 })

  expect(gpdReasoningEffortsFor("gpt-5.5-pro")).toEqual(["medium", "high", "xhigh"])
})
