import { Component, createMemo, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { usePrompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"

// Categorization of GPD commands. Any command whose name starts with "gpd-"
// but is not listed here ends up in the "More" category.
const CATEGORY_GETTING_STARTED = [
  "gpd-help",
  "gpd-tour",
  "gpd-new-project",
  "gpd-suggest-next",
  "gpd-settings",
  "gpd-set-tier-models",
  "gpd-start",
  "gpd-update",
]

const CATEGORY_RESEARCH_PLANNING = [
  "gpd-plan-phase",
  "gpd-discuss-phase",
  "gpd-research-phase",
  "gpd-add-phase",
  "gpd-insert-phase",
  "gpd-remove-phase",
  "gpd-merge-phases",
  "gpd-revise-phase",
  "gpd-plan-milestone-gaps",
  "gpd-branch-hypothesis",
  "gpd-discover",
  "gpd-map-research",
  "gpd-list-phase-assumptions",
]

const CATEGORY_EXECUTION = [
  "gpd-execute-phase",
  "gpd-quick",
  "gpd-check-todos",
  "gpd-add-todo",
  "gpd-record-insight",
  "gpd-autonomous",
  "gpd-route",
  "gpd-tangent",
  "gpd-reapply-patches",
  "gpd-undo",
]

const CATEGORY_ANALYSIS = [
  "gpd-derive-equation",
  "gpd-dimensional-analysis",
  "gpd-limiting-cases",
  "gpd-sensitivity-analysis",
  "gpd-parameter-sweep",
  "gpd-numerical-convergence",
  "gpd-error-propagation",
  "gpd-compare-experiment",
  "gpd-compare-branches",
  "gpd-compare-results",
  "gpd-explain",
]

const CATEGORY_VERIFICATION = [
  "gpd-verify-work",
  "gpd-validate-conventions",
  "gpd-regression-check",
  "gpd-error-patterns",
  "gpd-health",
  "gpd-debug",
]

const CATEGORY_WRITING = [
  "gpd-write-paper",
  "gpd-arxiv-submission",
  "gpd-peer-review",
  "gpd-respond-to-referees",
  "gpd-export",
  "gpd-slides",
]

const CATEGORY_LITERATURE = [
  "gpd-literature-review",
  "gpd-arxiv:compare_papers",
  "gpd-arxiv:deep-paper-analysis",
  "gpd-arxiv:literature_review",
  "gpd-arxiv:literature-synthesis",
  "gpd-arxiv:research-discovery",
  "gpd-arxiv:research-question",
  "gpd-arxiv:summarize_paper",
]

const CATEGORY_PROJECT_MANAGEMENT = [
  "gpd-new-milestone",
  "gpd-complete-milestone",
  "gpd-audit-milestone",
  "gpd-progress",
  "gpd-show-phase",
  "gpd-pause-work",
  "gpd-resume-work",
  "gpd-sync-state",
  "gpd-compact-state",
  "gpd-graph",
  "gpd-decisions",
  "gpd-export-logs",
  "gpd-record-backtrack",
]

const CATEGORY_KNOWLEDGE = [
  "gpd-map-theory",
  "gpd-set-profile",
  "gpd-digest-knowledge",
  "gpd-review-knowledge",
]

type CategoryKey =
  | "gettingStarted"
  | "researchPlanning"
  | "execution"
  | "analysis"
  | "verification"
  | "writing"
  | "literature"
  | "projectManagement"
  | "knowledge"
  | "more"

const CATEGORY_ORDER: CategoryKey[] = [
  "gettingStarted",
  "researchPlanning",
  "execution",
  "analysis",
  "verification",
  "writing",
  "literature",
  "projectManagement",
  "knowledge",
  "more",
]

const CATEGORY_I18N: Record<CategoryKey, string> = {
  gettingStarted: "gpdSkills.category.gettingStarted",
  researchPlanning: "gpdSkills.category.researchPlanning",
  execution: "gpdSkills.category.execution",
  analysis: "gpdSkills.category.analysis",
  verification: "gpdSkills.category.verification",
  writing: "gpdSkills.category.writing",
  literature: "gpdSkills.category.literature",
  projectManagement: "gpdSkills.category.projectManagement",
  knowledge: "gpdSkills.category.knowledge",
  more: "gpdSkills.category.more",
}

// Per-category color accent for the leading dot.
const CATEGORY_COLOR: Record<CategoryKey, string> = {
  gettingStarted: "#6ea8ff",
  researchPlanning: "#8b7dff",
  execution: "#4ade80",
  analysis: "#f59e0b",
  verification: "#10b981",
  writing: "#ec4899",
  literature: "#a78bfa",
  projectManagement: "#94a3b8",
  knowledge: "#22d3ee",
  more: "#64748b",
}

function membershipMap(): Record<string, CategoryKey> {
  const out: Record<string, CategoryKey> = {}
  const push = (names: string[], key: CategoryKey) => {
    for (const n of names) out[n] = key
  }
  push(CATEGORY_GETTING_STARTED, "gettingStarted")
  push(CATEGORY_RESEARCH_PLANNING, "researchPlanning")
  push(CATEGORY_EXECUTION, "execution")
  push(CATEGORY_ANALYSIS, "analysis")
  push(CATEGORY_VERIFICATION, "verification")
  push(CATEGORY_WRITING, "writing")
  push(CATEGORY_LITERATURE, "literature")
  push(CATEGORY_PROJECT_MANAGEMENT, "projectManagement")
  push(CATEGORY_KNOWLEDGE, "knowledge")
  return out
}

const MEMBERSHIP = membershipMap()

interface GpdCommandItem {
  name: string
  description?: string
  category: CategoryKey
}

interface Props {
  commands: readonly {
    name: string
    description?: string
  }[]
}

export const DialogGpdSkills: Component<Props> = (props) => {
  const prompt = usePrompt()
  const dialog = useDialog()
  const language = useLanguage()

  const items = createMemo<GpdCommandItem[]>(() => {
    return props.commands
      .filter((cmd) => cmd.name.startsWith("gpd-"))
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        category: MEMBERSHIP[cmd.name] ?? "more",
      }))
  })

  const handleSelect = (item: GpdCommandItem | undefined) => {
    if (!item) return
    const text = `/${item.name} `
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    dialog.close()
  }

  return (
    <Dialog
      title={language.t("gpdSkills.dialog.title")}
      description={language.t("gpdSkills.dialog.description")}
      size="large"
    >
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{
          placeholder: language.t("gpdSkills.search.placeholder"),
          autofocus: true,
        }}
        emptyMessage={language.t("gpdSkills.empty")}
        key={(x) => x.name}
        items={items}
        filterKeys={["name", "description"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        groupBy={(x) => x.category}
        sortGroupsBy={(a, b) =>
          CATEGORY_ORDER.indexOf(a.category as CategoryKey) -
          CATEGORY_ORDER.indexOf(b.category as CategoryKey)
        }
        groupHeader={(group) => {
          const key = group.category as CategoryKey
          const labelKey = CATEGORY_I18N[key]
          return (
            <div class="flex items-center gap-2">
              <span
                aria-hidden="true"
                class="inline-block size-2 rounded-full shrink-0"
                style={{ background: CATEGORY_COLOR[key] }}
              />
              <span>{language.t(labelKey as Parameters<typeof language.t>[0])}</span>
              <span class="text-11-regular text-text-weaker">{group.items.length}</span>
            </div>
          )
        }}
        onSelect={handleSelect}
      >
        {(item) => (
          <div class="w-full flex items-center gap-x-3 min-w-0">
            <span
              aria-hidden="true"
              class="inline-block size-2 rounded-full shrink-0"
              style={{ background: CATEGORY_COLOR[item.category] }}
            />
            <span class="text-13-medium text-text-strong whitespace-nowrap">/{item.name}</span>
            <Show when={item.description}>
              <span class="text-13-regular text-text-weak truncate min-w-0">{item.description}</span>
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
