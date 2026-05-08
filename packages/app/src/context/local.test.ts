import { describe, expect, test } from "bun:test"
import { applyProjectModelSelection, migrateModelSelection, shouldPersistProjectModelSelection } from "./local"

describe("model-selection persistence helpers", () => {
  test("migrates the legacy workspace pick into a project selection", () => {
    const migrated = migrateModelSelection({
      pick: {
        __workspace__: {
          model: { providerID: "gpd", modelID: "gpt-5.5" },
          variant: "xhigh",
        },
        ses_123: {
          model: { providerID: "gpd", modelID: "claude-sonnet-4-6" },
          variant: "low",
        },
      },
    })

    expect(migrated.project).toEqual({
      model: { providerID: "gpd", modelID: "gpt-5.5" },
      variant: "xhigh",
    })
    expect(migrated.session.ses_123).toEqual({
      model: { providerID: "gpd", modelID: "claude-sonnet-4-6" },
      variant: "low",
    })
  })

  test("persists only model and effort changes as project-level selection", () => {
    expect(shouldPersistProjectModelSelection({ agent: "build" })).toBe(false)
    expect(shouldPersistProjectModelSelection({ model: { providerID: "gpd", modelID: "gpt-5.4" } })).toBe(true)
    expect(shouldPersistProjectModelSelection({ variant: "low" })).toBe(true)

    const current = {
      model: { providerID: "gpd", modelID: "gpt-5.5" },
      variant: "medium",
    }
    expect(
      applyProjectModelSelection(current, {
        model: { providerID: "gpd", modelID: "gpt-5.4" },
      }),
    ).toEqual({
      model: { providerID: "gpd", modelID: "gpt-5.4" },
      variant: "medium",
    })
    expect(applyProjectModelSelection(current, { variant: "low" })).toEqual({
      model: { providerID: "gpd", modelID: "gpt-5.5" },
      variant: "low",
    })
  })
})
