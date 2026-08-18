import type { Agent, Project, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { Identifier } from "@opencode-ai/util/identifier"

/**
 * Orders sessions, messages, parts, permissions and questions by their IDs.
 * IDs encode creation time modulo 2^48 and wrap every 795 days, so a plain
 * string comparison sorts everything created after a wrap ahead of everything
 * before it — which is how messages sent after 2026-08-14 ended up above a
 * chat's existing history.
 */
export const cmp = Identifier.compare

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

function compactAgent(input: Agent): Agent {
  return Object.freeze({
    name: input.name,
    description: input.description,
    mode: input.mode,
    native: input.native,
    hidden: input.hidden,
    topP: input.topP,
    temperature: input.temperature,
    color: input.color,
    model: input.model ? { ...input.model } : undefined,
    variant: input.variant,
    steps: input.steps,
    permission: Object.freeze([]) as unknown as Agent["permission"],
    options: Object.freeze({}) as Agent["options"],
  }) as Agent
}

export function normalizeAgentList(input: unknown): Agent[] {
  const agents = Array.isArray(input)
    ? input.filter(isAgent).map(compactAgent)
    : isAgent(input)
      ? [compactAgent(input)]
      : input && typeof input === "object"
        ? Object.values(input).filter(isAgent).map(compactAgent)
        : []
  return Object.freeze(agents) as Agent[]
}

export function normalizeProviderList(input: ProviderListResponse): ProviderListResponse {
  return {
    ...input,
    all: input.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated")),
    })),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}
